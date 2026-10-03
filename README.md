# Tracegrab

Prove AI-changed code still **behaves correctly** at runtime. Tracegrab drives a
handler with a **sequence of API calls**, traces how data actually flows through it
under the debugger, and lets you — or an AI agent — watch, steer, and verify that
behavior before the change ships.

> VS Code extension + agent-native MCP server + headless CLI. Free and open source
> for every developer; see [TELEMETRY.md](TELEMETRY.md) for our privacy stance.

<!-- Demo GIF goes here once recorded: set breakpoint → run scenario → Call Map + verdict.
     Drop it at media/brand/demo.gif and add: ![Tracegrab in action](media/brand/demo.gif) -->

## Install

- **Cursor / Kiro / Windsurf / VSCodium:** search **Tracegrab** in the Extensions view and
  click Install (these read the [Open VSX](https://open-vsx.org/extension/TraceGrab-KaranSinha/tracegrab)
  registry), or run `cursor --install-extension TraceGrab-KaranSinha.tracegrab`.
- **VS Code:** install the `.vsix` from [GitHub Releases](https://github.com/sinhaKAN-ra/tracegrab/releases)
  via **Extensions → `···` → Install from VSIX** (VS Code Marketplace listing coming soon).
- **Agent / MCP + CLI:** wire the MCP server (`mcp/flow-mcp.mjs`) into your agent — see
  [Usage](#usage) and [AGENTS.md](AGENTS.md). Without this the agent has no tools to drive the debugger.
- **From source:** `git clone`, `npm install`, then press **F5** for the Extension Development Host.


## What it does

- **Sequential API runner** — define an ordered list of HTTP calls; fire them in
  order; chain a field of one response into the next request with `${var}`.
- **Execution flow graph** — with your API running under the VS Code debugger
  (breakpoints in the handler), every pause draws a node so you can trace how data
  moves through each section of the method.
- **Programmatic breakpoints** — the extension **and an AI agent** can set the
  debugger breakpoints from the test scenario (`file:line`, optional `condition`),
  so nobody has to place them by hand. A Breakpoints panel lets a human add / toggle
  / remove them too. It only manages breakpoints it created — your own hand-set
  breakpoints are never touched.
- **Live data editing** — double-click any variable in the Data State Inspector to
  edit it mid-flight (DAP `setVariable`), exactly like a debugger.
- **Mock injection** — save reusable mock sets; `variableOverrides` are re-injected
  at the matching `file:line:var` on the next run, and `boundaryMocks` stub external
  and DB calls.
- **DB: real | mocked** — a per-scenario toggle. `mocked` serves DB calls from the
  boundary mocks so you can test a handler with no database.
- **Unit-test round trip** — import an existing test's fixtures as a mock set, and
  **generate a test** (Jest for Node today) from a recorded run.
- **Language support** — the UI speaks DAP (the Debug Adapter Protocol), so the same
  panels work in principle against any language with a debug adapter. **Tested and
  verified with Node and Python (`debugpy`) only** — other languages (Java, Go, …) may
  work via their DAP adapter but are **not verified**, and we don't claim support yet.

See `docs/FLOW_DEBUGGER_DESIGN.md` for the architecture, build phases, and the
**agent scenario + breakpoints JSON schema**. For the setup pattern, a pre-flight
checklist, and signal→cause→fix for common failures (stale pauses, wrong envFile,
AWS creds, mock binding), see `docs/DRIVING_AND_TROUBLESHOOTING.md`.

## Usage

**Easy start (one step).** Run **`Tracegrab: Start Debugging (launch +
panel)`** from the Command Palette: it launches your API **under the debugger**, opens
the panel, and binds that session as the one the tool drives — no separate stop/re-run
cycle. An AI agent does the same with one `start_debug_session` call (see below).

Then:

1. (Or, the manual path:) start your API under the VS Code debugger (F5) and run
   **`Tracegrab: Start`** to open the panel.
2. Define the API-call sequence, add breakpoints in the **Breakpoints** panel (or let
   an AI agent set them — see below), pick DB `real`/`mocked`, and press
   **Run sequence**. The scenario's breakpoints are applied automatically before the
   calls fire; use **Apply** / **Clear** to manage them on demand.
3. As the debugger pauses, inspect and edit variables live, or load a mock set.
4. Press **Save as unit test** to emit a replayable test from the run.

With more than one debug session live, use **`Tracegrab: Switch Driven
Session`** to pick which one the tool drives.

Mock sets live under `.flow-debugger/mocks/*.json`; generated tests under
`.flow-debugger/generated-tests/`.

### Commands

| Command | Purpose |
|---------|---------|
| `Tracegrab: Start` | Open the panel (does not launch the debuggee). |
| `Tracegrab: Start Debugging (launch + panel)` | **One-step start:** detect/synthesize a launch config, launch under the debugger, open the panel, and bind the session as driven. |
| `Tracegrab: Switch Driven Session` | With several sessions live, pick which one the tool drives. |
| `Tracegrab: Set Breakpoints (from scenario)` | Apply a breakpoints array without running (agent-facing). |
| `Tracegrab: Run Scenario JSON` | Take a full scenario object (breakpoints + calls), set the breakpoints, and run it (agent-facing). |

### Driving it (all modes)

The tool can be driven by a human in the panel, or by an AI agent. An agent produces
a **scenario JSON** (API calls + optional `breakpoints[]`) and hands it to the
extension, which sets the breakpoints and runs the flow. Pick whichever mode your
setup allows — all four end in the same place.

#### Mode 1 — MCP server (recommended, cross-IDE)

`mcp/flow-mcp.mjs` is a zero-dependency stdio MCP server. Register it once with any
MCP-capable agent (Kiro, Cursor, Claude Desktop, …) and the agent **auto-discovers**
what the tool does and when to use it — no per-repo or per-IDE instruction files.

Registration (add to the IDE's MCP config; set `FLOW_WORKSPACE` to the repo under
test, or pass `workspace` per call).

**Zero-clone (recommended)** — once the package is published, no local checkout or
absolute path is needed; `npx` fetches and runs the server (it exposes a
`flow-debugger-mcp` bin and ships only `mcp/` + `cli/`, so the download is small):

```jsonc
{
  "mcpServers": {
    "flow-debugger": {
      "command": "npx",
      "args": ["-y", "ai-debug-visualizer"],
      "env": { "FLOW_WORKSPACE": "/ABSOLUTE/PATH/to/target/repo" }
    }
  }
}
```

**From a local checkout** — point `node` at the server file:

```jsonc
{
  "mcpServers": {
    "flow-debugger": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/tracegrab/mcp/flow-mcp.mjs"],
      "env": { "FLOW_WORKSPACE": "/ABSOLUTE/PATH/to/target/repo" }
    }
  }
}
```

- **Kiro**: `~/.kiro/settings/mcp.json`
- **Cursor**: `~/.cursor/mcp.json` (global) or `<repo>/.cursor/mcp.json` (per-project)
- **Claude Desktop**: `claude_desktop_config.json`

MCP tools exposed (the headline ones; call `get_instructions` for the full list):

**Status & one-step start — call `get_debug_status` first:**

| Tool | What it does |
|------|--------------|
| `get_debug_status` | **Call first.** Reports (without the panel open) whether a session is live, its identity, whether it is **paused**, and where obtainable its **port/pid** — a crisp verdict (`NOT RUNNING` / `RUNNING, NOT PAUSED` / `RUNNING, PAUSED at thread N` / `STALE`). Lists live non-driven sessions in `otherSessions`. |
| `start_debug_session` | **One-step start.** Launches the target under the debugger, opens the panel, and binds it — `configName` is optional (auto-detect one, `needsChoice` for several, synthesize when none). |
| `list_debug_configs` | List the discovered `.vscode/launch.json` config names so you can pick a `configName` without guessing. |
| `use_session` | Switch which live session the tool drives (`sessionId` from `get_debug_status.otherSessions`). |
| `get_capabilities` | **Probe what the server can do** before choosing a drive path: which headless languages are ready (node always; python if debugpy is in the target env), the current debug-session verdict (mirrors `get_debug_status`), the discovered launch-config names, and the drive modes. Cheap and read-only. |

**Autonomous — prefer these:**

| Tool | What it does |
|------|--------------|
| `auto_debug` | **One-call investigation.** Applies breakpoints, fires the calls, records **and auto-resumes** every pause, then returns the call map **plus a diagnosis**: severity-ranked findings (exceptions, N+1, DB fan-out, heap retention, values silently cleared), a verdict, and the call path. No per-pause round-trips. Auto-starts a session when none is live. |
| `analyze_state` | Re-diagnose the recorded trace — findings + verdict + call path. |
| `get_instructions` | The contract + scenario schema (agent reads this first). |

**Reading a trace:**

| Tool | What it does |
|------|--------------|
| `get_call_map` | Full controller→service→DB tree (`summary=true` for a digest). |
| `get_memory_timeline` | Heap across the run: peak, net delta, whether memory was reclaimed. |
| `export_mermaid` | Mermaid sequence diagram to paste into a ticket/MR. |
| `get_pause_state` | Live frame/stack/variables at the current pause. |

**Steering — when you want to change behaviour, not just observe:**

| Tool | What it does |
|------|--------------|
| `run_scenario` | Set breakpoints + fire the API-call sequence. |
| `set_breakpoints` | Place breakpoints without running. |
| `debug_continue` | Resume the paused debugger. |
| `debug_step` | Step `over` / `in` / `out`. |
| `debug_set_variable` | Edit a live variable at the pause. |

**Full agent guide:** `docs/AGENT_AUTOMATION.md` — the one-call flow, what the
diagnosis detects, the recommended agent loop, and how to prove a fix by
comparing verdicts before/after.

> **No scenario JSON is needed to observe.** Capture is registered on every DAP
> `stopped` event, so breakpoints set by hand in the editor gutter plus a request
> fired from **Postman / curl / a browser** are captured identically (those pauses
> are tagged `external` and badged **EXT**). The scenario runner only exists to
> fire the calls for you and chain `${var}`.

The `get_pause_state` + `debug_*` tools close the loop: an agent can **read** the
runtime data at each breakpoint, decide if it's correct, and **steer** — stopping for
the human only when ambiguous.

#### Mode 2 — Trigger file (any file-writing tool)

Write the scenario JSON to `<repo>/.flow-debugger/scenario.json`; the extension
watches that path and auto-runs. Works from any agent that can write a file (e.g.
Cursor's or Kiro's built-in agent) with no MCP setup.

#### Mode 3 — CLI (terminal / CI)

```bash
node cli/flow-run.mjs path/to/scenario.json --workspace <repo>
cat scenario.json | node cli/flow-run.mjs - --workspace <repo>
npm run flow-run -- path/to/scenario.json
```

It writes the trigger file atomically; the running extension picks it up.

#### Mode 4 — VS Code commands (extension-to-extension)

```js
await vscode.commands.executeCommand('tracegrab.runScenarioJson', scenario);
await vscode.commands.executeCommand('tracegrab.setBreakpoints', scenario.breakpoints);
```

The full scenario / breakpoint schema is in `AGENTS.md` and
`docs/FLOW_DEBUGGER_DESIGN.md` (“Agent scenario + breakpoints JSON schema” and
“The agent closed loop”).

## Build & test

```bash
npm install
npm run build      # builds the webview (Vite) then the extension host (tsc)
npm test           # compiles + runs the host-logic test harness (flow runner, mock store, test generator, breakpoint paths)
```

## Package & install the .vsix

```bash
npm install -g @vscode/vsce   # one-time, if you don't have vsce
npm run build                 # ensure webview dist + out/ are current
vsce package                  # emits ai-debug-visualizer-<version>.vsix
```

Install into VS Code either way:

```bash
code --install-extension ai-debug-visualizer-0.0.1.vsix
```

…or in VS Code: **Extensions** panel → **⋯** → **Install from VSIX…** → pick the file.
Then run **`Tracegrab: Start`** from the Command Palette.

## Architecture

- **Extension host** (`src/`, Node/TypeScript): `extension.ts` orchestrates the DAP
  bridge (capture, `setVariable`, mock injection), `flowRunner.ts` fires the
  sequence, `mockStore.ts` persists mock sets, `testGenerator.ts` emits tests,
  `breakpointManager.ts` sets/clears breakpoints via `vscode.debug`,
  `breakpointPath.ts` is the pure path resolver, `protocol.ts` is the shared message
  contract.
- **Webview** (`webview-ui/`, React + React Flow): scenario panel, breakpoints panel,
  flow graph, editable inspector, and the mock/DB panel.
