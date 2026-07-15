/**
 * When opencode runs with `OPENCODE_SERVER_PASSWORD`, the local HTTP API requires
 * Basic auth. The SDK client handed to plugins does not carry it automatically,
 * so we attach an interceptor. No-op when the server is not password protected.
 *
 * Same approach as opencode-dynamic-context-pruning's auth helper.
 */
export function isSecureMode(): boolean {
    return !!process.env.OPENCODE_SERVER_PASSWORD
}

export function getAuthorizationHeader(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (!password) return undefined
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    const credentials = Buffer.from(`${username}:${password}`).toString("base64")
    return `Basic ${credentials}`
}

export function configureClientAuth(client: any): void {
    const header = getAuthorizationHeader()
    if (!header) return

    const inner = client?._client ?? client?.client
    if (!inner?.interceptors?.request) return

    inner.interceptors.request.use((request: Request) => {
        if (!request.headers.has("Authorization")) {
            request.headers.set("Authorization", header)
        }
        return request
    })
}
