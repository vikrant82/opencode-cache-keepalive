import type { KeepaliveConfig } from "./config"
import { readControl } from "./control"
import { isEligibleModel } from "./model"
import type { InflightPing, KeepaliveStore, PingRequest, SessionKeepalive } from "./state"
import type { Logger } from "./logger"

const TICK_MS = 15_000
const JITTER_MS = 15_000
const CONTROL_POLL_MS = 1_000
const STATUS_POLL_MS = 2_000
const PING_STATUS_GRACE_MS = 5_000
/**
 * A cache last touched more than this many intervals ago is presumed cold. Pinging
 * it would pay a full cache write for a session nobody is using, so the window
 * stays closed until the next real turn re-arms it.
 */
const COLD_AFTER_INTERVALS = 2
/** Recent messages scanned for ping reverts and request-setting recovery. */
const MESSAGE_LOOKUP_LIMIT = 50

/**
 * The keepalive engine.
 *
 * Lifecycle per session:
 *   1. A real turn finishes -> `session.status` idle -> arm a warm window anchored on
 *      the real response and schedule pings.
 *   2. On each tick past `nextPingAt` (and within the window) -> `firePing`.
 *   3. `firePing` confirms with the server that the session is idle, sends a `~`
 *      prompt with the last real turn's agent/model/variant (exact cached prefix),
 *      reads `usage` to confirm a cache hit, then optionally reverts the `~`/`~` turn.
 *   4. A new real user turn, the window closing, or the cache presumed cold stops warming.
 *
 * Threading: all state is mutated on the single plugin event loop. opencode invokes
 * the `event` hook without awaiting it, so async handlers interleave; per-session
 * `arming` / `warming` flags serialize the async sections.
 *
 * Errors: network/API failures are logged and never thrown to opencode.
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
        private readonly directory: string,
    ) {
        const control = readControl(directory)
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

    /**
     * True while a ping turn owns the session, so tool calls must be blocked. Becomes
     * false as soon as a real user message joins the in-flight ping run: the rest of
     * that run is real work and needs its tools.
     */
    shouldBlockTools(sessionID: string): boolean {
        const s = this.store.get(sessionID)
        return !!s?.warming && !s.ping?.interrupted
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

        if (type === "message.part.updated") {
            const part = event.properties?.part
            const sessionID: string | undefined = part?.sessionID ?? event.properties?.sessionID
            if (!sessionID) return
            const session = this.store.get(sessionID)
            if (session?.warming) this.notePingRunPart(session, part)
            return
        }

        if (type === "message.updated") {
            const info = event.properties?.info
            const sessionID: string | undefined = info?.sessionID ?? event.properties?.sessionID
            if (!sessionID) return
            const session = this.store.get(sessionID)
            // Everything inside our own ping turn is ignored — except a real user
            // message, which opencode joins to the running ping loop.
            if (session?.warming) {
                if (info?.role === "user") this.notePingRunUser(session, info)
                return
            }
            const eventAt = info?.time?.completed ?? info?.time?.created
            // Events are asynchronous: a completed ping may still emit message updates
            // after `warming` clears. Their timestamps predate the recorded ping.
            if (session?.lastPingAt && typeof eventAt === "number" && eventAt <= session.lastPingAt)
                return

            if (info?.role === "user") {
                const s = this.store.ensure(sessionID)
                // opencode re-emits older user messages (e.g. summary updates after a
                // turn); only a newly created message starts a turn.
                if (!isNewUserMessage(s, info)) return
                noteUserMessage(s, info)
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

            // The ping and its optional revert emit status transitions after their
            // requests resolve. Ignore them briefly so they cannot re-arm/reset the
            // active warm window. Real user-message events still stop warming now.
            const current = this.store.get(sessionID)
            if (
                current?.warming ||
                (status !== "idle" &&
                    current?.lastPingAt &&
                    Date.now() - current.lastPingAt < PING_STATUS_GRACE_MS)
            )
                return

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

    /**
     * Track a new user message observed while a ping is in flight. Event order alone
     * cannot tell the ping's own message from a real prompt racing it, so messages are
     * held until their text part arrives (see `notePingRunPart`). Any message seen
     * before the ping is sent, or a second new message, is necessarily a real turn.
     */
    private notePingRunUser(s: SessionKeepalive, info: any): void {
        const ping = s.ping
        if (!ping || typeof info?.id !== "string") return
        const created = info?.time?.created
        if (typeof created === "number" && created < ping.startedAt) return // re-emitted old message
        if (info.id === ping.messageID || ping.pending.has(info.id)) return
        if (!ping.sent || ping.messageID) {
            this.interruptPing(s, info)
            return
        }
        ping.pending.set(info.id, info)
        if (ping.pending.size > 1) this.interruptPing(s)
    }

    /**
     * Classify a pending user message by its first text part: the ping token marks
     * the ping's own message; any other text is a real turn joining the ping run.
     * opencode publishes a user message's parts right after the message itself, before
     * the run reaches any tool call.
     */
    private notePingRunPart(s: SessionKeepalive, part: any): void {
        const ping = s.ping
        if (!ping || part?.type !== "text" || part?.synthetic) return
        const id = part?.messageID
        if (typeof id !== "string" || !ping.pending.has(id)) return
        const info = ping.pending.get(id)
        ping.pending.delete(id)
        if (!ping.messageID && String(part.text ?? "").trim() === this.config.pingToken) {
            ping.messageID = id
            return
        }
        this.interruptPing(s, info)
    }

    /** A real turn joined the in-flight ping: unblock tools and treat the session as busy. */
    private interruptPing(s: SessionKeepalive, info?: unknown): void {
        const ping = s.ping
        if (!ping) return
        if (!ping.interrupted) this.logger.dbg(`real turn joined ping ${short(s.sessionID)}`)
        ping.interrupted = true
        if (info) noteUserMessage(s, info)
        s.busy = true
        s.active = false
        this.store.persist()
    }

    private async armWindow(sessionID: string): Promise<void> {
        const s = this.store.ensure(sessionID)
        // Duplicate idle events (including late events from a ping) must not reset the
        // current idle stretch or extend its warm window.
        if (s.active && !s.busy) return
        // Serialize: only one armWindow may resolve metadata at a time per session.
        // This prevents the session.status + session.idle double-event race from
        // producing two concurrent resolveSession calls that can clobber each other.
        if (s.arming) return
        s.arming = true
        try {
            s.busy = false
            await this.resolveSession(s)

            // A new turn may have started while session metadata was being resolved.
            if (s.busy || !this.enabled || !s.eligible) {
                s.active = false
                this.store.persist()
                return
            }

            // Only a recent real response leaves a cache worth warming. Idle events can
            // also fire for sessions untouched for hours (restarts, re-emitted messages).
            const now = Date.now()
            if (!s.lastResponseAt || !this.cacheMayBeWarm(s, now)) {
                s.active = false
                this.store.persist()
                this.logger.dbg(`not armed ${short(sessionID)} — no recent real response`)
                return
            }

            this.openWindow(s, now)
            this.store.persist()
            this.logger.dbg(`armed ${short(sessionID)} model=${s.modelLabel}`)
        } finally {
            s.arming = false
        }
    }

    /** Start a warm window anchored on the last real response and the last cache touch. */
    private openWindow(s: SessionKeepalive, now: number): void {
        s.idleSince = now
        s.windowEndsAt = s.lastResponseAt + this.config.windowMs
        s.nextPingAt = Math.max(now, lastCacheTouch(s) + this.config.intervalMs)
        s.pingsSent = 0
        s.lastPing = undefined
        s.active = true
    }

    /** False once the cache has gone too long without a request to still be trusted warm. */
    private cacheMayBeWarm(s: SessionKeepalive, now: number): boolean {
        const touch = lastCacheTouch(s)
        return touch > 0 && now - touch <= COLD_AFTER_INTERVALS * this.config.intervalMs
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

            if (now < s.nextPingAt) continue

            // Far overdue (host sleep, stalled event loop): the cache is presumed cold.
            // Stop rather than pay a cold write or fire a catch-up burst.
            if (!this.cacheMayBeWarm(s, now)) {
                s.active = false
                this.store.persist()
                this.logger.dbg(
                    `window closed ${short(s.sessionID)} — ping overdue, cache presumed cold`,
                )
                continue
            }

            void this.firePing(s.sessionID)
        }
    }

    private async firePing(sessionID: string): Promise<void> {
        const s = this.store.get(sessionID)
        if (!s || s.warming || s.busy || !s.active) return

        const ping: InflightPing = {
            startedAt: Date.now(),
            sent: false,
            pending: new Map(),
            interrupted: false,
        }
        s.warming = true
        s.ping = ping
        this.store.persist()

        try {
            // opencode joins a prompt to a running turn instead of rejecting it, so a
            // missed busy signal would inject the ping into real work. Ask the server.
            if (!(await this.isIdleOnServer(sessionID))) {
                s.busy = true
                s.active = false
                this.logger.dbg(`ping ${short(sessionID)} skipped — session busy`)
                return
            }

            const request = s.request ?? (await this.lookupRequest(s))
            if (!request) {
                s.active = false
                this.logger.dbg(`ping ${short(sessionID)} skipped — last real request unknown`)
                return
            }

            // A real turn may have started (or keepalive been disabled) while checking.
            if (ping.interrupted || s.busy || !s.active || !this.enabled) return

            ping.sent = true
            // Count every request attempt. A transport/provider failure still consumed a
            // scheduled ping slot and must remain visible in the footer.
            s.pingsSent += 1
            this.store.persist()

            const res = await this.client.session.prompt({
                path: { id: sessionID },
                body: {
                    parts: [{ type: "text", text: this.config.pingToken }],
                    ...(request.agent ? { agent: request.agent } : {}),
                    model: { providerID: request.providerID, modelID: request.modelID },
                    ...(request.variant ? { variant: request.variant } : {}),
                },
            })
            const info = res?.data?.info ?? res?.info

            if (ping.interrupted) {
                // A real turn ran inside this request: its reply is real work. Keep it,
                // do not score it as a ping, and re-arm from its completion.
                const completed = info?.time?.completed
                if (typeof completed === "number") s.lastResponseAt = completed
                this.logger.dbg(
                    `ping ${short(sessionID)} absorbed a real turn — kept, not reverted`,
                )
                return
            }

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
            this.logger.dbg(
                `ping ${short(sessionID)} ${record.hit ? "HIT" : "MISS"} ` +
                    `in=${record.input} read=${record.cacheRead} write=${record.cacheWrite} out=${record.output}`,
            )

            if (this.config.revertPing) await this.revertPing(sessionID, ping)
        } catch (err) {
            this.logger.warn(`ping ${short(sessionID)} failed`, errText(err))
        } finally {
            s.warming = false
            s.ping = undefined
            const now = Date.now()
            if (ping.sent) {
                s.lastPingAt = now
                // Schedule relative to the intended time so ping duration doesn't
                // compound drift, but never into the past: that would fire catch-up
                // pings on consecutive ticks.
                const next = s.nextPingAt + jitter(this.config.intervalMs)
                s.nextPingAt = next > now ? next : now + jitter(this.config.intervalMs)
            }
            this.store.persist()
            if (ping.sent && ping.interrupted) {
                // The joined real turn has finished with this request; start its window.
                s.busy = false
                s.active = false
                void this.armWindow(sessionID)
            }
        }
    }

    /** True only when the server positively reports the session idle. */
    private async isIdleOnServer(sessionID: string): Promise<boolean> {
        try {
            const res = await this.client.session.status()
            const statuses = res?.data ?? res ?? {}
            return (statuses?.[sessionID]?.type ?? "idle") === "idle"
        } catch (err) {
            this.logger.dbg(`status check ${short(sessionID)} failed`, errText(err))
            return false
        }
    }

    /** Recover the last real turn's request settings when no user event was observed. */
    private async lookupRequest(s: SessionKeepalive): Promise<PingRequest | undefined> {
        const messages = await this.recentMessages(s.sessionID)
        if (!messages) return undefined
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (m?.info?.role !== "user" || this.isPingMessage(m)) continue
            const request = requestFrom(m.info)
            if (request) {
                s.request = request
                return request
            }
        }
        return undefined
    }

    private async recentMessages(sessionID: string): Promise<any[] | undefined> {
        try {
            const res = await this.client.session.messages({
                path: { id: sessionID },
                query: { limit: MESSAGE_LOOKUP_LIMIT },
            })
            const messages = res?.data ?? res
            return Array.isArray(messages) ? messages : undefined
        } catch (err) {
            this.logger.warn(`messages ${short(sessionID)} list failed`, errText(err))
            return undefined
        }
    }

    private isPingMessage(m: any): boolean {
        const text = (m?.parts ?? [])
            .filter((p: any) => p?.type === "text")
            .map((p: any) => p?.text ?? "")
            .join("")
            .trim()
        return text === this.config.pingToken
    }

    /**
     * Remove the `~` user + `~` assistant turn so it never enters real context.
     * Revert drops the target and everything after it (and rolls back file
     * snapshots), so it is skipped unless only the ping's own replies follow.
     */
    private async revertPing(sessionID: string, ping: InflightPing): Promise<void> {
        const messages = await this.recentMessages(sessionID)
        if (!messages) return

        let index = -1
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i]
            if (m?.info?.role !== "user") continue
            if (ping.messageID ? m.info.id === ping.messageID : this.isRecentPing(m, ping))
                index = i
        }
        if (index < 0) {
            this.logger.dbg(`ping ${short(sessionID)} revert: ping message not found`)
            return
        }

        const target: string = messages[index].info.id
        const foreign = messages
            .slice(index + 1)
            .some((m: any) => m?.info?.role !== "assistant" || m?.info?.parentID !== target)
        if (foreign) {
            this.logger.warn(`ping ${short(sessionID)} not reverted — other messages followed it`)
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

    private isRecentPing(m: any, ping: InflightPing): boolean {
        return (
            Number(m?.info?.time?.created ?? 0) >= ping.startedAt - 2_000 && this.isPingMessage(m)
        )
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
        const control = readControl(this.directory)
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
            // Only re-arm sessions with a real response whose cache may still be warm,
            // and that are not currently occupied.
            if (!session.eligible || session.busy || session.warming) continue
            if (!session.lastResponseAt || !this.cacheMayBeWarm(session, now)) continue
            this.openWindow(session, now)
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

/** Last time the session's prompt cache was known to be used (real response or ping). */
function lastCacheTouch(s: SessionKeepalive): number {
    return Math.max(s.lastResponseAt, s.lastPingAt ?? 0)
}

function isNewUserMessage(s: SessionKeepalive, info: any): boolean {
    if (typeof info?.id === "string" && info.id === s.lastUserID) return false
    const created = info?.time?.created
    return typeof created !== "number" || created >= (s.lastUserAt ?? 0)
}

function noteUserMessage(s: SessionKeepalive, info: any): void {
    if (typeof info?.id === "string") s.lastUserID = info.id
    const created = info?.time?.created
    if (typeof created === "number") s.lastUserAt = created
    const request = requestFrom(info)
    if (request) s.request = request
}

/** Extract replayable request settings from a user message's info. */
function requestFrom(info: any): PingRequest | undefined {
    const model = info?.model
    const providerID = model?.providerID
    const modelID = model?.modelID ?? model?.id
    if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
    const variant = model?.variant ?? info?.variant
    return {
        agent: typeof info?.agent === "string" ? info.agent : undefined,
        providerID,
        modelID,
        variant: typeof variant === "string" && variant !== "default" ? variant : undefined,
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
