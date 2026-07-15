/**
 * Stable keepalive instruction appended to the system prompt.
 *
 * IMPORTANT: this text must be byte-stable and applied to *every* request for an
 * eligible model (real turns and pings alike). If it were only added on pings, the
 * system prefix would differ from real turns and the ping would miss the cache.
 * Adding it consistently keeps the cached prefix identical and lets the model
 * answer a ping with a single token instead of a paragraph or a tool call.
 */
export function keepaliveInstruction(pingToken: string): string {
    return [
        "<cache_keepalive>",
        `A user message consisting of exactly the single token "${pingToken}" is an`,
        "automated cache-keepalive ping, not a real request. When you receive it,",
        `reply with exactly "${pingToken}" and nothing else. Do not call any tools,`,
        "do not explain, and do not take any action.",
        "</cache_keepalive>",
    ].join("\n")
}
