# Contributing

Thanks for helping. This is a VS Code extension (host, `src/`, Node/TS) + a React
webview (`webview-ui/`) + a zero-dep MCP server (`mcp/`).

## Dev setup

```bash
npm install
npm run build      # webview (Vite) then host (tsc)
npm test           # host-logic + call-tree + safety suites
```

## The gates (must be green before a PR)

- `npm run compile` — host TypeScript, 0 errors.
- `npm run build --prefix webview-ui` — webview build, 0 errors.
- `cd webview-ui && npx oxlint src` — **0 warnings, 0 errors**.
- `npm test` — all suites pass.
- `npm run lint:boundaries` — public core stays self-contained and strategy-free.

CI should run all of these. A PR that reduces coverage of `src/redact.ts`,
`src/entitlements.ts`, or `callTree.ts` needs new tests.

## Architecture map

| Path | Role |
|------|------|
| `src/extension.ts` | Host entry: DAP capture, scenario run, mock injection, message routing. |
| `src/pauseBridge.ts` | Agent-readable pause channel + command execution (continue/step/setVar/evaluate/session lifecycle), audit log. |
| `src/breakpointManager.ts` | Owns only the breakpoints it sets; content-addressed resolution. |
| `src/redact.ts` | Secret redaction (pure, tested). |
| `src/entitlements.ts` / `licenseService.ts` | Feature-flag mechanism (the tier map is injected at runtime, not defined here). |
| `webview-ui/src/App.tsx` | Panel: scenario runner, inspector, breakpoints, mocks. |
| `webview-ui/src/CallMap.tsx` / `callTree.ts` | Call Map view + async-resilient tree builder. |
| `mcp/flow-mcp.mjs` | MCP server (agent tools). |
| `mcp/callmap.mjs` | Zero-dep tree/diagnosis port for out-of-process use. |

## Adding a feature safely

1. If it's gateable, add a `Feature` name in `src/entitlements.ts` — never inline a
   flag string. Do **not** assign it a tier here; tiers are injected at runtime.
2. If it surfaces runtime values, route them through `redact.ts`.
3. If it mutates the debuggee, go through propose-then-confirm and call
   `pauseBridge.audit(...)`.
4. Add a test to the matching suite in `verify/`.
5. Update the relevant doc (`AGENT_AUTOMATION.md` for a new MCP tool).

## Adding a language

Everything is DAP-generic; a new language is mostly a debug adapter + a
memory-probe expression in `sampleMemory` (see the Node/Python cases). Verify
breakpoints bind, `stopped` capture, scopes, and a Call Map build against a real
session, and add a sample + test.

## Commit / PR conventions

- One logical change per PR; keep diffs reviewable.
- Describe the change in plain terms in the PR description.
- Never commit secrets, `.vsix` artifacts, or `.flow-debugger/` runtime output
  (they're git-ignored).
