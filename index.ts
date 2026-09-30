import type { Plugin } from "@opencode-ai/plugin"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { getConfig } from "./lib/config"
import { ReplayWarmer } from "./lib/replay-warmer"
import { Logger } from "./lib/logger"
import { logFilePath } from "./lib/paths"
import { createStateStore } from "./lib/state"

declare const __KEEPALIVE_VERSION__: string

const server: Plugin = async (ctx, options) => {
    const logger = new Logger(false, logFilePath())
    const config = getConfig(options as Record<string, unknown> | undefined, (message) =>
        logger.warn(message),
    )
    const activeLogger = new Logger(config.debug, logFilePath())
    if (isSecureMode()) configureClientAuth(ctx.client)
    const store = createStateStore(ctx.directory, { logger: activeLogger })
    const engine = new ReplayWarmer(ctx.client, config, store, activeLogger, ctx.directory)
    engine.start()

    const version = typeof __KEEPALIVE_VERSION__ !== "undefined" ? __KEEPALIVE_VERSION__ : "dev"
    logger.info(`v${version} ready`)

    return {
        event: async ({ event }) => {
            engine.onEvent(event)
        },

        dispose: async () => {
            engine.dispose()
            await store.dispose()
        },
    }
}

export default server
