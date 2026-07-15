# Conventions

- Prettier: 4 spaces, double quotes, no semicolons, trailing commas, 100-char print width, always-parenthesized arrow parameters.
- Use TypeScript strict mode and ESM imports.
- Keep server logic in `lib/`; TUI specifics in `lib/tui/`.
- Cross-runtime server↔TUI coordination is file-backed state/control; preserve atomic state-write behavior and versioned control protocol.