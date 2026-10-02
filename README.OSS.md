# API Flow Test Debugger — runtime behavioral verification for AI-written code

> Drive an API with a real request, watch data flow through every layer
> (controller → service → DB and back), and get a **diagnosis** — exceptions,
> N+1 queries, silent state loss, memory growth — not just raw stack frames.
> Built to be driven by **AI agents** through MCP, with the safety rails a real
> product needs.

[![tests](https://img.shields.io/badge/tests-green-brightgreen)](#build--test)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why this exists

Most "AI debugging" is a model *guessing* from a stack trace. This tool lets an
agent (or you) watch the code actually run and reason about **behaviour**:

- **Call Map** — a request-shaped view: each method is a box, nested
  controller → service → DB, with the data crossing each boundary.
- **Diagnosis, not frames** — one call (`auto_debug`) returns a verdict
  (`LOOKS OK` / `SUSPECT` / `PROBLEM` / `FAILING`) with ranked findings:
  exceptions, N+1 queries, values silently cleared, DB fan-out, heap growth.
- **Agent-native** — an MCP server (19 tools) so Claude Code / Cursor / Copilot
  drive it directly; no per-repo files needed.
- **Safe by default** — secret redaction, least-privilege reads,
  propose-then-confirm on any live mutation, an audit trail, and fail-closed
  mocking (see [SECURITY.md](./SECURITY.md)).
- **No scenario JSON required** — set a breakpoint in the gutter, hit the
  endpoint from Postman/curl, and it's captured identically.

It is **not** a generic step-debugger (see
[microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) /
[mcp-debugger](https://github.com/debugmcpdev/mcp-debugger) for those) — its
wedge is proving AI-changed code still *behaves* correctly, gated on a PR.

## Quick start

```bash
git clone <repo> && cd ai-debug-visualizer
npm install
npm run build          # webview (Vite) + host (tsc)
npm test               # host-logic + call-tree + safety suites
npx vsce package       # → ai-debug-visualizer-*.vsix
code --install-extension ai-debug-visualizer-*.vsix
```

Then: open a repo, press **F5** to run your API under the debugger, run
**"API Flow Test Debugger: Start"**, set breakpoints, and hit the endpoint.
The in-panel **? Help** explains the rest.

## Drive it from an AI agent (MCP)

Register `mcp/flow-mcp.mjs` once (see [docs/AGENT_AUTOMATION.md](./docs/AGENT_AUTOMATION.md)):

```jsonc
{ "mcpServers": { "flow-debugger": {
  "command": "node",
  "args": ["/ABS/PATH/tracegrab/mcp/flow-mcp.mjs"],
  "env": { "FLOW_WORKSPACE": "/ABS/PATH/to/target/repo" }
} } }
```

The agent's one-call path: `auto_debug({ scenario: { breakpoints, calls } })` →
call map + diagnosis + verdict. Full tool list and workflow in
[docs/AGENT_AUTOMATION.md](./docs/AGENT_AUTOMATION.md).

## Documentation

| Doc | What |
|-----|------|
| [docs/AGENT_AUTOMATION.md](./docs/AGENT_AUTOMATION.md) | Driving it from an AI agent; all MCP tools; the one-call flow. |
| [docs/FLOW_DEBUGGER_DESIGN.md](./docs/FLOW_DEBUGGER_DESIGN.md) | Architecture + scenario/breakpoint schema. |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | What's shipped and what's planned (capabilities). |
| [SECURITY.md](./SECURITY.md) | Security model, redaction, mutation safety, reporting. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, gates, how to add a feature/language. |
| [docs/MAINTAINING.md](./docs/MAINTAINING.md) | How to keep the project moving forward. |

## Build & test

```bash
npm run build      # webview + host
npm test           # 27 host + 29 call-tree + 20 safety checks
npm run demo       # open the standalone Call Map demo in a browser
```

## License

MIT — see [LICENSE](./LICENSE).
