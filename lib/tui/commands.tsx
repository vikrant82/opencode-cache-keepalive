/** @jsxImportSource @opentui/solid */

import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readFileSync } from "node:fs"
import {
    type ControlPatch,
    isValidInterval,
    MAX_INTERVAL_MS,
    MIN_INTERVAL_MS,
    readControl,
    updateControl,
} from "../control"
import { stateFilePath } from "../paths"
import { formatDuration, parseDuration } from "./format"

/** Interval presets matched to common provider prompt-cache lifetimes. */
const INTERVAL_PRESETS: { ms: number; description: string }[] = [
    { ms: 270_000, description: "5-minute caches (Claude / Anthropic)" },
    { ms: 1_700_000, description: "30-minute caches (GPT / OpenAI)" },
]

type IntervalChoice = number | "config" | "custom"

/**
 * Register the keepalive commands. The control file is scoped per directory, so
 * toggling keepalive or changing its interval here only affects this project's
 * server plugin — not other open opencode sessions. The server polls the file
 * every second, so changes apply without a restart.
 */
export function registerKeepaliveCommands(api: TuiPluginApi): void {
    // Read lazily: state paths may not be populated at registration time.
    const directory = () => api.state.path.directory

    const apply = async (
        patch: ControlPatch,
        message: string,
        variant: "success" | "warning" | "info",
    ) => {
        try {
            await updateControl(directory(), patch)
            api.ui.toast({ variant, title: "Cache keepalive", message })
        } catch (error) {
            api.ui.toast({
                variant: "error",
                title: "Cache keepalive",
                message: error instanceof Error ? error.message : String(error),
            })
        }
    }

    const setEnabled = (enabled: boolean) =>
        apply({ enabled }, enabled ? "Enabled" : "Disabled", enabled ? "success" : "warning")

    const setPingInterval = (intervalMs: number | null) =>
        apply(
            { intervalMs },
            intervalMs === null
                ? "Ping interval reset to the plugin default"
                : `Ping interval ${formatDuration(intervalMs)}`,
            "info",
        )

    const showCustomInterval = (current: number | undefined) => {
        api.ui.dialog.replace(() => (
            <api.ui.DialogPrompt
                title="Custom ping interval"
                placeholder="e.g. 4m30s, 270s, 12m (a bare number means minutes)"
                value={current ? formatDuration(current).replace(/ /g, "") : undefined}
                onConfirm={(raw) => {
                    const ms = parseDuration(raw)
                    if (ms === undefined || !isValidInterval(ms)) {
                        api.ui.toast({
                            variant: "error",
                            title: "Cache keepalive",
                            message: `Enter a duration between ${formatDuration(MIN_INTERVAL_MS)} and ${formatDuration(MAX_INTERVAL_MS)}, e.g. 4m30s`,
                        })
                        return
                    }
                    api.ui.dialog.clear()
                    void setPingInterval(ms)
                }}
                onCancel={() => api.ui.dialog.clear()}
            />
        ))
    }

    const showInterval = () => {
        const override = readControl(directory())?.intervalMs
        const options: TuiDialogSelectOption<IntervalChoice>[] = INTERVAL_PRESETS.map((preset) => ({
            title: formatDuration(preset.ms),
            value: preset.ms,
            description: preset.description,
        }))
        if (override !== undefined && !INTERVAL_PRESETS.some((preset) => preset.ms === override)) {
            options.push({
                title: formatDuration(override),
                value: override,
                description: "Current custom interval",
            })
        }
        options.push(
            {
                title: "Custom…",
                value: "custom",
                description: "Enter a duration, e.g. 4m30s or 12m",
            },
            {
                title: "Plugin default",
                value: "config",
                description: "Clear the override and use the configured intervalMs",
            },
        )

        api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
                title="Keepalive ping interval"
                options={options}
                current={override ?? "config"}
                onSelect={(option) => {
                    const choice = option.value as IntervalChoice
                    if (choice === "custom") {
                        showCustomInterval(override)
                        return
                    }
                    api.ui.dialog.clear()
                    void setPingInterval(choice === "config" ? null : choice)
                }}
            />
        ))
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
            {
                name: "keepalive.interval",
                title: "Set cache keepalive ping interval",
                category: "Keepalive",
                namespace: "palette",
                slashName: "keepalive-interval",
                run: showInterval,
            },
        ],
    })
}

/**
 * Effective on/off state: the runtime override if set, else what this project's
 * server last reported (its configured default), else on.
 */
function currentEnabled(directory: string): boolean {
    const override = readControl(directory)?.enabled
    if (override !== undefined) return override
    try {
        const state = JSON.parse(readFileSync(stateFilePath(directory), "utf8"))
        if (typeof state?.enabled === "boolean") return state.enabled
    } catch {
        // No server snapshot yet.
    }
    return true
}
