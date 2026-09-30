import type { KeepaliveConfig } from "./config"
import type { Logger } from "./logger"
import type {
    ReplayResult,
    ResumeResult,
    SessionWarmEntry,
    WarmApi,
    WarmState,
    WarmStateSink,
} from "./types"
import { readSessionControls } from "./control"

type Recorded = {
    url: string
    method: string
    headers: Headers
    body: string
    model: string
    api: WarmApi
    sentAt: number
    intervalMs: number
}
type Session = {
    request: Recorded
    entry: SessionWarmEntry
    timer?: ReturnType<typeof setTimeout>
    controller?: AbortController
    runningTools: Set<string>
    active: boolean
    busy: boolean
    realRequests: number
    previousPrompt?: number
    replayReadTokens: number
    pendingResume?: { replays: number; promptPrev: number; replayReadTokens: number }
    retries: number
    child: boolean
    stopLoggedGap?: number
    touchedAt: number
}
type Runtime = {
    originalFetch: typeof fetch
    sessions: Map<string, Session>
    owners: Map<string, ReplayWarmer>
    instancesSet: Set<ReplayWarmer>
    childSessions: Set<string>
    now: () => number
    loggedApis: Set<WarmApi>
    maxStoredBytes: number
    storedBytes: number
    hosts: Set<string>
    pruneTimer?: ReturnType<typeof setInterval>
    instances: Map<
        ReplayWarmer,
        {
            enabled: boolean
            controls: Map<string, boolean>
            effective: Map<string, boolean>
            directory: string
            hosts: Set<string>
            config: KeepaliveConfig
            sink: WarmStateSink
        }
    >
}
const STATE_KEY = Symbol.for("opencode-cache-keepalive.replay-warmer")
const RETRY_MS = 10_000

/** Replays allowlisted model requests at cache-refresh deadlines without generating model output. */
export class ReplayWarmer {
    private runtime?: Runtime
    private controlTimer?: ReturnType<typeof setInterval>
    private enabled = false

    constructor(
        private readonly client: any,
        private readonly config: KeepaliveConfig,
        private readonly sink: WarmStateSink,
        private readonly logger: Logger,
        private readonly directory: string,
        private readonly now: () => number = Date.now,
    ) {}

