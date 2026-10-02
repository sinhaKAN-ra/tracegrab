# The collector Driver contract

`collector.mjs` is language-agnostic. It owns: spawning the settle-loop, noise
filtering, secret redaction, NDJSON writing, and breakpoint bookkeeping. It knows
nothing about CDP or DAP. Everything protocol-specific lives in one file per
language under `cli/collectors/`, implementing this contract:

```js
class SomeLangDriver extends EventEmitter {
  // Static — checked BEFORE spawning anything, so a missing toolchain fails
  // with one clear, actionable message instead of a silent timeout.
  static isAvailable(opts) => { ok: boolean, reason?: string, ... }

  // Launch the target and complete the protocol handshake up to (but not
  // including) resuming execution. After this resolves, breakpoints can be set.
  async connect({ program, args, cwd, env, ...langOpts }) => void

  // Apply breakpoints. Returns [{ file, line, verified?, id?, error? }].
  // `verified` may be provisional — the driver may resolve it further inside
  // captureState/emit, as long as isResolved(id) reflects the final truth by
  // the time collect() finishes.
  async setBreakpoints(breakpoints) => Array<Bound>

  // Release the target to actually start running (Node needs a separate
  // "run" step after --inspect-brk; Python's configurationDone doubles as
  // both "unblock launch" and "run" — every driver still exposes `run()` so
  // collector.mjs has one call site regardless of the underlying protocol).
  async run() => void

  // Final verified status for a breakpoint id returned by setBreakpoints.
  isResolved(id) => boolean

  // Normalize ONE raw pause event (whatever shape the protocol emits) into:
  //   { reason, frame: {name, source, line} | null, stackDepth,
  //     vars: [{name, value, type}], heapUsed?, exception? }
  // vars/values are RAW here — collector.mjs applies noise-filtering and
  // secret redaction centrally so every driver behaves identically.
  async captureState(rawPauseEvent) => NormalizedPause

  // Resume from the pause most recently passed to captureState.
  async resume() => void

  get exited() => boolean   // true once the debuggee process has exited

  close() => void           // best-effort teardown; must not throw
}
```

## OPTIONAL — interactive steering primitives

The one-shot `collect()` loop only ever needs the methods above (`captureState`
then `resume()`). The non-resuming interactive loop (`collectInteractive()`) also
needs to STEER a live pause: step, read deeper, and mutate. These primitives are
OPTIONAL — a driver that implements only the core contract still works for one-shot
collection — but both shipped drivers (Node CDP, Python DAP) implement them. They
are **thin wrappers over the underlying protocol client** (`DapClient.request` for
DAP, CDP `send` for Node); no new protocol code is added.

```js
  // Step the thread paused in the most recent captureState.
  //   'over' -> next / Debugger.stepOver
  //   'in'   -> stepIn / Debugger.stepInto
  //   'out'  -> stepOut / Debugger.stepOut
  async step(mode: 'over' | 'in' | 'out') => void

  // Full stack of the current pause, normalized to:
  //   [{ id, name, source, line }]   (id is a frame handle usable as frameId)
  async stackTrace({ threadId? }) => Array<Frame>

  // Scopes for a frame id (as returned by stackTrace), passthrough shape.
  async scopes({ frameId }) => { scopes: Array<Scope> }

  // Children of a variablesReference, normalized to:
  //   [{ name, value, type, variablesReference }]
  async variables({ variablesReference }) => Array<Variable>

  // Mutate a variable in a scope/container. DAP takes the string value directly;
  // the Node/CDP driver coerces the string best-effort (number/bool/JSON/string).
  async setVariable({ variablesReference, name, value }) => { value, type, variablesReference }

  // Evaluate an expression in a frame. Returns { value, type, variablesReference }.
  //   context defaults to 'repl'; frameId defaults to the top frame of the pause.
  async evaluate({ expression, context?, frameId? }) => { value, type, variablesReference }
```

Rules for interactive primitives:
- `resume()` stays the single one-shot "advance" primitive. The generic loop calls
  `step()` / `resume()` ONLY in interactive mode, driven by an injected command;
  one-shot `collect()` never calls them.
- `variablesReference` is a NUMBER in the loop/MCP contract. DAP uses numeric
  references natively; the Node/CDP driver mints monotonic integer handles (re-minted
  per pause) mapped to CDP string objectIds and resolves them back internally.
- The driver stores the frames/thread of the most recent pause so these primitives
  can target the top frame without the caller tracking protocol state.

Events the driver must emit (via EventEmitter):
- `'paused'` with the RAW protocol pause payload (collector calls `captureState` on it)
- `'terminated'` when the debuggee's execution context/session ends
- `'exit'` with the process exit code (informational)

## Adding a new language

1. Create `cli/collectors/<lang>Driver.mjs` implementing the contract above.
2. Register it in `cli/collector.mjs`'s `DRIVERS` map.
3. No changes needed to: the CLI (`flow-verify collect --lang <lang>`), the MCP
   tool (`collect_trace_headless`), redaction, noise filtering, or anything
   downstream (call-tree, FlowTrace, report, diff, contracts) — they all consume
   the same normalized record shape regardless of source language.

## What does and doesn't require new modules

- **Any language with a CDP or DAP-speaking debugger needs no new dependency**
  in this CLI — `dapClient.mjs` (stdio, Content-Length framing) is already
  generic DAP, so Go (`delve --headless` speaks DAP directly), Java
  (`java-debug` / JDT.LS's DAP server), and Rust (`codelldb`/`lldb-dap`) are all
  "write one driver file" work, not "add a dependency" work.
- **The toolchain itself is always the target project's dependency, not ours**
  — the same way debugpy must live in the target Python environment, a Go
  driver would require the target repo to have `dlv` on PATH. `isAvailable()`
  is where each driver states that requirement and fails loudly if it's absent,
  rather than the collector silently doing nothing.
- **A language with no debugger that speaks CDP/DAP at all** (rare) would need
  a bespoke driver talking whatever wire protocol that debugger uses — still
  just one file, same contract, more implementation work inside it.
