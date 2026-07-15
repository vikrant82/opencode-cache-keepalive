/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stateDirectoryPath, stateFilePath } from "../paths"
import type { PersistedSession, PersistedState, PingRecord } from "../state"
import { kfmt, mmss } from "./format"

type Theme = Record<string, any>
type Status = "waiting" | "off" | "warming" | "busy" | "armed" | "cold"
type Derived = {
    idleMs: number
    sent: number
    left: number
    status: Status
    lastPing?: PingRecord
}

/**
 * Persistent readout mounted in the `sidebar_footer` slot. Shows time since the
 * last real agent response plus keepalive pings sent / left. Data comes from the
 * server plugin's state file; the idle timer ticks locally every second.
 */
export function KeepaliveFooter(props: { theme: Theme; directory: string; sessionID?: string }) {
    const [now, setNow] = createSignal(Date.now())
    const [state, setState] = createSignal<PersistedState | undefined>(undefined)

    const load = () => {
        const sessionID = props.sessionID
        if (!sessionID) return setState(undefined)

        const expected = readState(stateFilePath(props.directory))
        if (expected?.sessions?.[sessionID]) return setState(expected)

        try {
            const match = readdirSync(stateDirectoryPath())
                .filter((name) => name.startsWith("state-") && name.endsWith(".json"))
                .map((name) => readState(join(stateDirectoryPath(), name)))
                .filter(
                    (snapshot): snapshot is PersistedState =>
                        snapshot?.sessions?.[sessionID] !== undefined,
                )
                .sort((a, b) => b.updatedAt - a.updatedAt)[0]
            setState(match)
        } catch {
            setState(undefined)
        }
    }

    load()
    const timer = setInterval(() => {
        setNow(Date.now())
        load()
    }, 1000)
    onCleanup(() => clearInterval(timer))

    const derived = (): Derived | undefined => {
        const snapshot = state()
        const sessionID = props.sessionID
        if (!snapshot || !sessionID) {
            return { idleMs: 0, sent: 0, left: 0, status: "waiting" }
        }
        const session: PersistedSession | undefined = snapshot.sessions?.[sessionID]
        if (!session) return { idleMs: 0, sent: 0, left: 0, status: "waiting" }

        const interval = session.intervalMs || snapshot.intervalMs || 270_000
        const idleMs = Math.max(0, now() - (session.lastResponseAt || now()))
        // `nextPingAt` is the scheduler's source of truth and includes the
        // per-ping jitter. Counting from it keeps the two counters in step.
        const nextPingAt = Math.max(session.nextPingAt || now(), now())
        const left = session.active
            ? Math.max(0, Math.ceil((session.windowEndsAt - nextPingAt) / interval))
            : 0
        const status: Status =
            !snapshot.enabled || !session.eligible
                ? "off"
                : session.warming
                  ? "warming"
                  : session.busy
                    ? "busy"
                    : session.active
                      ? "armed"
                      : "cold"

        return { idleMs, sent: session.pingsSent || 0, left, status, lastPing: session.lastPing }
    }

    const theme = props.theme

    return (
        <Show when={derived()}>
            {(data: () => Derived) => (
                <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={0}>
                    <box flexDirection="row" gap={1}>
                        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                            keepalive
                        </text>
                        <text fg={statusColor(theme, data().status)}>
                            {statusLabel(data().status)}
                        </text>
                    </box>

                    <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>idle</text>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {mmss(data().idleMs)}
                        </text>
                        <text fg={theme.textMuted}>· sent</text>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {String(data().sent)}
                        </text>
                        <text fg={theme.textMuted}>· left</text>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {String(data().left)}
                        </text>
                    </box>

                    <Show when={data().lastPing}>
                        {(ping: () => PingRecord) => (
                            <box flexDirection="row" gap={1}>
                                <text fg={ping().hit ? theme.success : theme.warning}>
                                    {ping().hit ? "✓ hit" : "✗ miss"}
                                </text>
                                <text fg={theme.textMuted}>
                                    input {kfmt(ping().input)} · read {kfmt(ping().cacheRead)} ·
                                    write {kfmt(ping().cacheWrite)}
                                </text>
                            </box>
                        )}
                    </Show>
                </box>
            )}
        </Show>
    )
}

function statusLabel(status: Status): string {
    if (status === "waiting") return "waiting"
    if (status === "warming") return "warming…"
    if (status === "busy") return "busy"
    if (status === "armed") return "armed"
    if (status === "cold") return "cold"
    return "off"
}

function statusColor(theme: Theme, status: Status): any {
    if (status === "waiting") return theme.textMuted
    if (status === "warming") return theme.accent
    if (status === "busy") return theme.info
    if (status === "armed") return theme.success
    if (status === "cold") return theme.warning
    return theme.textMuted
}

function readState(path: string): PersistedState | undefined {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as PersistedState
    } catch {
        return undefined
    }
}