    start(): void {
        if (this.runtime) return
        const runtime = getRuntime(this.now)
        this.enabled = this.config.enabled
        runtime.instances.set(this, {
            enabled: this.enabled,
            effective: new Map(),
            directory: this.directory,
            controls: new Map(
                Object.entries(readSessionControls(this.directory, this.now()).sessions).map(
                    ([id, value]) => [id, value.enabled],
                ),
            ),
            hosts: new Set(this.config.hosts.map((host) => host.toLowerCase())),
            config: this.config,
            sink: this.sink,
        })
        runtime.maxStoredBytes = Math.min(runtime.maxStoredBytes, this.config.maxStoredBytes)
        for (const host of this.config.hosts) runtime.hosts.add(host.toLowerCase())
        runtime.instancesSet.add(this)
        this.runtime = runtime
        if (!runtime.pruneTimer) {
            runtime.pruneTimer = setInterval(() => pruneOrphanSessions(runtime), 60_000)
        }
        if (runtime.instancesSet.size === 1) {
            globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
                let bodySource: Promise<string> | undefined
                let rejection: string | undefined
                let shouldRecord = false
                try {
                    rejection = cheapEligibilityRejection(runtime, input, init)
                    if (rejection) {
                        if (isCopilotRequest(input))
                            runtime.instancesSet
                                .values()
                                .next()
                                .value?.debugRecordRejected(rejection)
                    } else if (!rejection) {
                        shouldRecord = true
                        if (
                            isReplayRequest(input, init) &&
                            input instanceof Request &&
                            init?.body === undefined
                        ) {
                            // Clone synchronously: the transport may consume or lock the original Request.
                            bodySource = input.clone().text()
                            // Keep early-disposal paths safe while preserving rejection for recorder handling.
                            void bodySource.catch(() => {})
                        }
                    }
                } catch {
                    // Observation must never change whether or how the real fetch is forwarded.
                }
                const result = runtime.originalFetch(input, init)
                if (shouldRecord) {
                    queueMicrotask(() => {
                        void recordRequest(runtime, input, init, bodySource).catch(() => {})
                    })
                }
                return result
            }) as typeof fetch
        }
        this.controlTimer = setInterval(() => this.syncControl(), 1000)
    }

    dispose(): void {
        if (this.controlTimer) clearInterval(this.controlTimer)
        this.controlTimer = undefined
        const runtime = this.runtime
        this.runtime = undefined
        if (!runtime) return
        runtime.instancesSet.delete(this)
        runtime.instances.delete(this)
        for (const [id, owner] of runtime.owners) {
            if (owner !== this) continue
            const session = runtime.sessions.get(id)
            if (session) {
                this.clearTimerFrom(session)
                session.controller?.abort()
                runtime.storedBytes = Math.max(
                    0,
                    runtime.storedBytes - bodyBytes(session.request.body),
                )
                session.request.body = ""
            }
            runtime.owners.delete(id)
            runtime.sessions.delete(id)
        }
        if (runtime.instancesSet.size === 0) {
            if (runtime.pruneTimer) clearInterval(runtime.pruneTimer)
            globalThis.fetch = runtime.originalFetch
            for (const [id, session] of runtime.sessions) {
                this.clearTimerFrom(session)
                session.controller?.abort()
                runtime.sessions.delete(id)
            }
            delete (globalThis as typeof globalThis & { [STATE_KEY]?: Runtime })[STATE_KEY]
        }
    }

    onEvent(event: any): void {
        const runtime = this.runtime
        if (!runtime) return
        const props = event?.properties ?? {}
        const id = props.sessionID ?? props.info?.id ?? props.part?.sessionID
        const info = props.info ?? props.session
        if (event?.type === "session.created" && typeof info?.id === "string" && info.parentID)
            runtime.childSessions.add(info.id)
        if (event?.type === "session.deleted" && typeof id === "string")
            runtime.childSessions.delete(id)
        if (typeof id !== "string") return
        if (event?.type !== "session.deleted" && !this.sessionEnabled(id)) {
            const disabled = runtime.sessions.get(id)
            if (disabled && runtime.owners.get(id) === this) {
                this.disableSession(runtime, id, disabled)
            } else if (
                !disabled &&
                this.config.enabled &&
                this.runtime?.instances.get(this)?.controls.get(id) === false
            ) {
                runtime.owners.set(id, this)
                this.sink.upsert({
                    sessionID: id,
                    updatedAt: this.now(),
                    enabled: false,
                    model: "",
                    api: "messages",
                    state: "off",
                    gapId: 0,
                    gapReplays: 0,
                    cap: this.cap,
                    nextReplayAt: null,
                    sessionReplays: 0,
                    avoidedTokens: 0,
                    resumeHits: 0,
                    resumeCount: 0,
                })
            }
            return
        }
        if (!runtime.owners.has(id)) runtime.owners.set(id, this)
        if (runtime.owners.get(id) !== this) return
        const session = runtime.sessions.get(id)
        if (!session && event.type === "session.deleted") {
            this.sink.remove(id)
            return
        }
        if (!session) return
        session.touchedAt = this.now()
        const type = event.type
        if (type === "session.deleted") {
            this.clearTimer(session)
            session.controller?.abort()
            runtime.sessions.delete(id)
            runtime.storedBytes = Math.max(0, runtime.storedBytes - bodyBytes(session.request.body))
            session.request.body = ""
            this.sink.remove(id)
            return
        }
        if (type === "session.status" || type === "session.idle") {
            const status = props.status?.type ?? "idle"
            if (status === "idle") {
                session.active = false
                session.busy = false
                session.runningTools.clear()
                this.updateState(session, "idle")
                this.schedule(id, session, session.request.sentAt + session.request.intervalMs)
            } else if (status === "busy" || status === "running") {
                session.active = session.runningTools.size === 0
                session.busy = session.runningTools.size > 0
                if (session.active) this.clearTimer(session)
                this.updateState(session, session.active ? "active" : "busy")
            }
            return
        }
        if (type === "message.updated") {
            const info = props.info ?? {}
            const interactionType = String(info.interactionType ?? props.interactionType ?? "")
            if (/agent-session-(name|summary)-generation/i.test(interactionType)) return
            if (
                info.role === "assistant" &&
                ((typeof info.providerID === "string" &&
                    !info.providerID
                        .toLowerCase()
                        .replace(/[^a-z]/g, "")
                        .includes("copilot")) ||
                    (typeof info.modelID === "string" &&
                        !info.modelID.toLowerCase().includes(session.request.model.toLowerCase()) &&
                        !session.request.model.toLowerCase().includes(info.modelID.toLowerCase())))
            ) {
                this.invalidateTarget(runtime, session, this.now())
                return
            }
            if (info.role === "assistant" && info.time?.completed === undefined) {
                session.active = true
                this.clearTimer(session)
                this.updateState(session, "active")
            }
            return
        }
        if (type !== "message.part.updated") return
        const part = props.part
        if (part?.type === "step-start") {
            session.active = true
            this.clearTimer(session)
            this.updateState(session, "active")
        } else if (part?.type === "step-finish") {
            session.active = false
            const cache = part.tokens?.cache ?? {}
            const read = Number(cache.read ?? 0)
            const prompt = Number(part.tokens?.input ?? 0) + read + Number(cache.write ?? 0)
            const completedGap = session.pendingResume
            if (completedGap) {
                const hit = read >= 0.9 * completedGap.promptPrev
                const avoidedTokens = hit ? completedGap.promptPrev : 0
                const resume: ResumeResult = {
                    at: this.now(),
                    read,
                    promptPrev: completedGap.promptPrev,
                    hit,
                    replays: completedGap.replays,
                    avoidedTokens,
                    replayReadTokens: completedGap.replayReadTokens,
                }
                session.entry.resume = resume
                session.entry.avoidedTokens += avoidedTokens
                session.entry.resumeCount++
                if (hit) session.entry.resumeHits++
                const totals = this.totals
                totals.avoidedTokens += avoidedTokens
                totals.replayReadTokens += completedGap.replayReadTokens
                if (hit) totals.resumeHits++
                else totals.resumeMisses++
                this.sink.setTotals(totals)
                this.logger.info(
                    `resume session=${id} gap=${session.entry.gapId} hit=${hit} read=${read} prev=${completedGap.promptPrev} replays=${completedGap.replays} avoided=${avoidedTokens} replayRead=${completedGap.replayReadTokens}`,
                )
                session.pendingResume = undefined
            }
            session.previousPrompt = prompt
            if (session.busy) this.updateState(session, "busy")
            else {
                this.updateState(session, "idle")
                this.schedule(id, session, session.request.sentAt + session.request.intervalMs)
            }
        } else if (part?.type === "tool" && typeof part.callID === "string") {
            if (part.state?.status === "running") session.runningTools.add(part.callID)
            else if (["completed", "error"].includes(part.state?.status))
                session.runningTools.delete(part.callID)
            session.busy = session.runningTools.size > 0
            if (session.busy) {
                session.active = false
                this.updateState(session, "busy")
                this.schedule(id, session, session.request.sentAt + session.request.intervalMs)
            } else if (!session.active) {
                this.updateState(session, "idle")
                this.schedule(id, session, session.request.sentAt + session.request.intervalMs)
            }
        }
    }

    private totals = {
        replays: 0,
        avoidedTokens: 0,
        replayReadTokens: 0,
        resumeHits: 0,
        resumeMisses: 0,
    }

    /** @internal Called asynchronously by the process-wide recorder. */
    debugRecordRejected(reason: string): void {
        this.logger.dbg(`record rejected reason=${reason}`)
    }

    /** @internal Called asynchronously by the process-wide recorder. */
    async recordRequest(
        runtime: Runtime,
        input: string | URL | Request,
        init?: RequestInit,
        bodySource?: Promise<string>,
        selectedBody?: string,
        selectedParsed?: any,
    ): Promise<void> {
        if (!this.runtime) return
        const request = input instanceof Request ? input : undefined
        const body = init?.body
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
        const url =
            input instanceof URL ? input.href : typeof input === "string" ? input : input.url
        let u: URL
        try {
            u = new URL(url)
        } catch {
            this.debugRecordRejected("invalid-url")
            return
        }
        if (
            !this.config.hosts.some((host) => {
                const allowed = host.toLowerCase()
                const hostname = u.hostname.toLowerCase()
                return hostname === allowed || hostname.endsWith(`.${allowed}`)
            })
        ) {
            if (isCopilotHost(u.hostname)) this.debugRecordRejected("host-not-allowed")
            return
        }
        const headers = new Headers(request?.headers)
        if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v))
        if (
            /agent-session-(name|summary)-generation/i.test(headers.get("X-Interaction-Type") ?? "")
        ) {
            if (isCopilotHost(u.hostname)) this.debugRecordRejected("utility-interaction")
            return
        }
        const sessionID =
            headers.get("X-Session-Id") ??
            headers.get("x-session-affinity") ??
            headers.get("X-Interaction-Id")
        if (!sessionID) {
            if (isCopilotHost(u.hostname)) this.debugRecordRejected("missing-session-id")
            return
        }
        const owner = runtime.owners.get(sessionID)
        if (owner && owner !== this) return
        if (
            !runtime.instances.has(this) ||
            !this.enabled ||
            this.sessionEnabled(sessionID) === false
        )
            return
        let stringBody: string | undefined
        try {
            stringBody =
                selectedBody !== undefined
                    ? selectedBody
                    : typeof body === "string"
                      ? body
                      : body === undefined && request && isReplayRequest(input, init)
                        ? await (bodySource ?? request.clone().text())
                        : undefined
        } catch {
            stringBody = undefined
        }
        // Body reading may yield after this instance was disabled, disposed, or lost ownership.
        const instance = runtime.instances.get(this)
        if (instance) {
            instance.controls = new Map(
                Object.entries(readSessionControls(this.directory, this.now()).sessions).map(
                    ([id, value]) => [id, value.enabled],
                ),
            )
        }
        if (
            !this.runtime ||
            !instance ||
            (runtime.owners.has(sessionID) && runtime.owners.get(sessionID) !== this) ||
            !this.enabled ||
            this.sessionEnabled(sessionID) === false
        )
            return
        const session = runtime.sessions.get(sessionID)
        const sentAt = this.now()
        if (session) session.touchedAt = sentAt
        if (session) {
            if (session.entry.gapReplays > 0 && session.previousPrompt !== undefined) {
                session.pendingResume = {
                    promptPrev: session.previousPrompt,
                    replays: session.entry.gapReplays,
                    replayReadTokens: session.replayReadTokens,
                }
            }
            this.startGap(session, sentAt)
            session.entry.gapId++
        }
        if (method !== "POST" || !apiFor(u.pathname)) {
            if (session) this.invalidateTarget(runtime, session, sentAt)
            return
        }
        if (stringBody === undefined) {
            if (isCopilotHost(u.hostname)) this.debugRecordRejected("unsupported-body-type")
            if (session) {
                this.invalidateTarget(runtime, session, sentAt)
            }
            return
        }
        let parsed: any
        try {
            if (stringBody === undefined) return
            parsed = selectedBody !== undefined ? selectedParsed : JSON.parse(stringBody)
        } catch {
            if (isCopilotHost(u.hostname)) this.debugRecordRejected("invalid-json-body")
            if (session) {
                this.invalidateTarget(runtime, session, sentAt)
            }
            return
        }
        this.recordEligible(runtime, sessionID, url, method, headers, stringBody, parsed, u)
    }

    private recordEligible(
        runtime: Runtime,
        sessionID: string,
        url: string,
        method: string,
        headers: Headers,
        stringBody: string,
        parsed: any,
        u: URL,
    ): void {
        const child = runtime.childSessions.has(sessionID)
        let session = runtime.sessions.get(sessionID)
        const sentAt = this.now()
        if (session) session.touchedAt = sentAt
        const eligible =
            this.sessionEnabled(sessionID) &&
            typeof parsed?.model === "string" &&
            (!child || this.config.includeChildSessions)
        const model = typeof parsed?.model === "string" ? parsed.model.toLowerCase() : ""
        const match = Object.entries(this.config.intervals).find(([key]) =>
            model.includes(key.toLowerCase()),
        )
        const api = apiFor(u.pathname)
        if (!eligible || !match || !api) {
            if (isCopilotHost(u.hostname))
                this.debugRecordRejected(
                    !this.sessionEnabled(sessionID)
                        ? "session-disabled"
                        : child && !this.config.includeChildSessions
                          ? "child-session"
                          : typeof parsed?.model !== "string"
                            ? "missing-model"
                            : !match
                              ? "model-not-configured"
                              : "unsupported-path",
                )
            if (session) {
                this.invalidateTarget(runtime, session, sentAt)
            }
            return
        }
        runtime.instances.get(this)!.effective.set(sessionID, true)
        if (!runtime.loggedApis.has(api)) {
            runtime.loggedApis.add(api)
            this.logger.info(`record api=${api} host=${u.hostname}${u.pathname}`)
        }
        if (session) {
            session.entry.gapReplays = 0
            session.entry.resume = undefined
            session.entry.lastReplay = undefined
            session.entry.stopReason = undefined
            session.entry.stopStatus = undefined
            session.entry.state = "active"
            session.entry.enabled = true
            session.entry.model = parsed.model
            session.entry.api = api
            session.entry.nextReplayAt = null
            session.entry.updatedAt = sentAt
            session.active = true
            session.busy = false
            session.retries = 0
        }
        runtime.owners.set(sessionID, this)
        const oldSession = runtime.sessions.get(sessionID)
        if (oldSession) {
            runtime.storedBytes = Math.max(
                0,
                runtime.storedBytes - bodyBytes(oldSession.request.body),
            )
            oldSession.request = {
                url,
                method,
                headers,
                body: stringBody,
                model: parsed.model,
                api,
                sentAt,
                intervalMs: match[1],
            }
            runtime.storedBytes += bodyBytes(stringBody)
            oldSession.child = child
            this.publish(oldSession)
            this.enforceStoredBudget(runtime)
            return
        }
        session = {
            request: {
                url,
                method,
                headers,
                body: stringBody,
                model: parsed.model,
                api,
                sentAt,
                intervalMs: match[1],
            },
            entry: {
                sessionID,
                updatedAt: sentAt,
                enabled: true,
                model: parsed.model,
                api,
                state: "active",
                gapId: 1,
                gapReplays: 0,
                cap: this.cap,
                nextReplayAt: null,
                sessionReplays: 0,
                avoidedTokens: 0,
                resumeHits: 0,
                resumeCount: 0,
            },
            runningTools: new Set(),
            active: true,
            busy: false,
            realRequests: 1,
            retries: 0,
            child,
            replayReadTokens: 0,
            touchedAt: sentAt,
        }
        runtime.sessions.set(sessionID, session)
        runtime.owners.set(sessionID, this)
        runtime.storedBytes += bodyBytes(stringBody)
        this.publish(session)
        this.enforceStoredBudget(runtime)
    }

    private startGap(session: Session, sentAt: number, model?: string): void {
        const runtime = this.runtime!
        session.controller?.abort()
        session.controller = undefined
        this.clearTimer(session)
        runtime.storedBytes = Math.max(0, runtime.storedBytes - bodyBytes(session.request.body))
        session.request.body = ""
        session.entry.gapReplays = 0
        session.entry.resume = undefined
        session.entry.lastReplay = undefined
        session.entry.stopReason = undefined
        session.entry.stopStatus = undefined
        session.entry.nextReplayAt = null
        session.replayReadTokens = 0
        session.entry.updatedAt = sentAt
        session.touchedAt = sentAt
        session.entry.model = model ?? session.entry.model
        session.active = false
        session.busy = false
        session.retries = 0
    }

    private invalidateTarget(runtime: Runtime, session: Session, at: number): void {
        this.clearTimer(session)
        session.controller?.abort()
        session.controller = undefined
        runtime.storedBytes = Math.max(0, runtime.storedBytes - bodyBytes(session.request.body))
        session.request.body = ""
        session.entry.state = this.sessionEnabled(session.entry.sessionID) ? "idle" : "off"
        session.entry.nextReplayAt = null
        session.entry.updatedAt = at
        this.publish(session)
    }

    private enforceStoredBudget(runtime: Runtime): void {
        while (runtime.storedBytes > runtime.maxStoredBytes) {
            const oldestID = [...runtime.sessions.keys()]
                .filter((id) => runtime.sessions.get(id)!.request.body.length > 0)
                .sort(
                    (a, b) =>
                        runtime.sessions.get(a)!.touchedAt - runtime.sessions.get(b)!.touchedAt,
                )[0]
            if (!oldestID) break
            const session = runtime.sessions.get(oldestID)!
            this.clearTimer(session)
            session.controller?.abort()
            runtime.storedBytes -= bodyBytes(session.request.body)
            session.request.body = ""
            runtime.owners.get(oldestID)?.logger.info(`evict session=${oldestID}`)
            session.entry.nextReplayAt = null
            session.entry.state = "idle"
            session.entry.updatedAt = this.now()
            runtime.owners.get(oldestID)?.publish(session)
        }
    }

    private get cap(): number {
        return this.config.maxReplaysPerGap === "auto"
            ? Math.floor(
                  (this.config.missFactor - this.config.cacheReadFactor) /
                      this.config.cacheReadFactor,
              )
            : this.config.maxReplaysPerGap
    }

    private schedule(id: string, session: Session, at: number): void {
        this.clearTimer(session)
        if (
            this.runtime?.owners.get(id) !== this ||
            !session.entry.enabled ||
            session.active ||
            session.entry.state === "stopped" ||
            !session.request.body
        )
            return
        session.entry.nextReplayAt = at
        this.publish(session)
        this.logger.dbg(
            `schedule session=${id} state=${session.busy ? "busy" : "idle"} next=${new Date(at).toISOString()}`,
        )
        session.timer = setTimeout(
            () => void this.replay(id, session),
            Math.max(0, at - this.now()),
        )
    }

    private async replay(id: string, session: Session): Promise<void> {
        const runtime = this.runtime
        if (
            !runtime ||
            runtime.owners.get(id) !== this ||
            !session.entry.enabled ||
            runtime.sessions.get(id) !== session ||
            session.active
        )
            return
        const sentAt = this.now()
        session.request.sentAt = sentAt
        session.touchedAt = sentAt
        const controller = new AbortController()
        session.controller = controller
        session.entry.nextReplayAt = null
        this.updateState(session, session.busy ? "busy" : "idle")
        let timeout: ReturnType<typeof setTimeout> | undefined
        let latencyMs = 0
        let status = 0
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    controller.abort()
                    reject(new Error("timeout"))
                }, this.config.replayTimeoutMs)
            })
            const response = await Promise.race([
                runtime.originalFetch(session.request.url, {
                    method: session.request.method,
                    headers: new Headers(session.request.headers),
                    body: session.request.body,
                    signal: controller.signal,
                }),
                timeoutPromise,
            ])
            status = response.status
            if ([400, 401, 403].includes(status)) {
                session.entry.lastReplay = { at: sentAt, status, latencyMs: this.now() - sentAt }
                this.logger.info(replayLogLine(session, session.entry.lastReplay, "http-status"))
                this.stopSession(id, session, "rejected-4xx", status)
                return
            }
            if (!response.ok) {
                session.entry.lastReplay = { at: sentAt, status, latencyMs: this.now() - sentAt }
                this.logger.info(replayLogLine(session, session.entry.lastReplay, "http-status"))
                this.retryOrLapse(id, session, sentAt, undefined, status)
                return
            }
            const result = await Promise.race([
                readAbortPoint(response, session.request.api, controller),
                timeoutPromise,
            ])
            latencyMs = this.now() - sentAt
            if (session.controller !== controller || runtime.sessions.get(id) !== session) return
            const { abortEvent, ...usage } = result
            const last: ReplayResult = { at: sentAt, status, latencyMs, ...usage }
            session.entry.lastReplay = last
            session.entry.gapReplays++
            session.entry.sessionReplays++
            session.replayReadTokens += result.cacheRead ?? session.previousPrompt ?? 0
            this.totals.replays++
            this.sink.setTotals(this.totals)
            session.retries = 0
            this.logger.info(replayLogLine(session, last, abortEvent))
            if (
                session.request.api === "messages" &&
                result.cacheRead === 0 &&
                (result.cacheWrite ?? 0) > 0
            ) {
                session.entry.gapReplays--
                this.stopSession(id, session, "lapsed")
                return
            }
            if (session.entry.gapReplays >= session.entry.cap) {
                this.stopSession(id, session, "cap")
                return
            }
            this.schedule(id, session, sentAt + session.request.intervalMs)
        } catch (error) {
            if (runtime.sessions.get(id) !== session || session.controller !== controller) return
            const timeoutHit = this.now() - sentAt >= this.config.replayTimeoutMs
            session.entry.lastReplay = { at: sentAt, status: 0, latencyMs: this.now() - sentAt }
            this.logger.info(
                replayLogLine(
                    session,
                    session.entry.lastReplay,
                    timeoutHit ? "timeout" : "network",
                ),
            )
            this.retryOrLapse(id, session, sentAt, timeoutHit ? "timeout" : "network")
        } finally {
            if (timeout) clearTimeout(timeout)
            controller.abort()
            if (session.controller === controller) session.controller = undefined
        }
    }

    private retryOrLapse(
        id: string,
        session: Session,
        sentAt: number,
        reason?: string,
        status = 0,
    ): void {
        session.entry.lastReplay = { at: sentAt, status, latencyMs: this.now() - sentAt }
        if (session.retries++ === 0) this.schedule(id, session, sentAt + RETRY_MS)
        else this.stopSession(id, session, "lapsed")
        if (reason) this.logger.warn(`replay ${reason} session=${id}`)
    }

    private stopSession(
        id: string,
        session: Session,
        reason: "cap" | "lapsed" | "rejected-4xx",
        status?: number,
    ): void {
        if (session.stopLoggedGap !== session.entry.gapId) {
            session.stopLoggedGap = session.entry.gapId
            this.logger.info(
                `stop session=${id} reason=${reason}${status === undefined ? "" : ` status=${status}`}`,
            )
        }
        this.clearTimer(session)
        session.controller?.abort()
        session.entry.state = "stopped"
        session.entry.stopReason = reason
        session.entry.stopStatus = status
        session.entry.nextReplayAt = null
        session.entry.updatedAt = this.now()
        if (this.runtime)
            this.runtime.storedBytes = Math.max(
                0,
                this.runtime.storedBytes - bodyBytes(session.request.body),
            )
        session.request.body = ""
        session.request.headers = new Headers()
        this.publish(session)
    }

    private updateState(session: Session, state: WarmState): void {
        const enabled = this.sessionEnabled(session.entry.sessionID)
        session.entry.state = enabled ? state : "off"
        session.entry.enabled = enabled
        session.entry.updatedAt = this.now()
        session.entry.cap = this.cap
        this.publish(session)
    }

    private publish(session: Session): void {
        this.sink.upsert({ ...session.entry })
    }
    private clearTimer(session: Session): void {
        if (!session) return
        if (session.timer) clearTimeout(session.timer)
        session.timer = undefined
        session.entry.nextReplayAt = null
    }

    private clearTimerFrom(session: Session): void {
        if (session.timer) clearTimeout(session.timer)
        session.timer = undefined
        session.entry.nextReplayAt = null
    }
    private sessionEnabled(sessionID: string): boolean {
        const instance = this.runtime?.instances.get(this)
        return this.config.enabled && instance?.controls.get(sessionID) !== false
    }
    private disableSession(runtime: Runtime, id: string, session: Session): void {
        const instance = runtime.instances.get(this)!
        instance.effective.set(id, false)
        this.clearTimer(session)
        session.controller?.abort()
        runtime.storedBytes = Math.max(0, runtime.storedBytes - bodyBytes(session.request.body))
        session.request.body = ""
        session.entry.stopReason = "disabled"
        session.entry.state = "off"
        session.entry.enabled = false
        session.entry.nextReplayAt = null
        session.entry.updatedAt = this.now()
        if (session.stopLoggedGap !== session.entry.gapId) {
            session.stopLoggedGap = session.entry.gapId
            this.logger.info(`stop session=${id} reason=disabled`)
        }
        this.publish(session)
    }
    private syncControl(): void {
        const runtime = this.runtime
        if (!runtime) return
        const instance = runtime.instances.get(this)!
        const controls = readSessionControls(this.directory, this.now()).sessions
        instance.controls = new Map(
            Object.entries(controls).map(([id, value]) => [id, value.enabled]),
        )
        for (const [id, session] of runtime.sessions) {
            if (runtime.owners.get(id) !== this) continue
            const enabled = this.sessionEnabled(id)
            const previous = instance.effective.get(id) ?? session.entry.enabled
            instance.effective.set(id, enabled)
            if (previous === enabled) continue
            if (!enabled) {
                this.disableSession(runtime, id, session)
            } else {
                session.entry.stopReason = undefined
                session.entry.state = session.active ? "active" : session.busy ? "busy" : "idle"
                session.entry.enabled = true
                session.entry.updatedAt = this.now()
                this.publish(session)
            }
        }
    }
}

