# opencode-cache-keepalive

[![npm version](https://img.shields.io/npm/v/@vikrant82/opencode-cache-keepalive.svg)](https://www.npmjs.com/package/@vikrant82/opencode-cache-keepalive)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](./LICENSE)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-purple.svg)](https://github.com/opencode-ai/plugin)

Replay the last real model request to keep supported prompt caches warm during idle and tool-busy gaps.

## Why This Exists

- Prompt caches expire after provider-specific inactivity windows; a later turn can pay full input cost
- A global `fetch` wrapper passes every request to the original `fetch` unchanged; it only records eligible requests for later replay
- Replays are bounded per gap by a break-even cost cap; ordinary real requests are not delayed, rewritten, or replaced

## Features

- **Idle and tool-busy warming**: refreshes the current session's replayed cache without adding conversation turns
- **Live TUI footer**: cache state, next refresh, refresh count, gross avoided cache-write tokens, and resume hit ratio
- **Privacy-first persistence**: session telemetry only; request URL, headers, body, credentials, and conversation text are not stored
- **Runtime toggle**: `/keepalive-toggle`, `/keepalive-on`, `/keepalive-off` slash commands
- **Per-model timing**: Claude and GPT model substrings have configurable intervals; allowed host suffixes limit eligible capture

## Installation

```bash
npm install @vikrant82/opencode-cache-keepalive
```

Register the server plugin in `opencode.json`:

```json
{
    "plugin": ["@vikrant82/opencode-cache-keepalive"]
}
```

Register the same package in `tui.json` to load its separate TUI entry:

```json
{
    "plugin": ["@vikrant82/opencode-cache-keepalive"]
}
```

OpenCode's v1.18.33 loader reads plugin lists from these separate config files and resolves package `./server` and `./tui` exports by plugin kind. When installing the published 0.2.0 release, use the same pinned package specifier in both files; availability depends on publication.

### Local Development

To use a locally built version during development:

```json
{
    "plugin": ["./dist/index.js"]
}
```

In `tui.json`, load the source TUI entry separately:

```json
{
    "plugin": ["./tui.tsx"]
}
```

Paths are relative to the declaring config file. Run `npm run build` for the server bundle, then restart OpenCode; `./tui` is intentionally exported as TypeScript source for the TUI loader, not an emitted `dist/tui.js` file.

## Configuration

Options can be set in the plugin options in `opencode.json` or with the listed environment variables. An explicitly provided plugin option takes precedence over its environment variable; otherwise the environment variable overrides the default.

```json
{
    "plugin": [
        [
            "@vikrant82/opencode-cache-keepalive",
            {
                "intervals": { "claude": 285000, "gpt": 1680000 },
                "hosts": ["githubcopilot.com"],
                "debug": true
            }
        ]
    ]
}
```

The tuple-with-options form is supported by OpenCode's v1.18.33 plugin config schema (`string` or `[package, options]`). The options example applies to the server plugin configuration in `opencode.json`.

| Option                 | Default                       | Env Var                                     | Description                                                                   |
| ---------------------- | ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `enabled`              | `true`                        | `OPENCODE_KEEPALIVE_ENABLED`                | Master switch.                                                                |
| `intervals`            | `{claude:285000,gpt:1680000}` | `OPENCODE_KEEPALIVE_INTERVALS`              | Milliseconds per matching model substring; first case-insensitive match wins. |
| `hosts`                | `["githubcopilot.com"]`       | `OPENCODE_KEEPALIVE_HOSTS`                  | Allowed hostname suffixes.                                                    |
| `cacheReadFactor`      | `0.1`                         | `OPENCODE_KEEPALIVE_CACHE_READ_FACTOR`      | Relative cost of cached input.                                                |
| `missFactor`           | `1.0`                         | `OPENCODE_KEEPALIVE_MISS_FACTOR`            | Relative cost of uncached input.                                              |
| `maxReplaysPerGap`     | `"auto"` (9)                  | `OPENCODE_KEEPALIVE_MAX_REPLAYS_PER_GAP`    | Auto cap is `floor((missFactor-cacheReadFactor)/cacheReadFactor)`.            |
| `includeChildSessions` | `false`                       | `OPENCODE_KEEPALIVE_INCLUDE_CHILD_SESSIONS` | Include child sessions.                                                       |
| `replayTimeoutMs`      | `60000`                       | `OPENCODE_KEEPALIVE_REPLAY_TIMEOUT_MS`      | Maximum time for one replay attempt.                                          |
| `maxStoredBytes`       | `67108864` (64 MiB)           | `OPENCODE_KEEPALIVE_MAX_STORED_BYTES`       | Maximum in-memory request-body storage for replay targets.                    |
| `debug`                | `false`                       | `OPENCODE_KEEPALIVE_DEBUG`                  | Verbose server log output.                                                    |

## TUI Integration

The package contains separate server and TUI entries. Source-verified against OpenCode v1.18.33: server plugins load from `opencode.json`; TUI plugins load from `tui.json` (or `tui.jsonc`) using the package's `./tui` export. See the [TUI configuration docs](https://opencode.ai/docs/tui/), [server config schema](https://opencode.ai/config.json), [TUI config schema](https://opencode.ai/tui.json), and [v1.18.33 plugin loader source](https://github.com/anomalyco/opencode/tree/v1.18.33/packages/opencode/src/plugin). The human has observed the footer and commands in a live UI; loading the final isolated build and its UI integration were not established, so treat that integration as an open release risk.

When loaded, the sidebar footer is hidden until a session has a persisted replay entry. It reports:

```
keepalive idle · 2/9 · next 4:45
refreshes 2 · hits 1/1 · saved ~49k tok
```

Metrics:

- **state**: `keepalive standby · model working`, `keepalive idle/busy`, a refresh stop/expiry reason, or `keepalive off`
- **refresh**: Time until next refresh, or successful refresh count in the current gap
- **metrics**: Session refresh count, resume hits/count when available, and gross cache-write tokens avoided. “Saved” is gross and does not subtract refresh cost; replay cache-read token usage is logged in `server.log` as `cacheRead` when the API exposes it, and resume accounting logs `replayRead`.

Slash commands (available in TUI palette):

- `/keepalive-toggle` — Toggle keepalive for the current session only
- `/keepalive-on` — Enable keepalive for the current session
- `/keepalive-off` — Disable keepalive for the current session

Runtime overrides are stored by session in the project's `control-<directory-hash>.json` file. `/keepalive-off` aborts scheduled/in-flight replays and discards the in-memory replay payload. `/keepalive-on` permits future capture but does not restore that payload: make a fresh eligible real request to resume warming. Legacy folder-wide version 1 `enabled` values are ignored; the config `enabled` option remains the global master switch. Child sessions are excluded unless `includeChildSessions` is enabled.

## How It Works

1. A request passes through the wrapper to the original `fetch` unchanged. An eligible request is a POST to a configured host suffix and supported API path, with a session ID and a model matching an `intervals` key; child sessions are excluded by default. Supported path suffixes are `/v1/messages`, `/v1/responses` or `/responses`, and `/chat/completions` (optional trailing slash).
2. During idle or tool-busy gaps, the engine replays the current session request at its model's interval. It aborts after an API-specific SSE checkpoint: Messages `message_start`, Responses' first event other than `response.created`/`response.in_progress`, or the first Chat Completions chunk.
3. A new real request starts a gap and resets its replay counter; actual eligible requests replace the saved payload. Successful replays stop at the auto (or numeric) cap. Network errors, timeouts, and other non-OK statuses get one retry after 10 seconds, then lapse; HTTP 400/401/403 reject and stop immediately. For Messages, a replay reporting zero cache-read and positive cache-creation tokens lapses that session. These are event/status-driven stops, not a universal TTL; the footer's “cache expired” label indicates a lapse, not a measured provider TTL.
4. The next real completion for that session reports whether the cache hit; “saved” counts gross cache-write tokens avoided (prompt tokens on a hit, zero on a miss). Refresh cache-read cost is reported separately in `server.log` as `replayRead`.
5. The server writes sanitized v2 per-process telemetry files; payloads (including URL, headers, and body) remain only in memory. The TUI reads the freshest session entry and polls every second. Process state files are cleaned up with their process lifecycle/stale-process cleanup; session control overrides are separately persisted and ignored after 30 days.

### Cost model and cache cap

With cached reads costing `cacheReadFactor` and a full miss costing `missFactor`, the automatic replay cap is `floor((missFactor - cacheReadFactor) / cacheReadFactor)`. At defaults, one full-cache miss costs 1.0 input units, a cached read costs 0.1, and the maximum is 9 successful replays per gap. The estimate is an input-token-equivalent comparison, not a billing guarantee; provider pricing and cache-write rules can differ.

### Privacy and upgrade notes

The replay request (including its URL, headers, and body) is held only in process memory and is never written to disk. State files contain session telemetry and process totals; `server.log` can contain session IDs, model/API/host/path, replay outcomes/status/latency, and token-usage metadata, but not request bodies, credentials, or conversation text. Legacy/v1 state files are ignored and not removed by v2 cleanup. Version 0.2.0 removes synthetic `~` messages and their system prompt instruction. This is a breaking behavior change: old `intervalMs`/`intervalSeconds`, `windowMs`/`windowMinutes`, `revertPing`, `pingToken`, `injectSystemInstruction`, provider/model allowlists, and Claude busy-warm options are ignored with warnings; runtime `/keepalive-interval` is removed. Configure `intervals` and `hosts` instead. See [MIGRATION.md](./MIGRATION.md) for migration notes and release checks.

## Compatibility

- **Previously stated/declared baseline, not tested support range**: OpenCode >=1.4.3 (peer dependency); Node >=18 was previously stated but `package.json` has no `engines` field. This checkout's observed environment was Node 22.22.3, OpenCode 1.18.33, `@opencode-ai/plugin` 1.17.16, and `@opencode-ai/sdk` 1.17.16. Live plugin/TUI integration is untested, and compatibility across the declared ranges has not been validated.
- **Supported hosts by default**: `githubcopilot.com` and its subdomains; configure other allowed host suffixes explicitly
- **Supported API paths**: `/v1/messages`, `/v1/responses` or `/responses`, and `/chat/completions`
- **Eligible models**: request model string must contain a configured `intervals` key; defaults are `claude` and `gpt` (case-insensitive, first matching key wins)

## Development

```bash
npm run dev        # Live development with opencode plugin dev
npm run build      # Bundle with tsup
npm run typecheck  # Type-check without emit
npm run format     # Format with Prettier
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
