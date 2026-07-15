# opencode-cache-keepalive

OpenCode plugin that keeps provider prompt caches warm by sending invisible keepalive pings, with a live TUI readout.

## Architecture

### Entry Points

- `index.ts` — Server plugin entry. Creates config, store, engine, registers hooks (`event`, `experimental.chat.system.transform`, `tool.execute.before`, `dispose`).
- `tui.tsx` — TUI plugin entry. Registers commands (`keepalive-toggle/on/off`) and `sidebar_footer` slot with `KeepaliveFooter`.

### Core Packages (lib/)

- `keepalive.ts` — `KeepaliveEngine`: timer-driven ping scheduler. Lifecycle: real turn finishes → `session.idle` → arm warm window → fire pings with `~` token → optionally revert ping turn.
- `state.ts` — `KeepaliveStore`: in-memory per-session state + atomic JSON persistence to disk for TUI.
- `config.ts` — `getConfig()` merges plugin options + env vars. Defaults: 4.5min interval, 55min window.
- `control.ts` — Runtime on/off toggle via `control.json` (read by server, written by TUI).
- `paths.ts` — File paths under `~/.local/share/opencode/storage/plugin/keepalive/`.
- `auth.ts` — Basic auth interceptor for `OPENCODE_SERVER_PASSWORD` secure mode.
- `model.ts` — `isEligibleModel()` checks provider/model against allowlists (default: copilot + claude/anthropic/gpt).
- `logger.ts` — Simple console logger with debug/info/warn/error levels.
- `system.ts` — `keepaliveInstruction()` returns stable system prompt instruction telling model to reply `~` to `~` pings.

### TUI Packages (lib/tui/)

- `footer.tsx` — `KeepaliveFooter` SolidJS component. Polls state file every 1s, shows idle time, pings sent/left, last ping hit/miss.
- `commands.ts` — `registerKeepaliveCommands()` registers keymap commands for toggling keepalive.
- `format.ts` — `mmss()` (duration) and `kfmt()` (token count) formatters.

## Key Concepts

- **Ping token**: `~` (configurable). Sent as a user message; model replies with `~` (single token).
- **Revert ping**: After measuring cache usage, the synthetic `~`/`~` turn is deleted from session history.
- **Warm window**: After a real turn, pings fire every `intervalMs` (default 4.5min) for `windowMs` (default 55min).
- **Cache hit detection**: Reads `tokens.cache.read` from the prompt response; a hit means the prefix was still cached.
- **Cross-process state**: Server plugin writes JSON snapshots to disk; TUI plugin reads them for live readout.

## Build

- `npm run build` — tsup bundles `index.ts` and `tui.tsx` to `dist/`.
- `npm run dev` — `opencode plugin dev` for live development.