function getRuntime(now: () => number): Runtime {
    const target = globalThis as typeof globalThis & { [STATE_KEY]?: Runtime }
    if (target[STATE_KEY]) return target[STATE_KEY]
    const runtime: Runtime = {
        originalFetch: globalThis.fetch,
        sessions: new Map(),
        owners: new Map(),
        instancesSet: new Set(),
        childSessions: new Set(),
        loggedApis: new Set(),
        now,
        maxStoredBytes: Number.MAX_SAFE_INTEGER,
        storedBytes: 0,
        hosts: new Set(),
        instances: new Map(),
    }
    target[STATE_KEY] = runtime
    return runtime
}

async function recordRequest(
    runtime: Runtime,
    input: string | URL | Request,
    init?: RequestInit,
    bodySource?: Promise<string>,
): Promise<void> {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    if (init?.headers && input instanceof Request)
        new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const id =
        headers.get("X-Session-Id") ??
        headers.get("x-session-affinity") ??
        headers.get("X-Interaction-Id")
    if (!id) return
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        return
    }
    const mapped = runtime.owners.get(id)
    let owner: ReplayWarmer | undefined
    if (mapped) {
        const state = runtime.instances.get(mapped)
        if (!state?.enabled || state.controls.get(id) === false) return
        owner = mapped
    } else {
        const hostname = url.hostname.toLowerCase()
        const eligiblePath = method === "POST" && !!apiFor(url.pathname)
        const candidates = [...runtime.instances].filter(
            ([, state]) =>
                state.enabled &&
                state.controls.get(id) !== false &&
                (eligiblePath || runtime.sessions.has(id)) &&
                [...state.hosts].some(
                    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
                ),
        )
        if (!candidates.length) return

        let stringBody: string | undefined
        try {
            stringBody =
                typeof init?.body === "string"
                    ? init.body
                    : init?.body === undefined && input instanceof Request
                      ? await (bodySource ?? input.clone().text())
                      : undefined
        } catch {
            stringBody = undefined
        }
        let parsed: any
        try {
            if (stringBody !== undefined) parsed = JSON.parse(stringBody)
        } catch {
            parsed = undefined
        }
        const concurrentOwner = runtime.owners.get(id)
        if (concurrentOwner) {
            const state = runtime.instances.get(concurrentOwner)
            if (!state?.enabled || state.controls.get(id) === false) return
            await concurrentOwner.recordRequest(runtime, input, init, undefined, stringBody, parsed)
            return
        }
        const child = runtime.childSessions.has(id)
        const liveCandidates = candidates.filter(
            ([instance, state]) =>
                runtime.instances.has(instance) &&
                state.enabled &&
                state.controls.get(id) !== false,
        )
        if (!liveCandidates.length) return
        const fullyEligible = liveCandidates.filter(([, state]) => {
            if (method !== "POST" || !apiFor(url.pathname)) return false
            if (child && !state.config.includeChildSessions) return false
            const model = typeof parsed?.model === "string" ? parsed.model.toLowerCase() : ""
            return (
                Object.entries(state.config.intervals).some(([key]) =>
                    model.includes(key.toLowerCase()),
                ) &&
                (!child || state.config.includeChildSessions)
            )
        })
        if (!fullyEligible.length) return
        owner = fullyEligible[0][0]
        // Reserve an eligible unknown session so concurrent observations cannot cross-route it.
        runtime.owners.set(id, owner)
        await owner.recordRequest(runtime, input, init, undefined, stringBody, parsed)
        return
    }

    if (!runtime.instances.has(owner) || runtime.owners.get(id) !== owner) return
    await owner.recordRequest(runtime, input, init, bodySource)
}

