# Roadmap

Tracegrab proves that AI-changed code still **behaves correctly at runtime** —
same internal call path, acceptable database-call counts, no new exceptions,
important state preserved, no memory regression — and lets you gate a change on
that proof.

This page is the honest public view of where the tool is and where it's going.
It describes *capabilities*, not internal planning. Statuses may change; this is
direction, not a commitment.

> Legend: ✅ shipped · 🚧 in progress · 🔭 planned

---

## Shipped

- ✅ **Call Map** — a request-shaped controller → service → DB trace of how data
  actually flows through a handler under the debugger.
- ✅ **Runtime diagnosis** — a verdict plus findings (exceptions, N+1 queries,
  silent state loss, memory growth), not raw stack frames.
- ✅ **Scenario runner** — drive a handler with a sequence of API calls, with
  variable extraction between calls.
- ✅ **Mock injection** — serve a boundary (DB / external call) from a named mock
  set, tied to a scenario.
- ✅ **FlowTrace artifact** — a portable, re-openable trace file, so analysis
  works with no live debugger.
- ✅ **Behavioral diff** — run the same scenario on a baseline and a candidate and
  compare internal behavior (call path, DB counts, response shape, new
  exceptions, state changes), with noise normalization.
- ✅ **Runtime behavior contracts** — assert required semantic behavior (must-call,
  must-not-call, max calls, allowed transitions) and fail a run with exact
  evidence.
- ✅ **Headless collector + CI runner** — run scenarios, compare traces, and verify
  contracts with no IDE, producing machine-readable output.
- ✅ **Report generation** — a shareable Markdown / HTML report of what was tested
  and the result, with every captured stat.
- ✅ **Agent (MCP) interface** — all of the above driveable by an AI agent over
  MCP, including a one-step start and self-reporting status.

### Safety & trust (shipped)

- ✅ **Propose-then-confirm** for any live process mutation — a preview is returned
  before anything is written.
- ✅ **Secret redaction by default** — credential-shaped names and values are
  masked before any value leaves your machine.
- ✅ **Least-privilege reads** — read only the variables you name, not the whole
  scope.
- ✅ **Audit log** of every live mutation (what changed, before/after, by whom).
- ✅ **Fail-closed mock mode** — a scenario aborts rather than silently hitting a
  real dependency when a mock fails to inject.

---

## In progress / planned

- 🚧 **Full Python (debugpy) support in the live IDE session** — the headless
  Python path is already verified end-to-end; the in-IDE live session is being
  brought to parity.
- 🔭 **Causal runtime experiments** — test a hypothesis without editing code
  (set a value at a point, compare baseline vs intervention), with preview,
  confirmation, and automatic restore.
- 🔭 **Change-impact scenario selection** — given a git diff, run only the
  scenarios that touch the changed code, and report untested changed paths.
- 🔭 **More runtimes** via a collector interface, without rewriting the core.

---

## Non-goals

- ❌ Competing on generic step-debugging or raw language-adapter count.
- ❌ Building another API traffic recorder.
- ❌ Generating application code — agents already do that.
- ❌ Failing CI on every inferred anomaly — only contracts and configured policy
  gate a change.

---

## Team & organization features

Tracegrab is open-core. The extension, MCP server, CLI, and all **local,
single-developer** verification are free and open-source (this repository).
Features that only have value **across a team, over time, or that need a
server** — a shared registry, CI policy enforcement, cross-team history, SSO/
audit, and a hosted dashboard — are part of a separate commercial offering and
are not in this repository. See the website for the current plan details.

Want something that isn't here? Open an issue — contributor input shapes this
list.
