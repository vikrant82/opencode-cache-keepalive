/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readSessionControl, setSessionEnabled } from "../control"

/** Register runtime enable/disable commands for the current session only. */
export function registerKeepaliveCommands(api: TuiPluginApi): void {
    const directory = () => api.state.path.directory
    const sessionID = () => {
        const route = api.route.current
        return route.name === "session" && route.params && "sessionID" in route.params
            ? String(route.params.sessionID)
            : undefined
    }
    const setEnabled = async (enabled: boolean, id: string) => {
        try {
            await setSessionEnabled(directory(), id, enabled)
            api.ui.toast({
                variant: enabled ? "success" : "warning",
                title: "Keepalive",
                message: enabled
                    ? "Keepalive on for this session"
                    : "Keepalive off for this session",
            })
        } catch (error) {
            api.ui.toast({
                variant: "error",
                title: "Keepalive",
                message: error instanceof Error ? error.message : String(error),
            })
        }
    }
    const run = (operation: (id: string) => void | Promise<void>) => () => {
        const id = sessionID()
        if (!id) {
            api.ui.toast({
                variant: "warning",
                title: "Keepalive",
                message: "Open a session to toggle keepalive",
            })
            return
        }
        return operation(id)
    }

    api.keymap.registerLayer({
        commands: [
            {
                name: "keepalive.toggle",
                title: "Toggle replay cache warmer",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-toggle",
                run: run((id) =>
                    setEnabled(!(readSessionControl(directory(), id)?.enabled ?? true), id),
                ),
            },
            {
                name: "keepalive.on",
                title: "Enable replay cache warmer",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-on",
                run: run((id) => setEnabled(true, id)),
            },
            {
                name: "keepalive.off",
                title: "Disable replay cache warmer",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-off",
                run: run((id) => setEnabled(false, id)),
            },
        ],
    })
}