function bodyBytes(body: string): number {
    return new TextEncoder().encode(body).byteLength
}

function pruneOrphanSessions(runtime: Runtime): void {
    const cutoff = runtime.now() - 60 * 60_000
    for (const [id, session] of runtime.sessions) {
        if (session.request.body || session.touchedAt >= cutoff) continue
        session.timer && clearTimeout(session.timer)
        session.controller?.abort()
        const owner = runtime.owners.get(id)
        if (owner) runtime.instances.get(owner)?.sink.remove(id)
        runtime.owners.delete(id)
        runtime.sessions.delete(id)
    }
}

function cheapEligibilityRejection(
    runtime: Runtime,
    input: string | URL | Request,
    init?: RequestInit,
): string | undefined {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
    const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        return "invalid-url"
    }
    const copilotHost = isCopilotHost(url.hostname)
    const headers = new Headers(request?.headers)
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const id =
        headers.get("X-Session-Id") ??
        headers.get("x-session-affinity") ??
        headers.get("X-Interaction-Id")
    if (!id) return "missing-session-id"
    if (/agent-session-(name|summary)-generation/i.test(headers.get("X-Interaction-Type") ?? ""))
        return "utility-interaction"
    const hostname = url.hostname.toLowerCase()
    const owner = runtime.owners.get(id)
    const allowedHost = owner
        ? (() => {
              const state = runtime.instances.get(owner)
              return (
                  !!state?.enabled &&
                  state.controls.get(id) !== false &&
                  [...state.hosts].some(
                      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
                  )
              )
          })()
        : [...runtime.instances.values()].some(
              (state) =>
                  state.enabled &&
                  state.controls.get(id) !== false &&
                  [...state.hosts].some(
                      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
                  ),
          )
    if (!allowedHost) return "host-not-allowed"
    if (runtime.owners.has(id) || (method === "POST" && !!apiFor(url.pathname))) return undefined
    if (!copilotHost) return "ineligible"
    return method !== "POST" ? "method-not-post" : "unsupported-path"
}

