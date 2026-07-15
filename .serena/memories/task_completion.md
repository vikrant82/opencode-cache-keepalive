# Task Completion

Run the narrowest relevant checks, normally:

1. `npm run typecheck`
2. `npm run format:check`
3. `npm run build` when packaging/entrypoints/declarations change.

No automated test script or test suite was present during onboarding; manually validate behavior in an OpenCode plugin host when changing ping lifecycle, SDK calls, system injection, or TUI IPC.
