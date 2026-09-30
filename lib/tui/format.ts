export function mmss(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function kfmt(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    if (n >= 1_000_000) {
        const m = n / 1_000_000
        return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`
    }
    if (n < 1000) return `${Math.round(n)}`
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 }

/**
 * Parse a human duration such as "4m30s", "4.5m", "270s", "1h" or "28m 20s".
 * A bare number means minutes. Returns undefined for anything unparseable;
 * range checks are the caller's concern.
 */
export function parseDuration(input: string): number | undefined {
    const text = input.trim().toLowerCase()
    if (!text) return undefined
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * UNIT_MS.m)

    const segment = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*/y
    let total = 0
    while (segment.lastIndex < text.length) {
        const match = segment.exec(text)
        if (!match) return undefined
        total += Number(match[1]) * UNIT_MS[match[2][0]]
    }
    return Math.round(total)
}

/** Compact duration label, e.g. 270000 -> "4m 30s", 3600000 -> "1h". */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    const parts = [
        hours ? `${hours}h` : "",
        minutes ? `${minutes}m` : "",
        seconds ? `${seconds}s` : "",
    ].filter(Boolean)
    return parts.length ? parts.join(" ") : "0s"
}
