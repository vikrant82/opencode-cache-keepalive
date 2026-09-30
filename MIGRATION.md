# 0.2.0 migration and release notes

> These notes describe the 0.2.0 package contents prepared for release. They do not imply that the package has been published, nor validated savings or provider cache TTLs.

## What changes

The prior synthetic `~` ping approach is replaced with replay of the latest eligible real model request. The request is sent through the original `fetch` unchanged and may be retained only in process memory for replay. Replays stop at API-specific SSE checkpoints, rather than completing a generated response. No request URL, headers, body, credentials, or conversation text are persisted.

The wrapper observes calls to global `fetch`, then forwards them to the original `fetch` with the same arguments and returns its result. It records only requests that pass eligibility checks; unrelated global traffic is forwarded unchanged. Replay payload capture is limited to POSTs at allowed host suffixes and supported API paths ending in `/v1/messages`, `/v1/responses` or `/responses`, or `/chat/completions`, with a recognized session ID (`X-Session-Id`, `x-session-affinity`, or `X-Interaction-Id`), a JSON request body, and a model containing an `intervals` key. The default host suffix is `githubcopilot.com`; default model substrings are `claude` (285,000 ms) and `gpt` (1,680,000 ms). First matching interval key wins, case-insensitively. Child sessions are excluded unless `includeChildSessions` is enabled. These are code eligibility rules, not a claim of provider-wide support.

An observed request for an enabled session on an allowed host begins a replay gap and resets its successful replay count; only eligible POSTs on supported paths become replay payloads. A successful replay is capped by `maxReplaysPerGap`; `"auto"` calculates `floor((missFactor - cacheReadFactor) / cacheReadFactor)` (9 at defaults). This is a configurable input-cost estimate, not verified provider pricing or net savings. The displayed avoided cache-write tokens are gross; refresh cached-read tokens are separate usage and gross display values do not subtract that cost. Token usage may be API-specific or unavailable. No universal replay expiry is promised: stop/lapse conditions include a fresh real request, reaching the cap, HTTP rejection, a Messages cache-creation-only replay, retry exhaustion, session disablement, or request-payload eviction at the in-memory storage budget. Network/timeout/other non-OK failures retry once after 10 seconds, then lapse; HTTP 400/401/403 stop immediately. The default replay timeout is 60 seconds and `maxStoredBytes` defaults to 67,108,864 bytes (64 MiB).

Session `/keepalive-on`, `/keepalive-off`, and `/keepalive-toggle` are runtime controls. The global `enabled` option remains the master switch. Disabling clears the saved request payload; re-enabling does not recover it, so a fresh eligible real request is required. Per-session controls use `control-<directory-hash>.json` under OpenCode's plugin storage directory and expire after 30 days. Version 1 folder-wide controls are ignored. Version 2 state snapshots hold telemetry/process totals, not replay payloads; state files are associated with a process and stale-process cleanup, while `server.log` may contain session IDs, model/API/host/path, replay status/latency, and token-usage metadata.

## Option changes

Plugin options explicitly supplied in `opencode.json` take precedence over matching environment variables; environment values otherwise override defaults. These old options are ignored with deprecation warnings:

- `intervalMs` / `intervalSeconds` → configure `intervals` (model substring to milliseconds).
- `windowMs` / `windowMinutes` → no universal warm-window setting; warming follows the gap, cap, stop, and lapse rules above.
- `providerAllowlist` / `modelAllowlist` → configure `hosts` / `intervals`.
- `revertPing`, `pingToken`, `injectSystemInstruction`, `claudeBusyWarm`, `claudeBusyWarmIntervalMs`, `claudeBusyWarmWindowMs` → removed with synthetic pings.
- `/keepalive-interval` → removed; configure `intervals` before startup.

Existing runtime control files with version 1 folder-level `enabled` values are ignored; they are not migrated. State v1 files are ignored and not deleted by v2 cleanup. Back up any settings you need, configure the new options, and use session controls as desired.

## Loading and updating

The package exposes a server entry (`.` / `./server`) and a separate TUI module (`./tui`). The loader contract is source-verified against OpenCode v1.18.33: `opencode.json` loads server plugins, `tui.json`/`tui.jsonc` loads TUI plugins, and package `./server` or `./tui` exports are selected by plugin kind. The plugin config accepts a package string or `[package, options]`; options belong in the server registration. See [TUI configuration docs](https://opencode.ai/docs/tui/), [server config schema](https://opencode.ai/config.json), [TUI config schema](https://opencode.ai/tui.json), and [v1.18.33 plugin loader source](https://github.com/anomalyco/opencode/tree/v1.18.33/packages/opencode/src/plugin). This source verification does not establish live plugin integration.

After 0.2.0 is published, register the same pinned package specifier (`@vikrant82/opencode-cache-keepalive@0.2.0`) in both files; the specifier is available only after publication. For local development, `opencode.json` can use `./dist/index.js`, while `tui.json` can use `./tui.tsx` relative to that config file; the package's `./tui` export intentionally targets TypeScript source, not an emitted JavaScript bundle.

The v1.18.33 source contract supports the README's server plugin-options tuple. It differs from the installed SDK declaration previously inspected (`Config.plugin: string[]`); the source-tagged OpenCode schema and loader are the basis for this documentation.

The previously stated OpenCode `>=1.4.3` peer baseline and Node `>=18` README baseline are not validated support ranges (`package.json` has no Node `engines` field). The observed check environment was Node 22.22.3, OpenCode 1.18.33, `@opencode-ai/plugin` 1.17.16, and `@opencode-ai/sdk` 1.17.16; live integration remains untested.

After 0.2.0 is published, an installation update can be pinned explicitly, for example:

```bash
npm install @vikrant82/opencode-cache-keepalive@0.2.0
```

This is an example for use only after publication; it does not assert that publication has occurred. Package metadata in this source tree is prepared as 0.2.0.

## Uncompleted release checklist

- [x] Verify separate server/TUI loading contract from OpenCode v1.18.33 source and published config documentation.
- [ ] **Accepted/deferred risk:** live footer visibility and session toggles were observed by the human, but final isolated-build loading/integration was not established. Loader contract verification alone does not confirm plugin integration.
- [x] **Review finding — Request body capture:** fixed by synchronously cloning eligible `Request` bodies before forwarding and verified with a consuming-transport replay regression.
- [x] **Review finding — multi-instance routing:** fixed by selecting unknown-session owners against host/model eligibility and keeping known ownership authoritative; disjoint-host, overlapping-config, and disabled-owner regressions pass.
- [x] **Request stream rejection after immediate disposal:** attached an immediate rejection observer while preserving rejection for recorder error handling; focused stream-error regression passes.
- [ ] Verify migration behavior and config precedence in the release package, including ignored legacy options and v1 control/state files.
- [ ] Review privacy boundaries in persisted state and logs for the release build.
- [ ] Validate replay lifecycle, API checkpoints, rejection/retry behavior, storage cap, and cost/usage reporting against intended supported environments; do not claim TTL, savings, or provider support without evidence.
- [x] Prepare package metadata and lockfile for 0.2.0 and include `MIGRATION.md` in package files; publication remains a separate delivery action.
- [ ] In a dedicated disposable TTY session, smoke-test idle/tool-busy replay and active-model suppression; cap, rejection, and restart behavior; absence of synthetic conversation turns; sanitized state files and logs. Final isolated-build loading was not established; retain the accepted/deferred live UI integration risk until verified.
- [ ] After publication, verify the published archive/version; no publication is performed here.
