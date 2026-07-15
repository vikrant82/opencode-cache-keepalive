# Keepalive Architecture

- `index.ts`: OpenCode server `Plugin`; creates config/logger/store/engine and wires event, system-transform, tool prehook, dispose.
- `lib/keepalive.ts`: per-session state machine. Eligible idle sessions are armed; 15s tick sends prompt token, classifies usage cache hit, reverts ping turns. Also polls control (1s) and session status.
- `lib/state.ts`: in-memory session map + atomic JSON state snapshot for TUI.
- `tui.tsx` + `lib/tui/*`: separate TUI runtime; footer polls state JSON and palette commands alter a control JSON. No direct server/TUI process communication.
- Shared storage paths are directory-hashed under OpenCode plugin storage (`lib/paths.ts`).
- System transform injects an invariant byte-stable instruction into eligible real and ping requests so their cacheable system prefix matches. Tool execution is blocked while engine is warming.
- Keepalive pings must not remain in user-visible history: engine attempts session revert after prompt. Concurrency/API response-shape fallbacks are areas needing careful validation.
- Eligibility and user controls: `lib/model.ts`, `lib/config.ts`, `lib/control.ts`; secure client auth wrapper: `lib/auth.ts`.