/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { registerKeepaliveCommands } from "./lib/tui/commands"
import { KeepaliveFooter } from "./lib/tui/footer"
import { readSessionEntry } from "./lib/state"
import type { SessionWarmEntry } from "./lib/types"

/** Route-level owner for deduplicating rejected replay notifications. */
export function notifyRejectedReplayOnce(
    notified: Set<string>,
    sessionID: string,
    entry: SessionWarmEntry,
    toast: (message: string) => void,
): void {
    if (
        entry.state !== "stopped" ||
        entry.stopReason !== "rejected-4xx" ||
        entry.stopStatus === undefined
    )
        return
    const key = `${sessionID}:${entry.gapId}`
    if (notified.has(key)) return
    notified.add(key)
    toast(`Keepalive refresh rejected (${entry.stopStatus}) — stopped for this session`)
}

const tui: TuiPluginModule["tui"] = async (api) => {
    registerKeepaliveCommands(api)
    const notified = new Set<string>()
    const toastTimer = setInterval(() => {
        const route = api.route.current
        const sessionID =
            route.name === "session" && typeof route.params?.sessionID === "string"
                ? route.params.sessionID
                : undefined
        if (!sessionID) return
        const entry = readSessionEntry(api.state.path.directory, sessionID)
        if (!entry) return
        notifyRejectedReplayOnce(notified, sessionID, entry, (message) =>
            api.ui.toast({
                variant: "error",
                title: "Keepalive refresh rejected",
                message,
            }),
        )
    }, 1000)
    api.lifecycle.onDispose(() => clearInterval(toastTimer))
    api.slots.register({
        // The built-in sidebar footer uses order 100. This slot is single-winner,
        // so a lower order makes the keepalive readout the visible footer.
        order: 0,
        slots: {
            sidebar_footer: (ctx, props) => (
                <KeepaliveFooter
                    theme={ctx.theme.current}
                    directory={api.state.path.directory}
                    sessionID={props.session_id}
                />
            ),
        },
    })
}

export default { id: "opencode-cache-keepalive", tui } satisfies TuiPluginModule
