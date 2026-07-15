export function mmss(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function kfmt(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    if (n < 1000) return `${Math.round(n)}`
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}
