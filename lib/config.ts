export type KeepaliveConfig = {
    /** Master switch. When false the plugin registers no timers or hooks. */
    enabled: boolean
    /** Milliseconds between pings. Must stay under the shortest supported provider TTL. */
    intervalMs: number
    /**
     * How long to keep warming after the last real response before giving up and
     * letting the cache go cold. The default follows the Copilot Claude
     * write/read break-even; providers with automatic caching may be cheaper.
     */
    windowMs: number
    /**
     * Append a stable keepalive instruction to the system prompt so the model
     * answers a `~` ping with a single `~` token and never calls tools. The
     * instruction is added to real turns too, so the cached prefix stays identical.
     */
    injectSystemInstruction: boolean
    /** The single character/token used as the keepalive suffix. */
    pingToken: string
    /** Remove synthetic ping turns after measuring their cache usage. */
    revertPing: boolean
    /** Warm subagent/child sessions too. Off by default to avoid wasted pings. */
    includeChildSessions: boolean
    debug: boolean
    /** providerID substrings eligible for warming (cache-controlled providers). */
    providerAllowlist: string[]
    /** modelID substrings eligible for warming. */
    modelAllowlist: string[]
}

const DEFAULTS: KeepaliveConfig = {
    enabled: true,
    intervalMs: 270_000, // 4.5 min — below the shortest supported cache TTL
    windowMs: 3_300_000, // 55 min — the Copilot Claude write/read break-even
    injectSystemInstruction: true,
    pingToken: "~",
    revertPing: true,
    includeChildSessions: false,
    debug: false,
    providerAllowlist: ["copilot"],
    modelAllowlist: ["claude", "anthropic", "sonnet", "opus", "haiku", "gpt"],
}

export function getConfig(options: Record<string, unknown> | undefined): KeepaliveConfig {
    const o = options ?? {}
    const env = process.env

    return {
        enabled: boolOpt(o.enabled, env.OPENCODE_KEEPALIVE_ENABLED !== "false" && DEFAULTS.enabled),
        intervalMs: durationOpt(
            o.intervalMs,
            o.intervalSeconds,
            numEnv(env.OPENCODE_KEEPALIVE_INTERVAL_MS, DEFAULTS.intervalMs),
        ),
        windowMs: durationOpt(
            o.windowMs,
            o.windowMinutes ? Number(o.windowMinutes) * 60 : undefined,
            numEnv(env.OPENCODE_KEEPALIVE_WINDOW_MS, DEFAULTS.windowMs),
        ),
        injectSystemInstruction: boolOpt(
            o.injectSystemInstruction,
            DEFAULTS.injectSystemInstruction,
        ),
        pingToken:
            typeof o.pingToken === "string" && o.pingToken.length > 0
                ? o.pingToken
                : DEFAULTS.pingToken,
        revertPing: boolOpt(
            o.revertPing,
            env.OPENCODE_KEEPALIVE_REVERT_PING !== "false" && DEFAULTS.revertPing,
        ),
        includeChildSessions: boolOpt(o.includeChildSessions, DEFAULTS.includeChildSessions),
        debug: boolOpt(o.debug, env.OPENCODE_KEEPALIVE_DEBUG === "true"),
        providerAllowlist: listOpt(o.providerAllowlist, DEFAULTS.providerAllowlist),
        modelAllowlist: listOpt(o.modelAllowlist, DEFAULTS.modelAllowlist),
    }
}

function boolOpt(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback
}

function listOpt(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback
    const filtered = value.filter((item): item is string => typeof item === "string")
    return filtered.length > 0 ? filtered : fallback
}

/** Accept an explicit `*Ms` option, a `*Seconds` option, or fall back. */
function durationOpt(ms: unknown, seconds: unknown, fallback: number): number {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
        return seconds * 1000
    return fallback
}

function numEnv(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
}
