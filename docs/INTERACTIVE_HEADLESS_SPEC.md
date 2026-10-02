# Interactive Headless Debugging — Design Spec (follow-up)

> Status: **scoped, not implemented.** This document defines the work needed to let
> an agent hold a *live* debug session with **no IDE** and steer it the same way it
> can today through the VS Code extension (read a pause, decide, mutate a variable,
> step, continue).

## Problem

Today there are two disjoint capabilities:

| | Set breakpoints | Record trace + diagnose | Hold a live session and steer (read→decide→mutate→step→continue) | Needs IDE |
|---|---|---|---|---|
| **IDE path** (`auto_debug`, `run_scenario`, `debug_*`, `get_pause_state`, `evaluate_expression`) | yes | yes | **yes** | **yes** (panel open + F5) |
| **Headless path** (`collect_trace_headless`) | yes | yes | **no** | no |

The headless path (`cli/collector.mjs`) is **one-shot and non-interactive**: its
collection loop auto-resumes on every `paused` event and runs the target to
completion, then exits. There is no live session an agent can pause against to call
`debug_set_variable` / `debug_step` / `evaluate_expression`.

So an agent running in CI, a container, or any editor-less environment can *observe*
and *diagnose* but cannot *intervene*. Closing that gap is what makes the tool fully
usable by agents built on top of other coding agents, where there is rarely a human
IDE in the loop.

## Alignment with the easy-start driven-session model (commit 77d320f)

The "easy-start" change made the extension the single source of truth for *which
session is being driven* and published it through **`.flow-debugger/captures/session.json`**,
written only by `SessionManager` via the pure `projectSessionStatus` helper in
`mcp/callmap.mjs`. Two consequences shape this feature:

1. **`get_debug_status` reads `session.json`** (via `evaluateDebugStatus`) to decide
   NOT RUNNING / RUNNING / PAUSED / STALE. A headless session has **no VS Code host**,
   so nothing would write `session.json` for it — `get_debug_status` would report NOT
   RUNNING even while a headless session is live.
2. **Every call-map tool now filters `log.ndjson` by the driven `sessionId`**
   (`filterLogBySession` + `drivenSessionId()` read from `session.json`). Log lines are
   stamped with a `sessionId`. An unstamped headless trace, or one with no matching
   driven id, is reported as "no trace for the driven session yet" rather than served.

**So the headless runner must play the role `SessionManager` plays for IDE sessions.**
This is the one substantive adaptation versus a pre-easy-start design:

- The runner mints a **synthetic driven id**: `headless:<pid>:<startTs>` — the headless
  analog of the immutable `vscode.DebugSession.id`.
- The runner **writes `session.json` itself** using the already-exported, zero-dep
  `projectSessionStatus(driven, otherSessions, nowIso)` from `mcp/callmap.mjs`, with
  `startedBy:'agent'`, `type:'node'|'python'`, the synthetic id as `sessionId`, and a
  heartbeat rewrite every `HEARTBEAT_MS` (also exported) so `evaluateDebugStatus` sees a
  fresh `lastHeartbeatAt` and never falsely reports STALE. On pause it sets
  `pausedThreadId`; on resume it clears it. This makes `get_debug_status` report the
  headless session correctly with **no change to that tool**.
- The runner **stamps every `log.ndjson` line with the synthetic `sessionId`**, so the
  existing `filterLogBySession` keeps the call-map tools pointed at the headless trace.
- On teardown the runner writes `session.json` `live:false` (via `projectSessionStatus(null, …)`)
  and `latest.json` `sessionEnded:true`, exactly as the extension's `shutdown()` /
  `markSessionEnded` do, so staleness is reported honestly.

Net effect: the headless runner becomes a **second producer of the same capture surface**
the extension already produces. No MCP tool, no analysis code, and no file format changes.

## What already exists (reuse, don't rebuild)

- **`cli/dapClient.mjs`** already speaks generic DAP over stdio and exposes a raw
  `request(command, args)`. Every primitive interactive steering needs is a DAP
  request that this client can already send: `continue`, `next`/`stepIn`/`stepOut`,
  `setVariable`, `evaluate`, `stackTrace`, `scopes`, `variables`. **No new protocol
  code is required.**
