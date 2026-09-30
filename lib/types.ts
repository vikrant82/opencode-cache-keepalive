/**
 * Shared contracts between the server-side replay engine and the state/TUI layer.
 *
 * The engine produces one self-contained {@link SessionWarmEntry} per tracked root
 * session and hands it to a {@link WarmStateSink}; the TUI reads persisted entries
 * back per session. Entries never contain request URLs with queries, headers,
 * bodies, credentials, or conversation text.
 */

/** Wire API family of a recorded request, derived from the request pathname. */
export type WarmApi = "messages" | "responses" | "chat"

/**
 * Display/lifecycle state of a session's cache warming.
 * - `active`: a real model request/step is in flight; no replay is sent.
 * - `busy`: the session is blocked on a running tool; replays are scheduled.
 * - `idle`: the session is idle between turns; replays are scheduled.
 * - `stopped`: warming ended for the current gap; see {@link StopReason}.
 * - `off`: warming is disabled by config or runtime control.
 */
export type WarmState = "active" | "busy" | "idle" | "stopped" | "off"

/**
 * Why warming stopped for the current gap.
 * - `cap`: the per-gap replay cap was reached.
 * - `lapsed`: the cache is believed expired (failed retry, or a replay reported a cache write instead of a read).
 * - `rejected-4xx`: the provider rejected the replay with 400/401/403.
 * - `disabled`: runtime control or config turned warming off.
 */
export type StopReason = "cap" | "lapsed" | "rejected-4xx" | "disabled"

/** Outcome of the most recent replay attempt. */
export interface ReplayResult {
    /** Replay send time, epoch ms. */
    at: number
    /** HTTP status; 0 for network error or timeout. */
    status: number
    /** Milliseconds from issuing the replay fetch to the API-specific abort point. */
    latencyMs: number
    /** Cached prompt tokens reported by the provider, when parseable before abort (messages API). */
    cacheRead?: number
    /** Cache-write prompt tokens reported by the provider, when parseable before abort (messages API). */
    cacheWrite?: number
}

/** Result of the first real model call after a gap that had at least one successful replay. */
export interface ResumeResult {
    /** step-finish time, epoch ms. */
    at: number
    /** cache.read tokens of that call. */
    read: number
    /** Prompt tokens (input + cache.read + cache.write) of the last call before the gap. */
    promptPrev: number
    /** True when read >= 0.9 * promptPrev. */
    hit: boolean
    /** Successful replays spent in the gap. */
    replays: number
    /**
     * Cache-write tokens avoided for the gap: `promptPrev` on a hit, 0 on a miss.
     * Gross figure shown to users as "saved"; replay cost is reported separately.
     */
    avoidedTokens: number
    /**
     * Cached-read tokens spent by the gap's successful replays (sum of each replay's
     * reported cacheRead, falling back to promptPrev when not parsed). Logged only.
     */
    replayReadTokens: number
}

/**
 * Complete, self-contained display state for one root session. Every field the TUI
 * needs is here so readers never depend on file-level or process-level fields.
 */
export interface SessionWarmEntry {
    sessionID: string
    /** Last time this entry changed, epoch ms; readers pick the freshest entry per session. */
    updatedAt: number
    /** Effective enablement (config AND runtime control). */
    enabled: boolean
    /** Model id from the recorded request body. */
    model: string
    api: WarmApi
    state: WarmState
    stopReason?: StopReason
    /** HTTP status that caused `rejected-4xx`. */
    stopStatus?: number
    /** Monotonic per-session gap counter; a gap starts at each real request send. */
    gapId: number
    /** Successful replays in the current gap. */
    gapReplays: number
    /** Per-gap replay cap in effect. */
    cap: number
    /** Next scheduled replay time, epoch ms; null when none is scheduled. */
    nextReplayAt: number | null
    /** Successful replays across the session's lifetime in this process. */
    sessionReplays: number
    /** Sum of ResumeResult.avoidedTokens across the session's gaps in this process. */
    avoidedTokens: number
    /** Resumes (first call after a gap with ≥1 successful replay) that hit, in this process. */
    resumeHits: number
    /** All resumes (hits + misses) in this process. */
    resumeCount: number
    lastReplay?: ReplayResult
    resume?: ResumeResult
}

/** Process-wide aggregates, informational only (never used to gate display). */
export interface ProcessTotals {
    replays: number
    avoidedTokens: number
    replayReadTokens: number
    resumeHits: number
    resumeMisses: number
}

/**
 * Destination for engine state. Implementations persist sanitized entries for the
 * TUI. Calls are synchronous and must never throw; persistence may be debounced.
 * Single-threaded use from the plugin's event loop is assumed.
 */
export interface WarmStateSink {
    /** Replace the entry for `entry.sessionID`. */
    upsert(entry: SessionWarmEntry): void
    /** Forget a session (e.g. deleted). */
    remove(sessionID: string): void
    /** Replace process totals. */
    setTotals(totals: ProcessTotals): void
    /** Flush pending writes and remove this instance's persisted file. Never rejects. */
    dispose(): Promise<void>
}
