import type { KeepaliveConfig } from "./config"

/**
 * Warming only helps on providers that do prefix caching we can refresh by
 * replaying the prefix. Supported defaults include Claude and GPT models served
 * through GitHub Copilot. Everything else is skipped.
 */
export function isEligibleModel(
    config: KeepaliveConfig,
    providerID: string | undefined,
    modelID: string | undefined,
): boolean {
    if (!providerID || !modelID) return false
    const provider = providerID.toLowerCase()
    const model = modelID.toLowerCase()
    const providerOk = config.providerAllowlist.some((needle) => provider.includes(needle))
    const modelOk = config.modelAllowlist.some((needle) => model.includes(needle))
    return providerOk && modelOk
}
