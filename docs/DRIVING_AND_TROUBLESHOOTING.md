# Driving the Flow Debugger — Field Guide & Troubleshooting

> Written from a real end-to-end session driving the extension via the MCP tools
> against a target service (`document-service`, Express + tsx, port 8004, DynamoDB).
> It documents the **setup pattern that works**, the **failure modes we hit**, and
> the **signal → cause → fix** for each. Read this before driving a new repo so you
> don't rediscover these the hard way.

---

## 1. The setup that actually works (in order)

The pieces must be in place in this order. Skipping or reordering is what caused most
of the pain below.

1. **Stop any plain dev server** on the target port (e.g. `pnpm start:dev` /
   `npx tsx src/index.ts`). It holds the port and is **not** attached to a debugger,
   so breakpoints can never bind. The port must be free for F5 to take it.

2. **Open the panel** — Command Palette → `API Flow Test Debugger: Start`.
   The panel is **empty until a scenario runs** — that is expected, not a bug.

3. **Start the API under the debugger (F5)** with a launch config. Confirm all three:
   - bottom status bar turns **orange**,
   - a floating **debug toolbar** (pause/step/stop) appears,
   - startup log prints on the expected port (watch the **Terminal** tab if the
     config uses `"console": "integratedTerminal"`, *not* the Debug Console).

4. **Only now run a scenario** (MCP `run_scenario`, trigger file, or CLI). The panel
   populates and pauses **after** a run produces pauses.

### How to verify "under the debugger" from outside the UI

An attached Node debug session opens an **inspect port** (often `127.0.0.1:<random>`,
not always 9229). Confirm with:

```bash
PID=$(lsof -nP -iTCP:<PORT> -sTCP:LISTEN -t | head -1)
lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID"   # look for a SECOND 127.0.0.1:<port> LISTEN
```

- Two listening ports on that PID (your app port **+** a localhost inspect port) = attached.
- Only the app port = running but **NOT** under the debugger → breakpoints won't bind.

A healthy endpoint probe is a fast status code (even a 400 from validation). A **hang
/ timeout is good news when a breakpoint is set** — it means the request reached the
handler and is paused. A fast 500 usually means an error fired *before* your breakpoint.

### The easy path (status-first) — fewer steps than the manual sequence above

The manual sequence (stop server → open panel → F5 → run) is the fallback. The quicker
path, and the one an agent should take first:

1. **Call `get_debug_status`** (or read `.flow-debugger/captures/session.json`). It
   answers, without the panel open, whether a session is live, whether it is paused,
   and where obtainable its port/pid — so you never probe `lsof` to find the inspect
   port by hand. The verdict is one of:
   - `NOT RUNNING` — no session; start one (next step).
   - `RUNNING, NOT PAUSED` — a session is live but not at a breakpoint yet.
   - `RUNNING, PAUSED at thread N` — paused and ready to inspect.
   - `STALE` — the status file's heartbeat stopped (older than 15s); the host likely
     crashed. Restart the session; do **not** trust the file as current.
2. **If `NOT RUNNING`, call `start_debug_session`** (no `configName`) or run the
   command **`API Flow Test Debugger: Start Debugging (launch + panel)`**. It launches
   the target under the debugger, opens the panel, and binds the session in one step —
   no separate stop/re-run cycle. With several launch configs it returns `needsChoice`
   (then call `list_debug_configs` or pass a chosen name); with none it synthesizes a
   Node/Python default.
3. **Multiple sessions?** `get_debug_status.otherSessions` lists the live non-driven
   ones; call `use_session { sessionId }` (or the **Switch Driven Session** command) to
   drive the one you want. After switching, `latest.json` and the Call Map tools follow
   the session you selected — a stale pause from the previous session is never served.

If the Call Map tools answer "no trace recorded for the driven session yet," you have
switched to a session that has not run a scenario; run one against it first.

---

## 2. The agent closed loop (what "driving" means)

Once attached, the loop is:

```
run_scenario  →  get_pause_state  →  (judge the data)  →  debug_continue / debug_step / debug_set_variable  →  repeat  →  stop for human only when ambiguous
```

