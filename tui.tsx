/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { registerKeepaliveCommands } from "./lib/tui/commands"
import { KeepaliveFooter } from "./lib/tui/footer"

const tui: TuiPluginModule["tui"] = async (api) => {
    registerKeepaliveCommands(api)
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
