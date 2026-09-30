/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, Show } from "solid-js"
import type { SessionWarmEntry, WarmState } from "../types"
import { readSessionEntry } from "../state"
import { kfmt, mmss } from "./format"

type Theme = Record<string, any>

/** Display the persisted replay-warming state for the current session only. */
export function KeepaliveFooter(props: { theme: Theme; directory: string; sessionID?: string }) {
    const [now, setNow] = createSignal(Date.now())
    const [entry, setEntry] = createSignal<SessionWarmEntry | undefined>()

    const load = () => {
        setEntry(props.sessionID ? readSessionEntry(props.directory, props.sessionID) : undefined)
    }

    load()
    const timer = setInterval(() => {
        setNow(Date.now())
        load()
    }, 1000)
    onCleanup(() => clearInterval(timer))

    return (
        <Show when={entry()}>
            {(data: () => SessionWarmEntry) => {
                const firstLine = () => {
                    const value = data()
                    const remaining =
                        value.nextReplayAt === null ? 0 : Math.max(0, value.nextReplayAt - now())
                    return formatStatusLine(value, remaining)
                }
                const secondLine = () => formatDetails(data(), now())

                return (
                    <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        paddingTop={1}
                        gap={0}
                    >
                        <text
                            fg={stateColor(props.theme, data().state)}
                            attributes={TextAttributes.BOLD}
                        >
                            {firstLine()}
                        </text>
                        <Show when={secondLine()}>
                            {(line: () => string) => (
                                <text fg={props.theme.textMuted}>{line()}</text>
                            )}
                        </Show>
                    </box>
                )
            }}
        </Show>
    )
}

/** Pure formatter for the two-line footer's optional telemetry. */
export function formatDetails(entry: SessionWarmEntry, now = Date.now()): string | undefined {
    return `refreshes ${entry.sessionReplays} · hits ${entry.resumeHits}/${entry.resumeCount} · saved ~${kfmt(entry.avoidedTokens)} tok`
}

export function formatStatusLine(entry: SessionWarmEntry, remainingMs: number): string {
    if (entry.state === "off") return "keepalive off"
    if (entry.state === "active") return "keepalive standby · model working"
    if (entry.state === "stopped") {
        if (entry.stopReason === "cap") return `keepalive stopped · refresh cap (${entry.cap})`
        if (entry.stopReason === "lapsed") return "keepalive stopped · cache expired"
        if (entry.stopReason === "rejected-4xx")
            return `keepalive stopped · refresh rejected ${entry.stopStatus ?? "unknown"}`
        return "keepalive off"
    }
    const state = entry.state
    return `keepalive ${state} · ${entry.gapReplays}/${entry.cap}${entry.nextReplayAt === null ? "" : ` · next ${mmss(remainingMs)}`}`
}

function stateColor(theme: Theme, state: WarmState): any {
    if (state === "busy" || state === "active") return theme.info
    if (state === "idle") return theme.success
    if (state === "stopped") return theme.warning
    return theme.textMuted
}