This was verified working: at a pause we read live locals correctly
(`applicantId='app-456'`, `requestID='agent-list'`), and the loop **caught a real
bug** — a `${var}` chain that never resolved (see §4.2). That is the whole point of
the tool: the agent reads runtime data and decides, instead of guessing from source.

`get_pause_state` returns `frame`, `stack`, `scopes[].variables` (with
`variablesReference` for expansion), `dbMode`, `seq`, `at`, `waiting`. Use `seq` +
`at` to confirm a pause is **fresh** and not a stale replay (see §4.1).

---

## 3. Choosing breakpoints (what gave clean, useful pauses)

- Put breakpoints where **data is interesting**: handler entry, right after the
  filter/query object is built, right before/after the DB or external call, and at
  the branch/return.
- To watch a **loop** in the UI, break on a line **inside** the loop body — it pauses
  **once per iteration**, so you see the accumulator grow (e.g. `attributes.length`
  going 0→1→2→3). A loop that runs **before** any DB call is the best demo target
  because it needs no DB/creds.
- Prefer breakpoints on the **`await` line of a service/DB call** so you can inspect
  the argument going in and the value coming back.
- `file` is **repo-root-relative**, `line` is **1-based**. Read the current source and
  derive line numbers — never reuse stale line numbers from an old template.

---

## 4. Failure modes we hit — signal → cause → fix

### 4.1 Stale / frozen pause state (the biggest time sink)

- **Signal:** `get_pause_state` keeps returning the **same `seq` and `at` timestamp**
  across calls; the frame is from a *previous* run (e.g. an error catch block) and the
  `dbMode` doesn't match the run you just fired. `debug_continue` doesn't advance it.
- **Cause:** stacked, undrained paused threads from an earlier failing run wedged the
  pause bridge; it re-emits the cached last pause instead of the new one. Repeated
  failing runs (see §4.4) pile up `step` pauses in an error handler and make this worse.
- **Fix:**
  1. **Stop** the debug session (⏹) — abandons all stale paused threads.
  2. Clear stale captures: `rm -f .flow-debugger/captures/latest.json .flow-debugger/captures/log.ndjson`.
  3. **F5** fresh, then run exactly **one** scenario and read it.
- **Prevention (extension-side, worth doing):** on each `run_scenario`, reset the
  capture/queue and stamp a new run id; on session terminate, clear `latest.json`.
  Consider having `get_pause_state` flag staleness (e.g. return `runId` and whether the
  pause belongs to the current run) so a driver can tell "frozen" from "genuinely paused".

### 4.2 `${var}` chain passes through unresolved

- **Signal:** at a downstream pause, a variable is the literal string `'${docId}'`.
- **Cause:** the earlier call's response had no value at the `extract` JSON path (that
  call errored, or returned an empty/different shape), so the placeholder was never
  filled.
- **Fix:** don't chain off a call that can fail/return empty. Either assert the first
  call succeeds first, or split the calls. When debugging, this is a **real finding** —
  surface it, don't paper over it.

### 4.3 Wrong `envFile` in the launch config → app boots with the wrong/empty env

- **Signal:** F5 starts then the inspect port immediately disappears (process exits),
  or the app behaves differently than under `pnpm start:dev`.
- **Cause:** the debug config pointed at an **empty** env file (`.env.local`) while the
  app's real config lives in `.env` (loaded via `import 'dotenv/config'`). Launching
  with the empty file gave the app a worse env than the normal dev script.
- **Fix:** point the launch config's `envFile` at the file that actually has the values
  the app reads (here `${workspaceFolder}/.env`). Keep `env` overrides (like `PORT`)
  minimal.
- **Gotcha:** `"console": "integratedTerminal"` sends startup logs to the **Terminal**
  tab, not the Debug Console — check there before concluding "nothing happened".

### 4.4 DynamoDB `InvalidSignatureException` / `UnrecognizedClientException`

- **Signal:** fast HTTP 500 from a DB-backed handler; log cause
  `The request signature we calculated does not match…` (or `security token invalid`).
