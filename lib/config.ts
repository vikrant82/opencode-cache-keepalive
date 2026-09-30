export type KeepaliveConfig = {
    enabled: boolean
    intervals: Record<string, number>
    hosts: string[]
    cacheReadFactor: number
    missFactor: number
    maxReplaysPerGap: "auto" | number
    includeChildSessions: boolean
    replayTimeoutMs: number
    maxStoredBytes: number
    debug: boolean
}

const DEFAULTS: KeepaliveConfig = {
    enabled: true,
    intervals: { claude: 285_000, gpt: 1_680_000 },
    hosts: ["githubcopilot.com"],
    cacheReadFactor: 0.1,
    missFactor: 1,
    maxReplaysPerGap: "auto",
    includeChildSessions: false,
    replayTimeoutMs: 60_000,
    maxStoredBytes: 67_108_864,
    debug: false,
}

const DEPRECATED = [
    "intervalMs",
    "intervalSeconds",
    "windowMs",
    "windowMinutes",
    "revertPing",
    "pingToken",
    "injectSystemInstruction",
    "providerAllowlist",
    "modelAllowlist",
    "claudeBusyWarm",
    "claudeBusyWarmIntervalMs",
    "claudeBusyWarmWindowMs",
]
const warnedDeprecated = new Set<string>()

export function getConfig(
    options: Record<string, unknown> | undefined,
    warn: (message: string) => void = () => {},
): KeepaliveConfig {
    const option = options ?? {}
    const env = process.env
    for (const key of DEPRECATED) {
        if (key in option && !warnedDeprecated.has(key)) {
            warnedDeprecated.add(key)
            warn(`deprecated option ${key} is ignored`)
        }
    }
    const parseJson = (raw: string | undefined): unknown => {
        if (!raw) return undefined
        try {
            return JSON.parse(raw)
        } catch {
            return undefined
        }
    }
    const intervals = objectOption(
        option.intervals ?? parseJson(env.OPENCODE_KEEPALIVE_INTERVALS),
        DEFAULTS.intervals,
    )
    const hosts = listOption(
        option.hosts ?? parseJson(env.OPENCODE_KEEPALIVE_HOSTS),
        DEFAULTS.hosts,
    )
    const maxRaw = option.maxReplaysPerGap ?? env.OPENCODE_KEEPALIVE_MAX_REPLAYS_PER_GAP
    const maxReplaysPerGap =
        maxRaw === "auto"
            ? "auto"
            : positiveNumber(maxRaw) !== undefined
              ? positiveNumber(maxRaw)!
              : DEFAULTS.maxReplaysPerGap
    return {
        enabled: boolOption(
            option.enabled,
            env.OPENCODE_KEEPALIVE_ENABLED === undefined
                ? DEFAULTS.enabled
                : env.OPENCODE_KEEPALIVE_ENABLED !== "false",
        ),
        intervals,
        hosts,
        cacheReadFactor:
            positiveNumber(option.cacheReadFactor ?? env.OPENCODE_KEEPALIVE_CACHE_READ_FACTOR) ??
            DEFAULTS.cacheReadFactor,
        missFactor:
            positiveNumber(option.missFactor ?? env.OPENCODE_KEEPALIVE_MISS_FACTOR) ??
            DEFAULTS.missFactor,
        maxReplaysPerGap,
        includeChildSessions: boolOption(
            option.includeChildSessions,
            env.OPENCODE_KEEPALIVE_INCLUDE_CHILD_SESSIONS === "true" ||
                DEFAULTS.includeChildSessions,
        ),
        replayTimeoutMs:
            positiveNumber(option.replayTimeoutMs ?? env.OPENCODE_KEEPALIVE_REPLAY_TIMEOUT_MS) ??
            DEFAULTS.replayTimeoutMs,
        maxStoredBytes:
            positiveNumber(option.maxStoredBytes ?? env.OPENCODE_KEEPALIVE_MAX_STORED_BYTES) ??
            DEFAULTS.maxStoredBytes,
        debug: boolOption(option.debug, env.OPENCODE_KEEPALIVE_DEBUG === "true"),
    }
}

function boolOption(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback
}

function positiveNumber(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Number(value) : value
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function objectOption(value: unknown, fallback: Record<string, number>): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback
    const entries = Object.entries(value).flatMap(([key, interval]) => {
        const parsed = positiveNumber(interval)
        return parsed === undefined ? [] : [[key.toLowerCase(), parsed] as const]
    })
    return entries.length ? Object.fromEntries(entries) : fallback
}

function listOption(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) return fallback
    const values = value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
    )
    return values.length ? values : fallback
}
