# Working guidelines for agents in this repository

This document is the operating contract for any automated contributor (AI agent
or script) working in this repo. Follow it exactly. It covers conventions,
workflow, and boundaries. Read it before your first change.

## Scope of this repository

This is the **public core**: the VS Code extension host (`src/`), the React
webview (`webview-ui/`), the MCP server (`mcp/`), and the CLI collector (`cli/`).
Everything in this repo is MIT-licensed and public. Work only within these
directories.

## Golden rules

1. **Stay in-repo.** Do not add a dependency on, import from, or reference any
   package, path, or service that is not present in this repository. If a task
   seems to need code that isn't here, stop and report it — do not invent a
   path or pull from an external org namespace.
2. **One logical change per PR.** Keep diffs small and reviewable.
3. **Never commit** secrets, `.vsix` build artifacts, `.flow-debugger/` runtime
   output, or anything under a path marked private in `.gitignore`.
4. **All gates green before a PR** (below). CI enforces them; a red gate is a
   hard stop, not a thing to work around.
5. **Do not disable, weaken, or route around a lint rule, CI check, or
   `CODEOWNERS` rule** to make a change pass. If a rule blocks you, the change
   is wrong, not the rule.

## Dev setup

```bash
npm install
npm run build      # webview (Vite) then host (tsc)
npm test           # host-logic, call-tree, safety suites
```

## The gates (must be green before any PR)

- `npm run compile` — host TypeScript, 0 errors.
- `npm run build --prefix webview-ui` — webview build, 0 errors.
- `cd webview-ui && npx oxlint src` — 0 warnings, 0 errors.
- `npm test` — all suites pass.
- `npm run lint:boundaries` — import-boundary + naming checks (see below).

A PR that reduces test coverage of `src/redact.ts`, `src/entitlements.ts`, or
`webview-ui/src/callTree.ts` must add tests.

## Architecture map

| Path | Role |
|------|------|
| `src/extension.ts` | Host entry: capture, scenario run, mock injection, routing. |
| `src/pauseBridge.ts` | Agent-readable pause channel + command execution, audit log. |
| `src/breakpointManager.ts` | Owns only the breakpoints it sets. |
| `src/redact.ts` | Secret redaction (pure, tested). |
| `src/entitlements.ts` / `licenseService.ts` | Capability-flag mechanism. |
| `webview-ui/src/App.tsx` | Panel: scenario runner, inspector, breakpoints, mocks. |
| `webview-ui/src/CallMap.tsx` / `callTree.ts` | Call Map view + tree builder. |
| `mcp/flow-mcp.mjs` / `mcp/callmap.mjs` | MCP server + zero-dep tree port. |

## Adding a feature

1. If the capability can be turned on or off, register a `Feature` in
   `src/entitlements.ts` and gate it with `isEnabled(feature, tier)` /
   `gate(...)`. **Never inline a flag string**, and **do not add tier
   assignments, pricing values, or feature-roadmap identifiers in this repo** —
   the mechanism lives here; its configuration is supplied at runtime.
2. If the feature surfaces runtime values, route them through `redact.ts`.
3. If it mutates the debuggee, use propose-then-confirm and call
   `pauseBridge.audit(...)`.
4. Add a test to the matching suite in `verify/`.
5. Update the relevant doc (`docs/AGENT_AUTOMATION.md` for a new MCP tool).

## Adding a language

Everything is DAP-generic: a new language is mostly a debug adapter + a
memory-probe expression in `sampleMemory`. Verify breakpoints bind, `stopped`
capture, scopes, and a Call Map build against a real session; add a sample + test.

## Boundaries (hard rules, CI-enforced)

- **Import boundary.** This repo must not import from any path outside its own
  `src/`, `webview-ui/`, `mcp/`, `cli/` trees, nor from any external
  organisation package namespace. `npm run lint:boundaries` fails the build on a
  violation.
- **No configuration-as-data in code.** Capability flags are declared here;
  their *values* (which tier, which plan, which rollout) are injected at runtime
  via the license/config object, never hard-coded. Do not add a map of
  feature→plan or any roadmap/milestone codename to this repo.
- **No secrets, ever.** Pre-commit and CI scan for credentials. A detected
  secret blocks the commit.

## Commit / PR conventions

- Conventional-style prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- Branch names: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
- PR description: what changed, how it was verified (paste the gate output),
  and any follow-up. Link the issue if one exists.
- `main` is protected: no direct pushes, no force-push, review + green CI
  required to merge. Squash-merge keeps history linear.
