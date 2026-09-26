import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readControl, writeControl } from "../control"

export function registerKeepaliveCommands(api: TuiPluginApi): void {
    // The control file is scoped per directory, so toggling keepalive here only
    // affects this project's server plugin — not other open opencode sessions.
    // Read lazily: state paths may not be populated at registration time.
    const directory = () => api.state.path.directory

    const setEnabled = async (enabled: boolean) => {
        try {
            await writeControl(enabled, directory())
            api.ui.toast({
                variant: enabled ? "success" : "warning",
                title: "Cache keepalive",
                message: enabled ? "Enabled" : "Disabled",
            })
        } catch (error) {
            api.ui.toast({
                variant: "error",
                title: "Cache keepalive",
                message: error instanceof Error ? error.message : String(error),
            })
        }
    }

    api.keymap.registerLayer({
        commands: [
            {
                name: "keepalive.toggle",
                title: "Toggle cache keepalive",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-toggle",
                run: () => setEnabled(!currentEnabled(directory())),
            },
            {
                name: "keepalive.on",
                title: "Enable cache keepalive",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-on",
                run: () => setEnabled(true),
            },
            {
                name: "keepalive.off",
                title: "Disable cache keepalive",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-off",
                run: () => setEnabled(false),
            },
        ],
    })
}

function currentEnabled(directory: string): boolean {
    return readControl(directory)?.enabled ?? true
}