- **The driver contract** (`cli/collectors/driver.md`) already normalizes a pause
  into `{ reason, frame, stackDepth, vars, heapUsed, exception }` and already owns
  `resume()`. Interactive mode is "do not auto-call `resume()`; wait for a command
  first."
- **The MCP command channel pattern** (`agent-command.json` / `agent-ack.json`,
  deduped by `id`) is already how the extension path services `debug_*` /
  `evaluate_expression`. The headless session can service the **same** files, so the
  existing MCP tools work unchanged against it.
- **The status surface helpers** `projectSessionStatus`, `evaluateDebugStatus`,
  `filterLogBySession`, `neutralPause`, `HEARTBEAT_MS`, `STALE_MS` are already exported
  from `mcp/callmap.mjs` (zero-dependency ESM) — the runner imports them directly, so the
  `session.json` shape and staleness model stay single-sourced with the extension.
- **Redaction, noise filtering, NDJSON, call-tree/FlowTrace/report/diff/contracts**
  all consume the same recorded pause shape and need no change.

## Design: a long-lived headless session servicing the existing command channel

Add an **interactive collection mode** to the headless path. Instead of the
auto-resume settle-loop, the session:

0. On start: mint the synthetic driven id, write `session.json` (`live:true`,
   `paused:false`, `startedBy:'agent'`) via `projectSessionStatus`, and start a
   `HEARTBEAT_MS` timer that rewrites `session.json` so it never reads as STALE.
1. Launches the target under the real debug adapter and applies breakpoints
   (unchanged `connect` + `setBreakpoints`).
2. On each `paused` event: capture + write the NDJSON record **stamped with the
   synthetic `sessionId`** (so `filterLogBySession` keeps the call-map tools on this
   trace), write the same `captures/latest.json` snapshot the extension writes (so
   `get_pause_state` works verbatim), rewrite `session.json` with `pausedThreadId` set
   (so `get_debug_status` reports PAUSED), **then block instead of resuming.**
3. While blocked, watch `.flow-debugger/agent-command.json`. For each new command id
   (same dedupe-by-`id` contract the extension uses), translate it to a DAP request
   on the live `DapClient` and write `agent-ack.json` with the result:
   - `continue` → `continue`
   - `stepOver|stepIn|stepOut` → `next` / `stepIn` / `stepOut`
   - `setVariable` → `setVariable` (preview/confirm token logic stays in the MCP tool)
   - `evaluate` → `evaluate` (reads immediate; writes behind confirm token)
4. On `continue`/step the session unblocks, clears `pausedThreadId` in `session.json`,
   and runs to the next pause (back to step 2).
5. On `terminated`/`exit`, write `session.json` `live:false` (via
   `projectSessionStatus(null, …)`) and a final `latest.json` `sessionEnded:true` so
   both `get_debug_status` (NOT RUNNING) and `get_pause_state` (stale) report honestly,
   then tear down and stop the heartbeat.

Because the session writes the **same files** the extension writes and services the
**same command files** the extension services, every interactive MCP tool
(`get_pause_state`, `debug_continue`, `debug_step`, `debug_set_variable`,
`evaluate_expression`, `list_variable_names`, `get_variable_values`) works against
the headless session **with no change to those tools.**

### Why a command channel rather than making the MCP tools drive the adapter directly

The MCP server is stdio request/response and may be a short-lived `npx` process; the
live debug adapter + the paused target must outlive any single tool call. The session
is a separate long-lived process (started by a new tool, see below) that owns the
`DapClient`; the stateless MCP tools communicate with it only through the existing
file channel. This mirrors the extension and keeps the MCP server stateless.

## New surface (minimal)

One new MCP tool plus a lifecycle:

- **`start_headless_session`** `{ language, program, args?, breakpoints[], pythonPath?, workspace? }`
  — launches the long-lived interactive session (detached process) and returns once
  the first breakpoint binds (or an actionable error). After it returns,
  `get_pause_state` + the existing `debug_*` tools drive it exactly as in the IDE.
- **`stop_headless_session`** `{ workspace? }` — terminate the session + adapter.
- **`get_capabilities`** already reports headless language readiness and the live-pause
  state; extend its `interactive` block to also report whether a *headless* session is
  live (not just an IDE one).

`collect_trace_headless` stays as the one-shot, fire-and-forget path (it is simpler
and correct for pure observation); interactive mode is the new, opt-in session.

