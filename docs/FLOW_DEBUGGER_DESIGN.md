# API Flow Test Debugger — Design & Build Plan

> Supersedes the "AI Auditor / confidence score" direction. That scoring UI is
> being removed. The product is an **interactive API-flow test debugger**.

## The Goal (in one sentence)

Take AI-written or AI-modified code, drive it with a **sequence of API calls**,
watch the data flow **through each section of the handler**, **pause and edit the
in-flight data like a debugger**, **inject mock data**, and choose per-run whether
the **database is real or mocked** — across **multiple languages** — then optionally
**turn a recorded run into a unit test**.

## Why this shape

The default debugger shows *what* one process is doing at one line. This tool shows
*how data moves through an API handler across a whole call sequence*, and lets you
**intervene**: change a value mid-flight, force a branch with a mock, cut off the DB.
That is exactly the loop you need to trust code an AI wrote.

## Core architectural decision: DAP is the universal layer

Everything that touches "inside the code" goes through the **Debug Adapter Protocol
(DAP)**. DAP is language-agnostic — Node, Python (debugpy), Java, Go (Delve), C#,
etc. all ship a debug adapter. So:

- **Multi-language comes for free.** The UI speaks DAP, not "Node". Adding a
  language = pointing at that language's debug config, not writing a new agent.
- **Pause / inspect** = DAP `stackTrace` + `scopes` + `variables` (already built).
- **Live edit** = DAP `setVariable` (or `setExpression`).
- **Mock injection** = set a variable's value at a breakpoint before `continue`.
- **DB mocking** = a breakpoint at the DB-client boundary that returns a mock
  instead of letting the call hit the network — same mechanism as variable mocking.

The **request runner** is a thin HTTP client that fires the scenario and correlates
each call with the debugger pauses it triggers. It does not need to understand the
target language.

## The agent closed loop (pause channel)

The point of the tool is that an AI agent — handed a ticket — can debug the code end
to end, not just fire-and-forget a scenario. That needs the agent to READ the paused
runtime state and STEER. The extension provides this through files under
`<repo>/.flow-debugger/` (same pattern as `scenario.json`):

- `captures/latest.json` — the current pause snapshot (frame, stack, scopes,
  variables, `dbMode`, `waiting`). Written on every debugger stop by `PauseBridge`.
- `captures/log.ndjson` — append-only history of every pause.
- `agent-command.json` — the agent writes `{ id, action, … }`; the extension runs it
  once (deduped by `id`). Actions: `continue`, `stepOver`, `stepIn`, `stepOut`,
  `setVariable`.
- `agent-ack.json` — the extension writes `{ id, ok, message }` after each command.

The MCP server (`mcp/flow-mcp.mjs`) wraps these as agent tools: `get_pause_state`,
`debug_continue`, `debug_step`, `debug_set_variable` (plus `run_scenario` /
`set_breakpoints`). So the full loop is: run scenario → `get_pause_state` (read the
data) → decide → `debug_set_variable` / `debug_continue` / `debug_step` → repeat →
stop for the human only when ambiguous. The webview panel still shows the same state
to the human; the capture files just mirror it to the agent.

## The driven-session model + self-reporting status (easy-start)

Earlier, session/pause state lived in module globals in `src/extension.ts` and the
agent bridge drove whatever `vscode.debug.activeDebugSession` happened to be (whatever
VS Code last focused). With two sessions that silently stole the driver, reopening the
panel could rebind the wrong session, and an out-of-process agent had no way to tell
whether the debugger was running or on which port. The **`SessionManager`**
(`src/sessionManager.ts`) replaces that:

- It binds to **exactly one driven session at a time**, keyed by the immutable
  `vscode.DebugSession.id` — the single session-id string in the whole protocol. The
  bridge resolves its session against the driven one, not the focused one.
- All former globals (pause thread, run ids, pause history, pause counts, dbMode, step
  counter, heap baseline, abort controller) become **per-session** `DrivenState`, so a
  second session can never clobber the driven session's recorded trace. Captures
  (`log.ndjson`, `latest.json`) and the panel reflect **only** the driven session; a
  non-driven session is tracked (for status/switching) but touches no capture file.
- Each `log.ndjson` line is stamped with its `sessionId`; the MCP `readLog` filters to
  the driven session (lines with no `sessionId`, from an older extension, are kept for
  backward compatibility), so the Call Map tools never serve another session's trace
  after a switch — they report "no trace for the driven session yet" instead.

