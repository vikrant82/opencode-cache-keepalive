# opencode-cache-keepalive

[![npm version](https://img.shields.io/npm/v/@vikrant82/opencode-cache-keepalive.svg)](https://www.npmjs.com/package/@vikrant82/opencode-cache-keepalive)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](./LICENSE)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-Plugin-purple.svg)](https://github.com/opencode-ai/plugin)

Keep LLM prompt caches warm during idle periods with invisible pings and a live TUI readout.

## Why This Exists

- Provider prompt caches (Copilot, Anthropic, etc.) expire after ~5-60 minutes of inactivity
- Next turn pays full input token cost + latency penalty on cache miss
- This plugin sends minimal `~` pings during idle windows to keep the cached prefix alive at negligible cost

## Features

- **Automatic warm window**: arms after real turns, expires after configurable window (default 55min)
- **Live TUI footer**: idle time, pings sent/left, last ping cache hit/miss with token counts
- **Synthetic ping reversion**: removes `~`/`~` turns from conversation history
- **Runtime toggle**: `/keepalive-toggle`, `/keepalive-on`, `/keepalive-off` slash commands
- **Secure mode support**: works with `OPENCODE_SERVER_PASSWORD`
- **Configurable provider/model allowlists**

## Installation

```bash
npm install @vikrant82/opencode-cache-keepalive
```

Register in your `opencode.json`:

```json
{
    "plugin": ["@vikrant82/opencode-cache-keepalive"]
}
```

### Local Development

To use a locally built version during development:

```json
{
    "plugin": ["./dist/index.js"]
}
```

Run `npm run build` first, then restart opencode. Rebuild and restart after code changes.

## Configuration

All options can be set via plugin config in `opencode.json` or environment variables. Env vars take precedence.

```json
{
    "plugin": [
        [
            "@vikrant82/opencode-cache-keepalive",
            {
                "intervalMs": 300000,
                "windowMs": 3600000,
                "providerAllowlist": ["copilot", "anthropic"],
                "debug": true
            }
        ]
    ]
}
```

| Option                    | Default                                                | Env Var                          | Description                                                       |
| ------------------------- | ------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------- |
| `enabled`                 | `true`                                                 | `OPENCODE_KEEPALIVE_ENABLED`     | Master switch. When false, no timers or hooks are registered.     |
| `intervalMs`              | `270000` (4.5min)                                      | `OPENCODE_KEEPALIVE_INTERVAL_MS` | Milliseconds between pings. Must stay under provider cache TTL.   |
| `windowMs`                | `3300000` (55min)                                      | `OPENCODE_KEEPALIVE_WINDOW_MS`   | How long to keep warming after last real response.                |
| `pingToken`               | `"~"`                                                  | —                                | Single token sent as user message; model replies with same token. |
| `revertPing`              | `true`                                                 | `OPENCODE_KEEPALIVE_REVERT_PING` | Remove synthetic ping turns from session history.                 |
| `injectSystemInstruction` | `true`                                                 | —                                | Append stable instruction so model answers `~` with single token. |
| `includeChildSessions`    | `false`                                                | —                                | Warm subagent/child sessions too. Off by default.                 |
| `debug`                   | `false`                                                | `OPENCODE_KEEPALIVE_DEBUG`       | Enable verbose logging to server.log.                             |
| `providerAllowlist`       | `["copilot"]`                                          | —                                | Provider ID substrings eligible for warming.                      |
| `modelAllowlist`          | `["claude","anthropic","sonnet","opus","haiku","gpt"]` | —                                | Model ID substrings eligible for warming.                         |

## TUI Integration

The plugin registers a sidebar footer showing live keepalive status:

```
keepalive armed
idle 03:42 · sent 2 · left 10
✓ hit input 12.4k · read 11.8k · write 0
```

Metrics:

- **idle**: Time since last real assistant response
- **sent**: Ping attempts in current warm window (includes failures)
- **left**: Estimated pings remaining before window expires
- **hit/miss**: Cache hit status of last ping with token breakdown

Slash commands (available in TUI palette):

- `/keepalive-toggle` — Toggle keepalive on/off at runtime
- `/keepalive-on` — Enable keepalive
- `/keepalive-off` — Disable keepalive

## How It Works

1. Real turn completes → `session.idle` event → engine arms warm window
2. Every `intervalMs` (with ±15s jitter), engine sends `~` as user message
3. Model replies with `~` (single token); engine reads `tokens.cache.read` to detect hit
4. Synthetic `~`/`~` turn is reverted from session history (if `revertPing` enabled)
5. Window closes after `windowMs` or when a new real turn starts
6. Server plugin persists state to disk; TUI plugin polls it every 1s for live readout

## Compatibility

- **OpenCode**: >=1.4.3
- **Node**: >=18 (ESM)
- **Supported providers**: Copilot (default), Anthropic, OpenAI (via allowlists)
- **Models**: Claude, GPT families (via allowlists)

## Development

```bash
npm run dev        # Live development with opencode plugin dev
npm run build      # Bundle with tsup
npm run typecheck  # Type-check without emit
npm run format     # Format with Prettier
```

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