function isReplayRequest(input: string | URL | Request, init?: RequestInit): boolean {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    try {
        return method === "POST" && !!apiFor(new URL(rawUrl).pathname)
    } catch {
        return false
    }
}

function isCopilotHost(hostname: string): boolean {
    const host = hostname.toLowerCase()
    return (
        host === "githubcopilot.com" ||
        host.endsWith(".githubcopilot.com") ||
        host.startsWith("copilot-api.")
    )
}

function isCopilotRequest(input: string | URL | Request): boolean {
    const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    try {
        return isCopilotHost(new URL(rawUrl).hostname)
    } catch {
        return false
    }
}

function apiFor(path: string): WarmApi | undefined {
    if (/\/v1\/messages\/?$/.test(path)) return "messages"
    if (/^\/(?:v1\/)?responses\/?$/.test(path)) return "responses"
    if (/\/chat\/completions\/?$/.test(path)) return "chat"
}

async function readAbortPoint(
    response: Response,
    api: WarmApi,
    controller: AbortController,
): Promise<{ cacheRead?: number; cacheWrite?: number; abortEvent: string }> {
    const reader = response.body?.getReader()
    if (!reader) {
        controller.abort()
        return { abortEvent: "first-chunk" }
    }
    let buffer = ""
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue
            if (api === "chat") {
                controller.abort()
                return { abortEvent: "first-chunk" }
            }
            buffer += new TextDecoder().decode(value, { stream: true })
            const events = buffer.split(/\r?\n\r?\n/)
            buffer = events.pop() ?? ""
            for (const event of events) {
                const data = event
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim())
                    .join("\n")
                if (!data || data === "[DONE]") continue
                let parsed: any
                try {
                    parsed = JSON.parse(data)
                } catch {
                    continue
                }
                if (
                    api === "responses" &&
                    ["response.created", "response.in_progress"].includes(parsed.type)
                )
                    continue
                if (api === "messages") {
                    if (parsed.type !== "message_start") continue
                    const usage = parsed.message?.usage ?? {}
                    controller.abort()
                    return {
                        abortEvent: "message_start",
                        cacheRead: numeric(usage.cache_read_input_tokens),
                        cacheWrite: numeric(usage.cache_creation_input_tokens),
                    }
                }
                controller.abort()
                return { abortEvent: String(parsed.type ?? "first-event") }
            }
        }
    } finally {
        controller.abort()
        await reader.cancel().catch(() => {})
    }
    return { abortEvent: "stream-end" }
}

function replayLogLine(session: Session, result: ReplayResult, abortEvent?: string): string {
    const usage =
        result.cacheRead === undefined && result.cacheWrite === undefined
            ? ""
            : ` cacheRead=${result.cacheRead ?? 0} cacheWrite=${result.cacheWrite ?? 0}`
    return `replay session=${session.entry.sessionID} model=${session.entry.model} api=${session.entry.api} gap=${session.entry.gapId} n=${session.entry.gapReplays}/${session.entry.cap} status=${result.status} latency=${result.latencyMs}ms abort=${abortEvent ?? "first-chunk"}${usage}`
}

function numeric(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
