import type { KeepaliveConfig } from "./config"
import { readControl } from "./control"
import { isEligibleModel } from "./model"
import type { KeepaliveStore, SessionKeepalive } from "./state"
import type { Logger } from "./logger"

const TICK_MS = 15_000
const JITTER_MS = 15_000
const CONTROL_POLL_MS = 1_000
const STATUS_POLL_MS = 2_000

/**
 * The keepalive engine.
 *
 * Lifecycle per session:
 *   1. A real turn finishes -> `session.idle` -> arm a warm window and schedule pings.
 *   2. On each tick past `nextPingAt` (and within the window) -> `firePing`.
 *   3. `firePing` sends a `~` prompt through opencode (exact cached prefix, reuses
 *      the session's model/auth), reads `usage` to confirm a cache hit, then optionally
 *      reverts the `~`/`~` turn so it does not pollute the real conversation.
 *   4. A new real user turn or the window closing stops warming.
 */
export class KeepaliveEngine {
    private timer: ReturnType<typeof setInterval> | undefined
    private controlTimer: ReturnType<typeof setInterval> | undefined
    private statusTimer: ReturnType<typeof setInterval> | undefined
    private controlUpdatedAt = 0
    private reconcilingStatus = false
    private enabled: boolean

    constructor(
        private readonly client: any,
        private readonly config: KeepaliveConfig,
        private readonly store: KeepaliveStore,
        private readonly logger: Logger,
    ) {
        const control = readControl()
        this.enabled = control?.enabled ?? config.enabled
        this.controlUpdatedAt = control?.updatedAt ?? 0
        this.store.setEnabled(this.enabled)
    }

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.tick(), TICK_MS)
        this.controlTimer = setInterval(() => this.pollControl(), CONTROL_POLL_MS)
        this.statusTimer = setInterval(() => void this.reconcileStatus(), STATUS_POLL_MS)
        this.store.persist()
        this.logger.info(
            `started (${this.enabled ? "enabled" : "disabled"}, ` +
                `interval=${Math.round(this.config.intervalMs / 1000)}s, ` +
                `window=${Math.round(this.config.windowMs / 60_000)}m)`,
        )
    }

    stop(): void {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = undefined
        if (this.controlTimer) clearInterval(this.controlTimer)
        this.controlTimer = undefined
        if (this.statusTimer) clearInterval(this.statusTimer)
        this.statusTimer = undefined
    }

    /** True while a ping is in flight — used to block tool calls during a ping. */
    isWarming(sessionID: string): boolean {
        return !!this.store.get(sessionID)?.warming
    }

    async onEvent(event: any): Promise<void> {
        const type: string | undefined = event?.type
        if (!type) return

        if (type === "session.deleted") {
            const id = event.properties?.sessionID ?? event.properties?.info?.id
            if (id) {
                this.store.remove(id)
                this.store.persist()
            }
            return
        }

        if (type === "message.updated") {
            const info = event.properties?.info
            const sessionID: string | undefined = info?.sessionID ?? event.properties?.sessionID
            if (!sessionID) return
            const session = this.store.get(sessionID)
            // Ignore everything that happens inside our own ping turn.
            if (session?.warming) return
            const eventAt = info?.time?.completed ?? info?.time?.created
            // Events are asynchronous: a completed ping may still emit message updates
            // after `warming` clears. Their timestamps predate the recorded ping.
            if (session?.lastPingAt && typeof eventAt === "number" && eventAt <= session.lastPingAt)
                return

            if (info?.role === "user") {
                const s = this.store.ensure(sessionID)
                s.busy = true
                s.active = false
                this.store.persist()
                return
            }

            if (info?.role === "assistant" && typeof info?.time?.completed === "number") {
                const s = this.store.ensure(sessionID)
                s.lastResponseAt = info.time.completed
                this.store.persist()
            }
            return
        }

        if (type === "session.status") {
            const sessionID: string | undefined = event.properties?.sessionID
            const status: string | undefined = event.properties?.status?.type
            if (!sessionID || !status) return

            // The ping's own status transitions must not restart its idle window.
            if (this.store.get(sessionID)?.warming) return

            if (status === "idle") {
                await this.armWindow(sessionID)
                return
            }

            const s = this.store.ensure(sessionID)
            s.busy = true
            s.active = false
            this.store.persist()
            return
        }

        // Compatibility fallback for opencode versions predating session.status.
        if (type === "session.idle") {
            const sessionID: string | undefined = event.properties?.sessionID
            if (!sessionID) return
            if (this.store.get(sessionID)?.warming) return // idle from our own ping
            await this.armWindow(sessionID)
        }
    }

    private async armWindow(sessionID: string): Promise<void> {
        const s = this.store.ensure(sessionID)
        // Duplicate idle events (including late events from a ping) must not reset the
        // current idle stretch or extend its warm window.
        if (s.active && !s.busy) return
        s.busy = false
        await this.resolveSession(s)

        // A new turn may have started while session metadata was being resolved.
        if (s.busy || !this.enabled || !s.eligible) {
            s.active = false
            this.store.persist()
            return
        }

        const now = Date.now()
        if (!s.lastResponseAt) s.lastResponseAt = now
        s.idleSince = now
        s.windowEndsAt = now + this.config.windowMs
        s.nextPingAt = now + this.config.intervalMs
        s.pingsSent = 0
        s.lastPing = undefined
        s.active = true
        this.store.persist()
        this.logger.dbg(`armed ${short(sessionID)} model=${s.modelLabel}`)
    }

    private async tick(): Promise<void> {
        if (!this.enabled) return
        const now = Date.now()
        for (const s of this.store.all()) {
            if (!s.eligible || !s.active || s.busy || s.warming) continue

            if (now >= s.windowEndsAt) {
                s.active = false
                this.store.persist()
                this.logger.dbg(
                    `window closed ${short(s.sessionID)} after ${s.pingsSent} ping(s) — cache may cool`,
                )
                continue
            }

            if (now >= s.nextPingAt) void this.firePing(s.sessionID)
        }
    }

    private async firePing(sessionID: string): Promise<void> {
        const s = this.store.get(sessionID)
        if (!s || s.warming || s.busy) return

        s.warming = true
        this.store.persist()
        const startAt = Date.now()

        try {
            const res = await this.client.session.prompt({
                path: { id: sessionID },
                body: { parts: [{ type: "text", text: this.config.pingToken }] },
            })

            const info = res?.data?.info ?? res?.info
            const cache = info?.tokens?.cache ?? {}
            const record = {
                at: Date.now(),
                hit: Number(cache.read ?? 0) > 0,
                input: Number(info?.tokens?.input ?? 0),
                cacheRead: Number(cache.read ?? 0),
                cacheWrite: Number(cache.write ?? 0),
                output: Number(info?.tokens?.output ?? 0),
            }
            s.lastPing = record
            s.lastPingAt = record.at
            s.pingsSent += 1
            this.logger.info(
                `ping ${short(sessionID)} ${record.hit ? "HIT" : "MISS"} ` +
                    `in=${record.input} read=${record.cacheRead} write=${record.cacheWrite} out=${record.output}`,
            )

            if (this.config.revertPing) await this.revertPing(sessionID, startAt)
        } catch (err) {
            this.logger.warn(`ping ${short(sessionID)} failed`, errText(err))
        } finally {
            s.warming = false
            s.nextPingAt = Date.now() + jitter(this.config.intervalMs)
            this.store.persist()
        }
    }

    /** Remove the `~` user + `~` assistant turn so it never enters real context. */
    private async revertPing(sessionID: string, startAt: number): Promise<void> {
        let messages: any[]
        try {
            const res = await this.client.session.messages({ path: { id: sessionID } })
            messages = res?.data ?? res ?? []
        } catch (err) {
            this.logger.warn(`ping ${short(sessionID)} revert: list failed`, errText(err))
            return
        }

        let target: string | undefined
        for (const m of messages) {
            if (m?.info?.role !== "user") continue
            if (Number(m.info?.time?.created ?? 0) < startAt - 2_000) continue
            const text = (m.parts ?? [])
                .filter((p: any) => p?.type === "text")
                .map((p: any) => p?.text ?? "")
                .join("")
                .trim()
            if (text === this.config.pingToken) target = m.info.id
        }

        if (!target) {
            this.logger.dbg(`ping ${short(sessionID)} revert: ping message not found`)
            return
        }

        try {
            await this.client.session.revert({
                path: { id: sessionID },
                body: { messageID: target },
            })
        } catch (err) {
            // BusyError (a real turn started) or similar — leave the ping visible.
            this.logger.warn(`ping ${short(sessionID)} revert failed`, errText(err))
        }
    }

    private async resolveSession(s: SessionKeepalive): Promise<void> {
        try {
            const res = await this.client.session.get({ path: { id: s.sessionID } })
            const info = res?.data ?? res
            if (info?.parentID && !this.config.includeChildSessions) {
                s.eligible = false
                s.modelLabel = info?.model?.id ?? "child"
                return
            }
            s.modelLabel = info?.model?.id ?? "unknown"
            s.eligible = isEligibleModel(this.config, info?.model?.providerID, info?.model?.id)
        } catch (err) {
            s.eligible = false
            this.logger.dbg(`resolve ${short(s.sessionID)} failed`, errText(err))
        }
    }

    private pollControl(): void {
        const control = readControl()
        if (!control || control.updatedAt <= this.controlUpdatedAt) return
        this.controlUpdatedAt = control.updatedAt
        if (control.enabled === this.enabled) return

        this.enabled = control.enabled
        this.store.setEnabled(control.enabled)
        const now = Date.now()
        for (const session of this.store.all()) {
            if (!control.enabled) {
                session.active = false
                continue
            }
            if (!session.eligible || session.busy || session.warming) continue
            if (!session.lastResponseAt) session.lastResponseAt = now
            session.idleSince = now
            session.windowEndsAt = now + this.config.windowMs
            session.nextPingAt = now + this.config.intervalMs
            session.pingsSent = 0
            session.lastPing = undefined
            session.active = true
        }
        this.store.persist()
        this.logger.info(`runtime ${control.enabled ? "enabled" : "disabled"}`)
    }

    /** Recover when a session.status idle event is missed by reconciling with the API. */
    private async reconcileStatus(): Promise<void> {
        if (this.reconcilingStatus) return
        const busy = this.store.all().filter((session) => session.busy && !session.warming)
        if (busy.length === 0) return

        this.reconcilingStatus = true
        try {
            const res = await this.client.session.status()
            const statuses = res?.data ?? res ?? {}
            for (const session of busy) {
                const status = statuses?.[session.sessionID]?.type ?? "idle"
                if (status === "idle") await this.armWindow(session.sessionID)
            }
        } catch (err) {
            this.logger.dbg("status reconciliation failed", errText(err))
        } finally {
            this.reconcilingStatus = false
        }
    }
}

function short(sessionID: string): string {
    return sessionID.slice(-6)
}

function jitter(base: number): number {
    return Math.max(1_000, base + Math.floor((Math.random() * 2 - 1) * JITTER_MS))
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
