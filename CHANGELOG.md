# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); this project uses semver.

## [Unreleased]

### Added
- **Agent autonomy** — `auto_debug` (one-call investigation → call map + diagnosis
  + verdict) and `analyze_state` (diagnosis of a recorded trace); `inferState()`
  detects exceptions, N+1, DB fan-out, silent state clears, and heap-without-reclaim.
- **Call Map** — method-grouped controller→service→DB view with data-in/out,
  loop ×N, N+1 badges, mutation diffs, heap sparkline; nested + columns layouts.
- **Agent session lifecycle** — `start_debug_session`, `stop_debug_session`,
  `restart_debug_session` (no human F5 needed).
- **Safety (Phase A):** secret redaction by default; least-privilege reads
  (`list_variable_names` / `get_variable_values`); propose-then-confirm on every
  live mutation; audit log (`get_audit_log`); fail-closed mocking (`strictMocks`).
- **Entitlements layer** — feature/tier flags (`src/entitlements.ts`) as the
  open-core paywall foundation; nothing gated yet.
- **Content-addressed breakpoints** — address by statement text or function name,
  resolved to a line at apply time so edits above don't invalidate them.
- **Real boundary-mock injection** — `dbMode: mocked` monkey-patches the target
  method via DAP evaluate (was previously a no-op).
- **UX** — unified scrollable value viewer, per-call trace tabs, request/response
  bookends, paste-a-curl, categorised breakpoints, precondition empty states,
  in-panel Help drawer, "New window" button, copy-with-feedback.
- **Docs** — AGENT_AUTOMATION, ROADMAP, SECURITY, CONTRIBUTING,
  MAINTAINING; headless demo/screenshot harness.

### Fixed
- New-window "Loading…" hang (`ready` was a no-op).
- Scenario edits lost on reload (`saveScenario` was dead).
- Stale-capture reads (added session identity + `live`/`stale` reporting).
- Copy buttons failing silently in the webview (added execCommand fallback + feedback).

### Security
- MCP server kept zero-dependency (smallest exposed surface).
- Redaction applied before any value is written to disk.

### Known gaps
- Python adapter (B1) documented but not yet verified against a live debugpy session.
- Phase C (FlowTrace, behavioral diff, contracts, experiments, CI runner) not yet built.