**One-step start.** `start_debug_session` (MCP) and the command
`ai-debug-visualizer.startDebugging` detect/synthesize a launch config, launch the
target under the debugger, open the panel, and bind the started session as driven — in
one action. Launch-config names are discoverable via `list_debug_configs` + the
projected `.flow-debugger/captures/launch-configs.json`, so the agent never guesses.
Switching the driven session is explicit: `ai-debug-visualizer.useSession` (human
QuickPick), the `useSession` bridge action, and the `use_session` MCP tool, all of
which re-bind the bridge and immediately reconcile `latest.json` to the new session.

**Status surface.** The manager continuously projects the driven state to a new durable
file `.flow-debugger/captures/session.json` (on start/pause/resume/switch/terminate and
a 5s heartbeat), and the read-only `get_debug_status` tool reports a crisp verdict:
`NOT RUNNING` / `RUNNING, NOT PAUSED` / `RUNNING, PAUSED at thread N` / `STALE`, plus
identity and — where obtainable — port/pid. Freshness uses the same staleness idea as
`get_pause_state`, with its own pinned constants (`HEARTBEAT_MS = 5000`,
`STALE_MS = 15000`, in `mcp/callmap.mjs`) that are independent of the pause-age model.
A session's `port` is authoritative only when it comes from the launch configuration
(`portSource: 'config'`); a `debugPort(approx)` value is labelled as approximate, and an
unknown port/pid is reported as `null` rather than guessed — the verdict never depends
on port/pid, so the agent always gets a definite running/paused answer. These files and
tools are **additive**: the existing `.flow-debugger/` protocol, MCP tools, and commands
are unchanged, and readers degrade gracefully (explicit "not running" / "no discovery
file") when the new files are absent.

## Components

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code Extension (host, Node)                                │
│                                                               │
│  Flow Runner ──HTTP──▶ target API (any language)              │
│      │                      │ runs under its DAP adapter      │
│      │                      ▼                                 │
│  DAP bridge ◀───pauses/variables/setVariable───────────────  │
│      │                                                        │
│  Mock store (shared JSON) ── import from tests / capture run  │
└──────────────┬────────────────────────────────────────────── ┘
               │ postMessage
        ┌──────▼───────────────────────────────────┐
        │ Webview (React)                           │
        │  • Scenario panel (ordered API calls)     │
        │  • Execution flow graph (per section)     │
        │  • Data inspector (EDITABLE cells)        │
        │  • Mock / override panel                  │
        │  • DB mode toggle (real | mocked)         │
        │  • "Save as unit test" from a run         │
        └───────────────────────────────────────────┘
```

## Shared mock format (one format, three sources, two consumers)

A single JSON shape is the hub:

```jsonc
{
  "name": "verify-claim happy path",
  "language": "node",
  "variableOverrides": {           // set at a breakpoint before continue
    "astar.ts:42:nodesVisited": "99"
  },
  "boundaryMocks": [               // intercept an external/DB call, return this
    { "match": "db.getClaim", "returns": { "id": "C1", "status": "OPEN" } }
  ],
  "requestBody": { /* seed request */ }
}
```

- **Sources:** hand-written · imported from an existing unit-test fixture ·
  captured from a live run.
- **Consumers:** feeds a run (inject) · feeds a generated unit test (assert).

## DB: real or mocked, per run

A run-level toggle:
- **real** — calls hit the actual DB.
- **mocked** — breakpoints at the DB-access boundary return `boundaryMocks` values;
  the network is never touched. This is what lets you test a handler with no DB.

## Unit-test round trip

- **Consume:** load a test's mock fixtures as `boundaryMocks` for a run.
- **Produce:** record a run (seed request + every intercepted value + final
  response), then emit a unit test in the target language's framework that replays
  the request with those mocks and asserts the response.

## Build phases (step by step, no rush)

- [x] **Phase 0 — Reset UI.** Removed the AI Auditor scoring panel; kept the flow
      graph + data inspector; rewired the whole host/webview protocol.
- [x] **Phase 1 — Scenario panel + Flow Runner.** Ordered API calls, fire them,
      per-call status/duration/pause-count, `${var}` chaining via response extraction.
- [x] **Phase 2 — Editable inspector (live data edit).** Double-click a variable →
      DAP `setVariable`.
- [x] **Phase 3 — Mock store + injection.** Shared `MockSet` JSON under
      `.flow-debugger/mocks/`; load/save; `variableOverrides` injected at the matching
      `file:line:var` on each pause.
- [x] **Phase 4 — DB mode toggle.** `real | mocked` per scenario; `boundaryMocks`
      carry the DB/external stub values.
- [~] **Phase 5 — Multi-language config.** DAP-generic; works today for any adapter.
      Node + Python are implemented end to end (including the headless interactive path
      below); the remaining piece is the per-project launch-profile UI. See the
      "Phase 5 (still open)" note after the interactive-headless entry below.
- [x] **Phase 6 — Unit-test round trip.** Import test fixtures as mocks (MockSet
      format); record a run and generate a Jest test (`generateTest`).
- [x] **Programmatic breakpoints.** The extension and an AI agent set breakpoints
      from the scenario via `vscode.debug.addBreakpoints`; only extension-owned
      breakpoints are managed, so user hand-set ones are never clobbered.
- [x] **npm / `npx` packaging + `get_capabilities` probe.** The MCP server is
      publishable (root `package.json` `bin` `flow-debugger-mcp` + `files` whitelist of
      `mcp/`,`cli/`), so any agent registers it with `npx -y ai-debug-visualizer` — no
      clone, no absolute path. A read-only `get_capabilities` tool reports headless
      language readiness, the easy-start debug-session verdict (reusing
      `evaluateDebugStatus`/`readSessionJson` so it agrees with `get_debug_status`),
      discovered launch-config names, and drive modes — so an agent chooses headless vs
      IDE before committing to a scenario.
- [x] **Interactive headless debugging (no IDE).** An agent can now hold a **live**
      debug session with no editor and *steer* it (read pause → `setVariable` → step →
      continue), not just record a one-shot trace. This is the headless analog of the
      easy-start driven-session model. Files:
      - `cli/collector.mjs` — `collectInteractive()`: a non-resuming park-and-steer loop
        that, instead of auto-`resume()`-ing each pause, parks and polls
        `.flow-debugger/agent-command.json`, dispatches to driver primitives, and writes
        `agent-ack.json` (deduped by command id — the SAME channel the extension uses).
        The one-shot `collect()` is unchanged.
      - `cli/collectors/nodeCdpDriver.mjs` + `pythonDapDriver.mjs` — steering primitives
        on both drivers: `setVariable`, `evaluate`, `step(over|in|out)`, and
        `stackTrace`/`scopes`/`variables` passthroughs (thin wrappers over the existing
        CDP/DAP clients; no new protocol). Documented in `cli/collectors/driver.md`.
      - `cli/headless-session.mjs` — the long-lived runner (headless analog of
        `SessionManager`): mints a synthetic driven id `headless:<pid>:<startTs>`, writes
        + heartbeats `.flow-debugger/captures/session.json` via the pure
        `projectSessionStatus`/`HEARTBEAT_MS` from `mcp/callmap.mjs` (single-sourced — do
        NOT re-implement it), stamps `log.ndjson` lines with that id so `filterLogBySession`
        keeps the Call Map on this trace, writes `latest.json` per pause, and on teardown
        writes `session.json` `live:false` + `latest.json` `sessionEnded:true`.
      - `mcp/flow-mcp.mjs` — two new tools: `start_headless_session { language, program,
        args?, breakpoints[], pythonPath?, workspace? }` and `stop_headless_session`;
        `get_capabilities` gained a `headlessSessionLive` field. The existing steering
        tools (`get_pause_state`, `debug_*`, `evaluate_expression`, `get_debug_status`)
        work against the headless session **unchanged** — it is a second producer of the
        same `.flow-debugger/` surface.
      - **Single-owner guard (important for the next agent):** only ONE producer may own
        `session.json` at a time. `start_headless_session` refuses while any session (IDE
        or another headless runner) is live; starting an IDE session while a headless
        runner is live is unsupported. Two writers would corrupt the single-stream
        `log.ndjson` the Call Map depends on.
      - Both languages are implemented. Python requires `debugpy` in the TARGET project's
        environment; its tests SKIP cleanly when `debugpy` is absent (same pattern as
        `collect_trace_headless`). Tests: `cli/collector-interactive.test.mjs`,
        `cli/headless-session.test.mjs`, `verify/headless-mcp.test.mjs` (full lifecycle:
        start → `headlessSessionLive:true` → read pause → `set_variable` → `continue` →
        single-owner guard refuses a 2nd start → stop → `headlessSessionLive:false`).
      - Full design: `docs/INTERACTIVE_HEADLESS_SPEC.md`. Known non-blocking follow-ups
        from review: `log.ndjson` is stamped at teardown (tolerated — `filterLogBySession`
        keeps unstamped lines for the driven session); `stop_headless_session` clears a
        STALE session's status without SIGTERM (pid may be reused).
- [ ] **Phase 5 (still open) — Multi-language profile UX.** Interactive debugging is
      DAP/CDP-generic and now implemented headless for Node + Python; adding Java (Delve
      is Go; `java-debug` for Java) / Go is "write one driver file" per
      `cli/collectors/driver.md`. The per-project launch-profile *UI* in the panel is the
      remaining piece.

Each phase ends with: dev test + a real curl/response proof where an HTTP endpoint
is involved + a screenshot of the panel, and traces the data flow through the
method — matching the proof-of-test workflow.

## Agent scenario + breakpoints JSON schema

An AI agent (or any caller) drives the extension by passing a **scenario object** to
the command `ai-debug-visualizer.runScenarioJson` (sets the breakpoints, then runs
the flow), or just the breakpoints array to `ai-debug-visualizer.setBreakpoints`
(sets them without running). Input is coerced defensively by
`normalizeScenario` / `normalizeBreakpoints`, so unknown fields are ignored and bad
entries are dropped rather than throwing.

### `Scenario`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | no | Defaults to `"agent-scenario"`. |
| `name` | string | no | Display name. |
| `dbMode` | `"real"` \| `"mocked"` | no | Defaults to `"real"`. `mocked` serves DB calls from `boundaryMocks`. |
| `mockSetName` | string | no | A saved mock set under `.flow-debugger/mocks/`. |
| `breakpoints` | `Breakpoint[]` | no | Set programmatically before the run. |
| `calls` | `ApiCall[]` | yes | The ordered API-call sequence. |

### `Breakpoint`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `file` | string | yes | Absolute, or relative to the workspace root (e.g. `src/handler.ts`). |
| `line` | integer ≥ 1 | yes | 1-based line number. |
| `condition` | string | no | The debugger pauses only when this expression is truthy. |
| `label` | string | no | Human-readable tag, e.g. `"after IA resolve"`. |
| `enabled` | boolean | no | Defaults to `true`; `false` keeps it in the list but does not apply it. |

### `ApiCall`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | no | Defaults to `c1`, `c2`, … |
| `name` | string | no | Display name. |
| `method` | `GET`\|`POST`\|`PUT`\|`PATCH`\|`DELETE` | no | Defaults to `GET`. |
| `url` | string | yes | May contain `${var}` placeholders resolved from earlier `extract`. |
| `headers` | object | no | Extra request headers. |
| `body` | string | no | Raw JSON string (ignored for `GET`). May contain `${var}`. |
| `extract` | object | no | Map of `varName -> "$.json.path"` pulled from this call's response for later `${varName}` use. Supports `$.a.b` and `$.a[0].b`. |

### Example

```json
{
  "id": "verify-claim-flow",
  "name": "verify-claim happy path",
  "dbMode": "mocked",
  "mockSetName": "no-db-fixture",
  "breakpoints": [
    { "file": "src/verify-service.ts", "line": 34, "label": "handler entry" },
    { "file": "src/ia-service.ts", "line": 58, "condition": "status === 'UNRESOLVED'", "label": "IA resolve" }
  ],
  "calls": [
    {
      "id": "c1",
      "name": "create claim",
      "method": "POST",
      "url": "http://127.0.0.1:3000/claims",
      "body": "{\"applicantId\":\"A1\"}",
      "extract": { "claimId": "$.id" }
    },
    {
      "id": "c2",
      "name": "verify claim",
      "method": "POST",
      "url": "http://127.0.0.1:3000/claims/${claimId}/verify"
    }
  ]
}
```

Invoke from an agent:

```js
await vscode.commands.executeCommand('ai-debug-visualizer.runScenarioJson', scenario);
// or only place the breakpoints from a proposed flow:
await vscode.commands.executeCommand('ai-debug-visualizer.setBreakpoints', scenario.breakpoints);
```