## Implementation checklist

1. **`cli/collector.mjs`** — add an `interactive` option (or a sibling
   `collectInteractive()`), which, instead of auto-`resume()`, parks at each pause and
   polls `agent-command.json`, dispatching to `driver`-level primitives. Needs the
   driver contract to expose the read/mutate/step primitives it currently hides behind
   `resume()` — add `setVariable`, `evaluate`, `step(mode)`, `stackTrace/scopes/variables`
   passthroughs to the contract (they are thin wrappers over `DapClient.request`).
2. **Driver files** (`nodeCdpDriver.mjs`, `pythonDapDriver.mjs`) — implement the new
   passthrough primitives. Node uses CDP, so its driver maps these to CDP equivalents;
   the Python/DAP driver maps straight to DAP requests.
3. **A session runner** (`cli/headless-session.mjs`) — the long-lived process that owns
   the collector in interactive mode and the command-file watcher + ack writer. It is the
   headless analog of `SessionManager`: it mints the synthetic driven id, imports
   `projectSessionStatus`/`HEARTBEAT_MS` from `mcp/callmap.mjs` to write + heartbeat
   `session.json`, stamps `log.ndjson` lines with that id, and writes `captures/latest.json`
   on each pause — the same files the extension writes, so no MCP tool special-cases it.
4. **`mcp/flow-mcp.mjs`** — add `start_headless_session` / `stop_headless_session`
   (spawn/detach + kill the runner) and extend `get_capabilities.interactive` with a
   `headlessSessionLive` field (derived from `evaluateDebugStatus(session.json)` plus a
   check that the driven id is a `headless:*` id). Interactive steering tools
   (`get_pause_state`, `debug_*`, `evaluate_expression`) and `get_debug_status` need **no
   change** — they already read the shared surface.
5. **Guard against double-driving.** Only one producer may own `session.json` at a time.
   `start_headless_session` must refuse (or require an explicit takeover) when
   `evaluateDebugStatus(session.json)` already reports a live IDE session, so a headless
   runner and the extension never both write the status/trace surface. Symmetrically,
   document that starting an IDE session while a headless runner is live is unsupported.
6. **Tests** (extend `cli/collector.test.mjs`) — a Node target that pauses, then assert:
   `session.json` reports `live:true` + `startedBy:'agent'` + a `headless:*` id;
   `get_debug_status` returns RUNNING, PAUSED; `get_pause_state` reports a live pause;
   a `setVariable` command changes the value; `continue` advances to the next pause and
   `session.json` clears `pausedThreadId`; `terminated` flips `session.json` to
   `live:false` and `latest.json` to `sessionEnded:true`; and a call-map tool returns
   this run's tree (the sessionId stamping + `filterLogBySession` path).

## Non-goals / risks

- **Not** reimplementing DAP — `dapClient.mjs` is sufficient.
- **Concurrency**: a multi-threaded target can report two paused threads in a burst
  (already handled in the one-shot loop by serializing pause handling); the interactive
  loop must keep that serialization and make clear which thread a command targets.
- **Staleness**: the capture file outlives the session; the runner must write
  `sessionEnded: true` on teardown so `get_pause_state` cannot mistake a dead session
  for a live pause (the extension path already relies on this).
- **Security**: `setVariable` / `evaluate` writes are previewed-by-default behind a
  confirm token in the MCP tool today; that stays — the headless runner only executes
  what the tool already gated.
- **Single owner of `session.json` (new, from easy-start)**: the extension's
  `SessionManager` and the headless runner are both potential writers of the same status
  and trace surface. They must be mutually exclusive — `start_headless_session` refuses
  when an IDE session is already live, and the runner stamps a `headless:*` id so
  `get_capabilities`/`get_debug_status` can tell which producer is active. Two concurrent
  writers would interleave heartbeats and corrupt the single-stream `log.ndjson` the Call
  Map depends on — the same single-driver rule the extension already enforces, extended
  across the process boundary.

## Effort estimate

Small-to-medium. No new dependencies, no new protocol. The bulk is: (a) a non-resuming
collection loop, (b) exposing step/read/mutate primitives on the two drivers, and
(c) a session runner wiring the existing command-file channel to the live adapter.
The MCP tools and all downstream analysis are reused as-is.
