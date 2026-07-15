import type { Plugin } from "@opencode-ai/plugin"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { getConfig } from "./lib/config"
import { KeepaliveEngine } from "./lib/keepalive"
import { Logger } from "./lib/logger"
import { isEligibleModel } from "./lib/model"
import { logFilePath } from "./lib/paths"
import { KeepaliveStore } from "./lib/state"
import { keepaliveInstruction } from "./lib/system"

declare const __KEEPALIVE_VERSION__: string

const server: Plugin = async (ctx, options) => {
    const config = getConfig(options as Record<string, unknown> | undefined)
    const logger = new Logger(config.debug, logFilePath())

    if (!config.enabled) {
        logger.info("disabled via config")
        return {}
    }

    if (isSecureMode()) configureClientAuth(ctx.client)

    const store = new KeepaliveStore(config, ctx.directory)
    const engine = new KeepaliveEngine(ctx.client, config, store, logger)
    engine.start()

    const version = typeof __KEEPALIVE_VERSION__ !== "undefined" ? __KEEPALIVE_VERSION__ : "dev"
    logger.info(`v${version} ready`)

    const instruction = keepaliveInstruction(config.pingToken)

    return {
        event: async ({ event }) => {
            await engine.onEvent(event)
        },

        // Keep the system prefix identical between real turns and pings, and make
        // the model answer a ping with a single token.
        "experimental.chat.system.transform": async (input, output) => {
            if (!config.injectSystemInstruction) return
            const model = input.model as { providerID?: string; id?: string; modelID?: string }
            if (!isEligibleModel(config, model?.providerID, model?.id ?? model?.modelID)) return
            output.system.push(instruction)
        },

        // Backstop: if the model ignores the instruction and tries a tool during a
        // ping, block it — the ping turn is going to be reverted anyway.
        "tool.execute.before": async (input) => {
            if (engine.isWarming(input.sessionID)) {
                throw new Error("cache-keepalive: tools are disabled during a keepalive ping")
            }
        },

        dispose: async () => {
            engine.stop()
        },
    }
}

export default server
