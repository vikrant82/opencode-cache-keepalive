# Tech Stack

- TypeScript, strict mode, ESM; ES2022 target / ES2023 lib; bundler resolution.
- OpenCode plugin API `@opencode-ai/plugin` >=1.4.3; SDK `@opencode-ai/sdk` ^1.4.3.
- TUI: Solid ^1.9.12 with OpenTUI core/solid ^0.4.2.
- Build: tsup ^8.5.1 bundles `index.ts` to ESM; `tsc --emitDeclarationOnly` emits declarations. `tui.tsx` ships as source export.
- Package manager evidenced by `package-lock.json`: npm.
