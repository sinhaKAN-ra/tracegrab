# Agent automation guide

How an AI agent uses the API Flow Test Debugger to **observe real runtime behaviour
and infer the state of a system** — with one call, not a prompting loop.

This is the document to read if you are wiring the tool into an agent, an agent
platform, or CI.

---

## The idea

Most "AI debugging" is the model *guessing* from source code. This tool lets an
agent watch the code actually run: real requests, real pauses, real variable
values, real heap — then hands back a **diagnosis** rather than raw data.

The design goal is **low prompting cost**: one tool call should be enough to go
from "here is a ticket about endpoint X" to "here is what is wrong and where".

---

## The one call that matters: `auto_debug`

```jsonc
auto_debug({
  "scenario": {
    "breakpoints": [
      { "file": "src/modules/dashboard/dashboard.controller.ts", "line": 20, "label": "handler entry" },
      { "file": "src/modules/dashboard/dashboard.service.ts",    "line": 15, "label": "after query built" },
      { "file": "src/repositories/items.repo.ts",                "line": 8,  "label": "DB read" }
    ],
    "calls": [
      { "name": "dashboard", "method": "GET", "url": "http://127.0.0.1:8004/dashboard/U7" }
    ],
    "dbMode": "real"
  }
})
```

What it does, without further prompting:

1. Applies the breakpoints.
2. Fires the calls.
3. **Records and auto-resumes every pause** — no `debug_continue` loop.
4. Stops when the trace settles.
5. Returns the call map, a summary, a Mermaid diagram, **and a diagnosis**.

### What comes back

```jsonc
{
  "verdict": "FAILING — an exception was thrown on this path.",
  "pausesRecorded": 8,
  "methodsCaptured": 5,
  "layersTouched": ["controller", "service", "db"],
  "findings": [
    {
      "severity": "critical", "kind": "exception",
      "title": "DBTimeout thrown in findItem",
      "detail": "timeout querying items",
      "where": "items.repo.ts:9",
      "suggestion": "Trace the inputs on this hop (data-in) — the throw is the primary failure."
    },
    {
      "severity": "high", "kind": "n+1",
      "title": "N+1 query: findItem called 3× in a loop",
      "where": "items.repo.ts",
      "suggestion": "Batch into a single query (IN / batchGet / join) or hoist out of the loop."
    },
    {
      "severity": "high", "kind": "mutation",
      "title": "token was cleared (abc123 → '') in getOrders",
      "where": "o.svc.ts:15",
      "suggestion": "Confirm this reset is intentional; if not, this is likely the defect."
    }
  ],
  "callPath": [
    "CONTROLLER getDashboard (d.ctrl.ts)",
    "  SERVICE getOrders (o.svc.ts)",
    "    DB findItem (items.repo.ts)"
  ]
}
```

### What the diagnosis detects

| Kind | Severity | Signal |
|------|----------|--------|
| `exception` | critical | A throw was captured on this path (DAP `exceptionInfo`). |
| `n+1` | high | A DB-layer method entered ≥3× under the same caller — one query per loop iteration. |
| `mutation` | high | A populated value became `''`/`null`/`[]`/`0` — where data is silently lost. |
| `db-fanout` | medium | One method makes ≥4 DB calls (network hops worth batching). |
| `memory` | medium | heapUsed grew and **never** decreased — retention/leak signal. |
| `coverage` | info | Only one frame captured — too shallow to conclude from; go deeper. |

If nothing fires, the verdict is `LOOKS OK` — which is itself a useful, citable result.

### When no pause is recorded