- **Cause:** bad AWS creds in `.env`. Two concrete traps we found:
  - **Duplicate keys**: dotenv keeps the **first** occurrence of a duplicated key and
    ignores later ones — so editing a lower duplicate does nothing.
  - **Wrong-length secret**: a real `AWS_SECRET_ACCESS_KEY` is **exactly 40 chars**; a
    36-char value is truncated/malformed and always fails signing.
- **Fix:** exactly **one** `AWS_ACCESS_KEY_ID` and **one** matching 40-char
  `AWS_SECRET_ACCESS_KEY` (a pair from the same credential), no quotes/trailing spaces.
  Verify **independently** before touching the app:
  ```bash
  AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=… aws sts get-caller-identity
  ```
  Restart the app after editing (env is read once at boot).
- **Or sidestep entirely:** use `dbMode:"mocked"` (see §4.5) so the handler needs no DB.

### 4.5 `dbMode:"mocked"` didn't stub the DB (open issue)

- **Signal:** with `dbMode:"mocked"` + a `mockSetName`, the DB still got hit (same
  signature error), and breakpoints placed **inside the accessor** never fired.
- **Likely cause:** the `boundaryMocks[].match` binding point didn't line up with where
  a pause/interception actually happens. We matched on the DB-util function name
  (`fetchIndexedRecords` / `fetchRecord`) and set breakpoints on the accessor's
  **return** lines, not the **call** lines — so nothing intercepted the call.
- **Status / next step:** confirm in `pauseBridge.ts` how a mock is applied — is it
  **breakpoint-anchored** (needs a breakpoint on the exact DB-call line so the bridge
  substitutes the return there) or **name-hooked** (bridge sets its own breakpoint at
  the symbol)? Document the rule, then align `match` strings + breakpoints accordingly.
  Until then, prefer `dbMode:"real"` against a **pre-DB code path** (e.g. an in-memory
  loop) for demos, or fix creds for real DB reads.

### 4.6 MCP `run_scenario` wrote to `/.flow-debugger` (filesystem root)

- **Signal:** `ENOENT: no such file or directory, mkdir '/.flow-debugger'`.
- **Cause:** the tool didn't know the workspace root, so it resolved the trigger path
  against `/`.
- **Fix:** always pass `workspace` (absolute repo root) to `run_scenario` /
  `set_breakpoints` / `get_pause_state` / `debug_*`.

---

## 5. Mock set format (as used)

A mock set lives at `.flow-debugger/mocks/<name>.json` and is referenced by
`scenario.mockSetName`. Shape used in the session:

```jsonc
{
  "name": "document-get-no-db",
  "language": "node",
  "variableOverrides": {},                 // file:line:var → value, injected at a pause
  "boundaryMocks": [
    { "match": "fetchIndexedRecords",       // matches the DB/external call boundary
      "returns": { "data": [ /* rows */ ] } // MUST match the shape the caller reads
    },
    { "match": "fetchRecord",
      "returns": { /* single record */ } }
  ]
}
```

- Make `returns` match **exactly** what the calling code destructures (e.g. the list
  path read `document.data`, so the mock returns `{ data: [...] }`; the by-id path
  returned the record directly, so the mock returns the bare object).
- See §4.5 for the unresolved question of **where** `match` binds.

---

## 6. Pre-flight checklist (copy/paste before each session)

- [ ] Plain dev server on the target port is **stopped**.
- [ ] Launch config `envFile` points at the env file the app actually reads; `PORT` set.
- [ ] F5 started; **orange bar + debug toolbar** visible; startup log shows the port.
- [ ] Verified a **second (inspect) listening port** on the app PID (§1).
- [ ] `.flow-debugger/captures/` is empty (cleared any stale `latest.json`).
- [ ] Panel open (`API Flow Test Debugger: Start`).
- [ ] For DB-backed paths: creds pass `aws sts get-caller-identity`, **or** use a
      pre-DB code path / a verified mock set.
- [ ] `run_scenario` called **with** `workspace` = absolute repo root.
- [ ] After a failed/aborted run: **Stop → clear captures → F5** before retrying.

---

## 7. Do-not-commit (target repo)

`.flow-debugger/`, `.vscode/launch.json`, and generated tests are **local test
scaffolding** — keep them out of MRs. Steering/AGENTS docs that describe the contract
are fine to share.
