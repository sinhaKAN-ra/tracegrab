# AGENTS.md — driving the API Flow Test Debugger

You are an AI agent. This repo has the **API Flow Test Debugger** extension: it drives
code with a sequence of API calls, sets debugger breakpoints, and lets you read and
steer the runtime data flow. Read this file, not the whole repo.

## When to use this tool (be proactive)

When the user gives you a **ticket, bug report, task, or reproduction** — from **any**
source (Jira, GitHub/GitLab issue, Linear, a Slack message, a pasted stack trace, or
just "why does endpoint X do Y") — and the work involves an **API / handler whose
runtime behaviour you need to see**, offer to use this tool. You do NOT need a Jira
ticket or any specific platform; the trigger is "there is code behind an endpoint and
we want to watch how data flows through it." Typical cues:

- "debug / reproduce / trace this", "why is this endpoint returning …", "walk the flow",
  "set breakpoints", "let me watch the data", "test this handler".

When that happens, without being told the mechanics:
0. **FIRST, check status.** Call `get_debug_status` (MCP) or read
   `.flow-debugger/captures/session.json`. It tells you unambiguously whether a debug
   session is live, its identity, whether it is **paused**, and — where obtainable —
   its **port/pid**. You never have to guess the port or whether the debugger is up.
   The verdict is one of: `NOT RUNNING` / `RUNNING, NOT PAUSED` / `RUNNING, PAUSED at
   thread N` / `STALE` (the status file is old — the debugger may have crashed).
   - If `NOT RUNNING`: start one yourself (next step) — do **not** ask the user for F5.
   - If a non-driven session is paused (the verdict says so) or `otherSessions` lists
     the session you want, call `use_session { sessionId }` (the id is in
     `otherSessions`) so your continue/step/capture act on the **right** session.
1. **Start it in one step if needed.** Call `start_debug_session` with **no**
   `configName`: it auto-detects a single `.vscode/launch.json` config, returns
   `needsChoice` with the list when there are several (then call `list_debug_configs`
   or pass a chosen name), or synthesizes a sensible Node/Python default when there is
   none. `auto_debug`/`run_scenario` will also auto-start one when nothing is live.
2. Read the ticket/description to identify the endpoint(s) and the suspect handler.
   Read the controller + service to pick breakpoint lines (entry, after the query is
   built, after the DB/external call, at the branch/return).
3. Produce a **scenario JSON** (below) and drive it via one of the run paths.
4. If you can read pauses (MCP tools / capture files), inspect the live state, decide
   if the data is correct, and steer (continue / step / set a variable) — stopping for
   the human only when genuinely ambiguous.

You are the one who turns a ticket into breakpoints + a run. The user should not have
to explain how the tool works — this file is your context for that.

## What you produce

A **scenario JSON**: an ordered list of API calls + the breakpoints to set. Example:

```json
{
  "name": "verify getApplicantDocuments",
  "dbMode": "real",
  "breakpoints": [
    { "file": "src/modules/applicant/applicant.controller.ts", "line": 42, "label": "handler entry" },
    { "file": "src/modules/applicant/applicant.service.ts", "line": 88, "condition": "docs.length === 0" }
  ],
  "calls": [
    { "name": "create", "method": "POST", "url": "http://127.0.0.1:3000/applicant-documents",
      "body": "{\"applicantId\":\"A1\"}", "extract": { "docId": "$.id" } },
    { "name": "fetch", "method": "GET", "url": "http://127.0.0.1:3000/applicant-documents/${docId}" }
  ]
}
```

- `breakpoints[]`: `{ file, line, condition?, label? }`. `file` is relative to the repo
  root (or absolute); `line` is 1-based. Read the target handler and choose the lines
  where data is interesting (entry, after a DB call, at a branch).
- `calls[]`: `{ name?, method, url, body?, extract? }`. `${var}` in a `url`/`body` is
  filled from an earlier call's `extract` (`{ "var": "$.json.path" }`, supports `$.a.b`,
  `$.a[0].b`).
- `dbMode`: `"real"` hits the DB; `"mocked"` serves DB/external calls from the named
  `mockSetName` mock set (`.flow-debugger/mocks/<name>.json`).

## Preconditions — the easy path needs no manual setup

The one-step start removes the old "stop, re-run under the debugger, open the panel"
dance. Your first move is `get_debug_status`; if it says `NOT RUNNING`, call
`start_debug_session` (no `configName`) — this launches the target **under the
debugger**, opens the panel, and binds the session as the one this tool drives, all in
one action. Use `use_session { sessionId }` to pick among several live sessions.

**Manual fallback (only if the one-step start cannot resolve a launch config in the
target repo):** ask the user, once, to open the panel via Command Palette →
**API Flow Test Debugger: Start** (or **Start Debugging (launch + panel)**) and press
F5 so breakpoints bind. The easy path above should make this rarely necessary.

## Three ways to run it — pick whichever your environment allows

**A. Trigger file (works from any tool that can write a file).**
Write the scenario JSON to `<repo>/.flow-debugger/scenario.json`. The extension
watches that path and auto-runs on write. This is the simplest path for Cursor's
built-in agent — you already can write files.

**B. CLI (terminal).**
```bash
node cli/flow-run.mjs path/to/scenario.json --workspace <repo>
# or:  cat scenario.json | node cli/flow-run.mjs - --workspace <repo>
# or:  npm run flow-run -- path/to/scenario.json
```
It writes the trigger file for you (atomically).

**C. MCP server (any MCP-capable agent).**
Register `mcp/flow-mcp.mjs` (see its header for `~/.cursor/mcp.json`), then call the
tool `run_scenario` with `{ scenario, workspace? }` (or `set_breakpoints` with
`{ breakpoints, workspace? }`). Start-and-status tools: `get_debug_status` (call
first), `start_debug_session` (one-step start, optional `configName`),
`list_debug_configs` (discover config names), and `use_session { sessionId }` (switch
which live session you drive).

All three end in the same place: the extension sets the breakpoints and fires the
calls; the user watches the flow graph + data inspector and edits variables live.

## Also available (extension-to-extension only)

If you can call VS Code commands directly: `tracegrab.runScenarioJson`
(scenario object), `tracegrab.setBreakpoints` (breakpoints array),
`tracegrab.startDebugging` (one-step launch + panel; optional config name),
and `tracegrab.useSession` (switch the driven session).

Full reference: `docs/FLOW_DEBUGGER_DESIGN.md` and `README.md`.
