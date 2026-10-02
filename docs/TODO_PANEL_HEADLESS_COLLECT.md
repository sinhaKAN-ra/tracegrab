# TODO: panel-driven headless collection

**Status:** not built. What exists today (2026-09-30) is deliberately smaller:
a readiness check + a hidden-unless-ready hint, not the feature itself.

## What's done now

- `checkPythonReadiness()` in `src/extension.ts` spawns `python3 -c "import
  debugpy"` (mirrors `PythonDapDriver.isAvailable()` in
  `cli/collectors/pythonDapDriver.mjs` — kept in sync manually, same pattern as
  `mcp/callmap.mjs` mirroring the `src/*.ts` pure modules) once per panel open,
  fire-and-forget, and posts `{ kind: 'pythonReadiness', ready, reason?,
  version? }` to the webview.
- The webview (`App.tsx`) only renders anything for this when `ready === true`
  — a small `🐍 debugpy ready` badge in the header, and one extra paragraph in
  the Help drawer. **When not ready, nothing renders** — no badge, no greyed
  button, no error banner. There is no fallback UI state to design around.
- The actual collection (`flow-verify collect --lang python`,
  `collect_trace_headless` MCP tool) is CLI/agent-only, unchanged by this.

## What's NOT done (this is the deferred feature)

A real "Collect (headless)" panel workflow:

1. **Target picker** — program entry file (relative to workspace), language
   (auto-detect from extension, or explicit), optional args.
2. **Breakpoint source** — reuse the existing Breakpoints panel's list (it
   already has file/line/condition) instead of a new input; the panel already
   distinguishes "set by you" vs "from scenario/agent", so headless-collected
   breakpoints would need a third provenance or just reuse "from scenario".
3. **Run button + progress** — needs a NEW host command
   (`ai-debug-visualizer.collectHeadless`) that dynamically imports
   `cli/collector.mjs` (same pattern as `generateReportCmd` importing
   `mcp/callmap.mjs`) — which means **`cli/**` would need partial un-exclusion
   from `.vscodeignore`, same as was done for `mcp/callmap.mjs`. Currently
   `cli/**` is fully excluded from the vsix.
4. **Result wiring** — on completion, feed the same `log.ndjson` the collector
   wrote into the existing Call Map / Data State Inspector / report flow, so
   nothing downstream needs to change — this part is "free" because the
   collector already writes the same format the panel already reads.
5. **Python-specific gating** — the "Collect (headless, Python)" option in the
   target picker should itself follow the same rule already shipped: hidden
   entirely when `pythonReady.ready !== true`, re-checked on demand (e.g. a
   small "recheck" action) since a user might install debugpy mid-session.
6. **Node headless collection from the panel** has no readiness gate to design
   (Node's collector needs nothing installed) — it's simpler and could ship
   first, independent of the Python work above.

## Why this was deferred rather than built now

The ask that triggered this doc was specifically "wire detection into a hint;
if not ready don't show it; make the rest a TODO" — i.e. explicitly scoped
smaller than the full workflow above. Building items 1–5 is a real UI feature
(new panel section, new host command, new vsix packaging decision) that
deserves its own pass rather than being folded into a detection-and-hide task.