`auto_debug` returns a **troubleshooting report** instead of an empty trace,
naming the likely cause (API not under the debugger, panel not open, breakpoint
didn't bind, request never reached the handler). An agent can act on that
directly rather than reporting "it didn't work".

---

## No scenario JSON required

Observation does not need the scenario runner at all. Capture is registered on
**every** DAP `stopped` event, so:

- Breakpoints set by hand **in the editor gutter** work.
- A request fired from **Postman / curl / a browser / another service** works.
- Such pauses are tagged `external` and badged **EXT** in the UI.

Omit `calls` from `auto_debug` to arm breakpoints and record whatever external
trigger hits them. The scenario runner only exists to fire the calls for you and
to chain `${var}` between them.

---

## The full tool surface (12)

**Autonomous (prefer these)**

| Tool | Use |
|------|-----|
| `auto_debug` | One-call investigation: apply, run, auto-resume, diagnose. |
| `analyze_state` | Re-diagnose the recorded trace: findings + verdict + call path. |
| `get_instructions` | The contract + scenario schema. Read first. |

**Reading a trace**

| Tool | Use |
|------|-----|
| `get_call_map` | Full controller→service→DB tree (`summary=true` for a digest). |
| `get_memory_timeline` | Heap over the run: peak, net delta, `memoryReclaimed`. |
| `export_mermaid` | Sequence diagram for a ticket / MR. |
| `get_pause_state` | The live frame/stack/variables at the **current** pause. |

**Steering (interactive)**

| Tool | Use |
|------|-----|
| `run_scenario` | Apply breakpoints + fire calls (no auto-resume). |
| `set_breakpoints` | Arm breakpoints without running. |
| `debug_continue` / `debug_step` | Resume / step `over`\|`in`\|`out`. |
| `debug_set_variable` | Change a live value mid-flight and observe the effect. |

Use steering when you want to **alter** behaviour (force a branch, inject a
value). Use `auto_debug` when you want to **understand** it.

---

## Recommended agent loop

```
ticket / bug report / "why does endpoint X do Y"
  ↓
read controller + service, pick 3–4 breakpoint lines
  ↓
auto_debug({ scenario: { breakpoints, calls } })
  ↓
findings.length === 0  →  report "no anomaly on this path" (with callPath as evidence)
findings.length  >  0  →  fix the highest-severity finding, re-run auto_debug to confirm
  ↓
export_mermaid  →  attach the trace to the ticket / MR
```

To **prove a fix**, run `auto_debug` before and after: the verdict moving from
`FAILING` / `PROBLEM FOUND` to `LOOKS OK` is objective evidence, not an assertion.

---

## Preconditions (tell the human once)

1. Target API running **under the debugger** (F5) so breakpoints bind.
2. The panel opened once: **`API Flow Test Debugger: Start`**.
3. The MCP server registered (see the README's "Driving it (all modes)").

`auto_debug`'s no-data report will tell you which of these is missing.

---

## Scenario schema

```jsonc
{
  "name": "string",
  "dbMode": "real" | "mocked",       // mocked serves DB/external calls from a mock set
  "mockSetName": "string",           // .flow-debugger/mocks/<name>.json
  "breakpoints": [
    { "file": "src/…/X.ts", "line": 42, "condition": "docs.length === 0", "label": "after DB" }
  ],
  "calls": [
    { "name": "create", "method": "POST", "url": "http://127.0.0.1:3000/items",
      "body": "{\"a\":1}", "extract": { "itemId": "$.id" }, "enabled": true },
    { "name": "fetch",  "method": "GET",  "url": "http://127.0.0.1:3000/items/${itemId}" }
  ]
}
```

- `file` is repo-root-relative (or absolute); `line` is 1-based.
- `${var}` in a `url`/`body` is filled from an earlier call's `extract`
  (`$.a.b`, `$.a[0].b`).
- `enabled: false` skips a call — the runner and the UI both honour it.

---

## Language support

The whole pipeline is DAP-generic, so breakpoints, pauses, stack, scopes,
`setVariable`, the call map, mutations and N+1 detection work with **any** debug
adapter (Node, Python/debugpy, Go/Delve, Java, …).

Memory sampling is the one language-specific probe:

| Runtime | Heap sampling |
|---------|---------------|
| Node (`pwa-node`, `node`, …) | `process.memoryUsage()` — full heapUsed/heapTotal/rss |
| Python (`debugpy`) | `resource.getrusage()` RSS |
| Others (Go, Java, …) | Not sampled — the readout hides gracefully, everything else works |

---

## Honest limits

- **`data-in` / `data-out` on each hop are inferred** from entry locals and
  last-changed locals — a strong heuristic, not guaranteed exact call arguments
  or return values (DAP does not expose those without call-site breakpoints).
- **Only methods where the debugger actually paused appear.** No breakpoint in a
  layer means that layer is invisible; the `coverage` finding flags this.
- **Timings under breakpoints are meaningless** (wall clock includes pause time),
  which is why the tool reports call *counts*, not durations.
- **Memory reflects pause-time state**, not production load.
