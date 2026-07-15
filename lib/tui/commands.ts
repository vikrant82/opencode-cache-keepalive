import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readControl, writeControl } from "../control"

export function registerKeepaliveCommands(api: TuiPluginApi): void {
    const setEnabled = async (enabled: boolean) => {
        try {
            await writeControl(enabled)
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
                run: () => setEnabled(!currentEnabled()),
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

function currentEnabled(): boolean {
    return readControl()?.enabled ?? true
}
