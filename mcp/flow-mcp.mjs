#!/usr/bin/env node
/**
 * flow-debugger MCP server (Option 3 drive path).
 *
 * A zero-dependency stdio MCP server. Any MCP-capable agent (Cursor, Claude
 * Desktop, KiroCrew, …) can call its tools to drive the API Flow Test Debugger
 * without editor-command access. It writes the same trigger file
 * (<workspace>/.flow-debugger/scenario.json) the extension watches and runs.
 *
 * Tools:
 *   - run_scenario   { scenario, workspace? }  -> writes trigger file, extension runs
 *   - set_breakpoints{ breakpoints, workspace? } -> writes a breakpoints-only scenario
 *
 * Register (Cursor ~/.cursor/mcp.json or workspace .cursor/mcp.json):
 *   { "mcpServers": { "flow-debugger": {
 *       "command": "node",
 *       "args": ["/ABS/PATH/tracegrab/mcp/flow-mcp.mjs"],
 *       "env": { "FLOW_WORKSPACE": "/ABS/PATH/to/target/repo" } } } }
 *
 * The extension must be running (panel opened once) and the target API must be
 * under the debugger for breakpoints to bind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCallTree, toMermaidSequence, summarizeTree, inferState, buildFlowTrace, reportMarkdown, diffTraces, diffMarkdown, createContract, verifyContract, contractToYaml, parseContract, explainResult, evaluateDebugStatus, filterLogBySession, projectSessionStatus, HEARTBEAT_MS, STALE_MS } from './callmap.mjs';
import { availableDrivers } from '../cli/collector.mjs';

const DEFAULT_WORKSPACE = process.env.FLOW_WORKSPACE || process.cwd();

const INSTRUCTIONS = `API Flow Test Debugger — agent guide

WHEN TO USE: the user gives you a ticket, bug, task, or reproduction from ANY source
(Jira, GitHub/GitLab, Linear, Slack, a pasted stack trace, or just "why does endpoint
X do Y") that involves an API/handler whose runtime behaviour you need to see. No
specific platform is required.

WORKFLOW (autonomous — prefer this):
0. FIRST, call get_debug_status (or read .flow-debugger/captures/session.json). It
   tells you unambiguously: NOT RUNNING / RUNNING, NOT PAUSED / RUNNING, PAUSED at
   thread N / STALE — plus the session identity and, where obtainable, port/pid, and
   any live-but-non-driven sessions in otherSessions. You never have to guess the
   port or whether the debugger is up.
   - If NOT RUNNING: call start_debug_session (see step 1).
   - If the verdict hints a non-driven session is paused, or otherSessions shows the
     session you want to drive, call use_session { sessionId } (the id is in
     otherSessions) BEFORE you continue/step/capture, so you act on the right session.
1. If no session is live, call start_debug_session — with NO configName it
   auto-detects a single config, returns needsChoice with the list when there are
   several (then call list_debug_configs or pass a chosen configName), or synthesizes
   a sensible default when there is none. (auto_debug/run_scenario will also
   auto-start one for you when nothing is live.) This replaces the old "ask the user
   to press F5 and open the panel" step — that remains only a manual fallback.
2. Read the ticket/description; identify the endpoint(s) and suspect handler. Read
   the controller + service; pick breakpoint lines (handler entry, after the query is
   built, after the DB/external call, at the branch/return).
3. Call auto_debug ONCE with { scenario: { breakpoints, calls } }. It applies the
   breakpoints, fires the calls, records AND auto-resumes every pause, then returns
   the full call map PLUS a diagnosis: severity-ranked findings (exceptions, N+1,
   DB fan-out, heap growth, values silently cleared), a verdict, and the call path.
   You do NOT need to loop get_pause_state/debug_continue.
4. Act on the findings. Use analyze_state to re-diagnose, get_call_map for the full
   tree, get_memory_timeline for heap detail, export_mermaid for a shareable diagram.

NO EDITOR AVAILABLE (CI, container, or no F5 session)? Use
collect_trace_headless: it launches the program under Node's built-in inspector,
records every pause, and returns the same diagnosis — nothing to install and no
IDE. Everything after it (analyze_state, get_call_map, generate_report,
verify_behavior_contract) works on that trace unchanged.

PROVING A CHANGE:
- save_trace {name:"baseline"} BEFORE editing code, then after the change run
  again and compare_traces {baseline:"baseline"} → REGRESSION / CHANGED /
  EQUIVALENT with the exact deltas (DB-call counts, new N+1, new exceptions,
  state newly cleared, response schema, memory). Noise (uuids/timestamps) is
  normalized, so a difference reported IS a real behavioural change.
- create_behavior_contract {save:true} turns a good run into required behaviour;
  verify_behavior_contract gates a later run and names the exact violated rule.
- generate_report {save:true} produces the shareable report for a ticket/PR.

MANUAL/INTERACTIVE WORKFLOW (when you need to steer a specific pause):run_scenario, then get_pause_state to read the live variables, then
debug_set_variable / debug_continue / debug_step. Use this to change a value
mid-flight and see the effect — not for plain observation.

NOTE — no scenario JSON is required to observe: breakpoints set by hand in the
editor gutter plus a request fired from Postman/curl are captured identically
(such pauses are tagged external). Omit the calls array from auto_debug to arm
breakpoints and record whatever external trigger hits them.

MOCKING THE DB (dbMode "mocked"): interception is real but needs an EXPLICIT
target. A boundary mock must name a module and method:
  { "match": "src/db/WorkflowDynamoAccessor#getWorkflowInternal", "returns": {...} }
  { "match": "src/db/Accessor#ClassName.methodName", "returns": {...} }
A bare substring like "db.getClaim" cannot be resolved and is reported as
unsupported. Injection monkey-patches the method in the live debuggee via DAP
evaluate (Node/CommonJS). ALWAYS read the mockInjection block in the response:
if any result is not "ok", that call hit the REAL dependency and the run was NOT
isolated — a credential/auth error in the trace is the usual symptom.

STALENESS: both get_debug_status and get_pause_state report freshness explicitly.
get_debug_status flags a STALE status file (the heartbeat stopped — the host may
have crashed); get_pause_state flags a stale pause (the capture file outlives the
debug session, so a stale read looks like a live pause). If stale is true, do NOT
treat it as current state — re-run, or restart the session (start_debug_session).

PRECONDITIONS: the easy path needs NO manual steps from the user — call
get_debug_status, then start_debug_session (no configName) if NOT RUNNING, then
drive. Use use_session { sessionId } to pick among several live sessions. MANUAL
FALLBACK (only if the one-step start cannot resolve a config in your environment):
ask the user to open the panel via "API Flow Test Debugger: Start" and press F5.

SCENARIO SCHEMA:
{
  "name": string,
  "dbMode": "real" | "mocked",
  "breakpoints": [ { "file": "src/…/X.ts", "line": 42, "condition"?: string, "label"?: string } ],
  "calls": [ { "name"?: string, "method": "GET|POST|PUT|PATCH|DELETE",
               "url": "http://127.0.0.1:<port>/…", "body"?: string,
               "extract"?: { "var": "$.json.path" } } ]
}
- file is repo-root-relative; line is 1-based.
- \${var} in a url/body is filled from an earlier call's extract (supports $.a.b, $.a[0].b).
- dbMode "real" hits the DB; "mocked" serves DB/external calls from a saved mock set.

Do not commit .flow-debugger/, .vscode/launch.json, or generated tests — local test
scaffolding.`;

function writeScenario(scenario, workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const dir = path.join(ws, '.flow-debugger');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'scenario.json');
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(scenario, null, 2), 'utf8');
    fs.renameSync(tmp, out);
    return out;
}

function readCapture(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'captures', 'latest.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return undefined;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Path to the detached headless-session runner (resolved relative to this module). */
const headlessSessionPath = fileURLToPath(new URL('../cli/headless-session.mjs', import.meta.url));

/** Read the headless-session start artifact (.flow-debugger/captures/headless-start.json). */
function readHeadlessStart(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'captures', 'headless-start.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

/** Assemble a FlowTrace from the CURRENTLY recorded pause log (+ mocks/audit). */
function buildCurrentTrace(workspace, scenarioName) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const log = readLog(workspace);
    if (!log.length) return undefined;
    const roots = buildCallTree(log);
    let audit;
    try {
        const raw = fs.readFileSync(path.join(ws, '.flow-debugger', 'audit.ndjson'), 'utf8');
        audit = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* none */ }
    return buildFlowTrace({
        pauses: log, roots,
        diagnosis: inferState(log, roots),
        scenario: { name: scenarioName || 'recorded run', dbMode: log.some((p) => p.dbMode === 'mocked') ? 'mocked' : 'real' },
        mockInjection: readMockInjection(workspace),
        audit,
    });
}

/** Read a saved trace by name (or path) from .flow-debugger/traces/. */
function readTraceByName(nameOrPath, workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const candidates = [
        nameOrPath,
        path.join(ws, '.flow-debugger', 'traces', nameOrPath),
        path.join(ws, '.flow-debugger', 'traces', `${nameOrPath}.flowtrace.json`),
    ];
    for (const p of candidates) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
    }
    return undefined;
}

/** Read whether dbMode:'mocked' actually intercepted anything on the last run. */
function readMockInjection(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    try {
        return JSON.parse(fs.readFileSync(path.join(ws, '.flow-debugger', 'captures', 'mock-injection.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

/** Start a fresh trace so an autonomous run reports only its own pauses. */
function truncateLog(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const dir = path.join(ws, '.flow-debugger', 'captures');
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'log.ndjson'), '', 'utf8');
    } catch {
        /* best-effort */
    }
}

/** Read .flow-debugger/captures/session.json (the easy-start status surface). */
function readSessionJson(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'captures', 'session.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return undefined;
    }
}

/** Read .flow-debugger/captures/launch-configs.json (the discovery projection). */
function readLaunchConfigsFile(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'captures', 'launch-configs.json');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * easy-start: the driven session id from session.json, or null when there is no
 * status file (older extension / first run) — in which case readLog keeps every
 * line (backward compatible, design §2.3).
 */
function drivenSessionId(workspace) {
    const s = readSessionJson(workspace);
    return s && typeof s.sessionId === 'string' ? s.sessionId : null;
}

/**
 * Parse the append-only pause log into ordered records, carrying each line's
 * sessionId so the trace can be attributed. (easy-start: sessionId is additive.)
 */
function parseLogLines(workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'captures', 'log.ndjson');
    let raw;
    try {
        raw = fs.readFileSync(p, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            const r = JSON.parse(s);
            out.push({
                order: r.seq,
                frame: r.frame,
                stackDepth: r.stackDepth ?? 1,
                vars: r.vars ?? [],
                dbMode: r.dbMode,
                heapUsed: r.heapUsed,
                exception: r.exception,
                sessionId: r.sessionId, // may be undefined (older extension)
            });
        } catch {
            /* skip malformed line */
        }
    }
    return out;
}

/**
 * Read the pause log FILTERED to the driven session (easy-start, design §2.3
 * finding #2). Returns { pauses, belongsToDriven }: pauses are the records the
 * Call Map tools consume (sessionId stripped back off for a stable shape);
 * belongsToDriven is false when the log holds ONLY other sessions' lines, so the
 * call-map tools can report "no trace for the driven session yet" instead of
 * silently serving another session's tree.
 */
function readLogFiltered(workspace) {
    const lines = parseLogLines(workspace);
    const { pauses, belongsToDriven } = filterLogBySession(lines, drivenSessionId(workspace));
    // Strip sessionId back off so buildCallTree's input shape is unchanged.
    const clean = pauses.map(({ sessionId, ...rest }) => rest);
    return { pauses: clean, belongsToDriven };
}

/**
 * Read the append-only pause log into ordered PauseInput records for the tree,
 * FILTERED to the driven session. Backward compatible: with no session.json
 * (older extension) every line is kept.
 */
function readLog(workspace) {
    return readLogFiltered(workspace).pauses;
}

/** The crisp note the call-map tools return when no trace belongs to the driven session. */
const NO_DRIVEN_TRACE = { ok: false, note: 'no trace recorded for the driven session yet — run a scenario against it first' };

function writeCommand(cmd, workspace) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const dir = path.join(ws, '.flow-debugger');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'agent-command.json');
    const tmp = `${out}.tmp`;
    // Unique id so the extension's watcher acts on each command exactly once.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(tmp, JSON.stringify({ id, ...cmd }, null, 2), 'utf8');
    fs.renameSync(tmp, out);
    return id;
}

/**
 * Wait for the extension's ack for a specific command id. Needed for commands
 * that RETURN something (evaluate) or whose success matters (startSession) —
 * fire-and-forget is fine for continue/step but useless for a read.
 */
async function waitForAck(id, workspace, timeoutMs = 8000) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const p = path.join(ws, '.flow-debugger', 'agent-ack.json');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const ack = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (ack && ack.id === id) return ack;
        } catch {
            /* not written yet / mid-write */
        }
        await sleep(120);
    }
    return { id, ok: false, message: `timed out after ${timeoutMs}ms waiting for the extension to answer. Is the panel open and the debugger paused?` };
}

/**
 * easy-start: the one-step start contract (design §3.3). Writes the startDebugging
 * bridge command, waits for the ack, then polls session.json for live:true within
 * the SAME 20000ms budget. Terminal states:
 *   - live:true            → session is up and bound
 *   - pending:true         → ack ok but liveness unconfirmed yet (not a failure)
 *   - needsChoice/needsConfig → the extension could not resolve a config
 *   - ok:false             → VS Code refused / no workspace / bad config
 * `configName` is optional; callers that pass one behave exactly as before.
 */
async function startDebugSession(configName, workspace) {
    const BUDGET = 20000;
    const started = Date.now();
    const cmdId = writeCommand({ action: 'startDebugging', ...(configName ? { configName } : {}) }, workspace);
    const ack = await waitForAck(cmdId, workspace, BUDGET);
    if (!ack.ok) {
        // Surface needsChoice/needsConfig the extension attached to the ack result.
        const r = ack.result && typeof ack.result === 'object' ? ack.result : {};
        return { ok: false, message: ack.message, ...r };
    }
    // Ack ok — poll session.json for liveness within the remaining budget.
    while (Date.now() - started < BUDGET) {
        const status = evaluateDebugStatus(readSessionJson(workspace), Date.now());
        if (status.live) {
            return { ok: true, live: true, sessionId: status.sessionId, name: status.name, configName: status.configName, paused: status.paused === true };
        }
        await sleep(120);
    }
    return { ok: true, live: false, pending: true, message: 'session command accepted but liveness not confirmed yet — call get_debug_status' };
}

/**
 * easy-start: auto-launch gate for run_scenario/auto_debug (design §3.1 Option B).
 * Returns one of:
 *   { proceed:true }                      — a session is already live; run as-is
 *   { proceed:true, launched:true }       — we started one and it is live now
 *   { proceed:false, result }             — needsChoice/needsConfig/pending/failed:
 *                                           surface `result`, do NOT run the scenario
 * Only attempts a launch when the status verdict is NOT RUNNING or STALE; when a
 * session is already live it writes NO startDebugging command (so the extension's
 * already-driven guard is never tripped).
 */
async function autoLaunchGate(workspace) {
    const status = evaluateDebugStatus(readSessionJson(workspace), Date.now());
    if (status.live && !status.stale) return { proceed: true };
    // NOT RUNNING or STALE → attempt the one-step start.
    const res = await startDebugSession(undefined, workspace);
    if (res.ok && res.live) return { proceed: true, launched: true };
    // needsChoice / needsConfig / pending / failure → surface without running.
    return { proceed: false, result: res };
}

const TOOLS = [
    {
        name: 'get_instructions',
        description:
            'READ THIS FIRST. Explains the API Flow Test Debugger and WHEN to use it: ' +
            'whenever the user gives you a ticket, bug, task, or reproduction from ANY ' +
            'source (Jira, GitHub/GitLab, Linear, Slack, a pasted stack trace, or just ' +
            '"why does endpoint X do Y") that involves an API/handler whose runtime ' +
            'behaviour you need to see. Returns the scenario schema, the run + ' +
            'pause-inspection workflow, and preconditions.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'get_capabilities',
        description:
            'PROBE WHAT THIS SERVER CAN DO before you commit to a drive path. Cheap, ' +
            'read-only, no debug session needed. Returns: which headless languages are ' +
            'supported and READY right now (node always; python only if debugpy is ' +
            'installed in the target env); the current debug-session verdict (the same ' +
            'crisp NOT RUNNING / RUNNING / PAUSED / STALE that get_debug_status gives, ' +
            'read from session.json) so you know whether the interactive debug_* tools ' +
            'will work; the discovered .vscode/launch.json config names (for ' +
            'start_debug_session); and the available drive modes. Use this to choose ' +
            'headless vs IDE instead of failing mid-scenario. For the full status detail ' +
            'call get_debug_status; for the config list call list_debug_configs.',
        inputSchema: {
            type: 'object',
            properties: {
                pythonPath: { type: 'string', description: 'Python interpreter to probe for debugpy (default python3 / FLOW_PYTHON).' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'run_scenario',
        description:
            'Debug an API/handler by driving it with a sequence of calls in the API ' +
            'Flow Test Debugger. USE THIS when the user hands you a ticket/bug/task ' +
            '(from ANY platform) about an endpoint and you want to set breakpoints and ' +
            'watch data flow through each handler section — you do not need a specific ' +
            'ticketing tool. It sets the breakpoints and fires the ordered API calls. ' +
            'Provide a scenario object with calls[] and optional breakpoints[] ' +
            '(file, line, condition?, label?). Call get_instructions for the full schema.',
        inputSchema: {
            type: 'object',
            properties: {
                scenario: {
                    type: 'object',
                    description:
                        'Scenario: { name?, dbMode?: "real"|"mocked", mockSetName?, ' +
                        'breakpoints?: [{file,line,condition?,label?}], ' +
                        'calls: [{name?,method,url,body?,extract?}] }',
                },
                workspace: {
                    type: 'string',
                    description: 'Absolute path of the target repo (defaults to FLOW_WORKSPACE).',
                },
            },
            required: ['scenario'],
        },
    },
    {
        name: 'set_breakpoints',
        description:
            'Place debugger breakpoints from a proposed test flow WITHOUT running the ' +
            'API calls. Provide breakpoints[] of {file,line,condition?,label?}.',
        inputSchema: {
            type: 'object',
            properties: {
                breakpoints: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            file: { type: 'string' },
                            line: { type: 'number' },
                            statement: { type: 'string', description: 'Content-addressed: match this statement text instead of trusting the line (survives edits).' },
                            function: { type: 'string', description: 'Content-addressed: match this function/symbol declaration.' },
                            condition: { type: 'string' },
                            label: { type: 'string' },
                        },
                        required: ['file', 'line'],
                    },
                },
                workspace: { type: 'string' },
            },
            required: ['breakpoints'],
        },
    },
    {
        name: 'get_pause_state',
        description:
            'Read the CURRENT debugger pause: the function/frame, call stack, and the ' +
            'live scope variables at the breakpoint. Use this to inspect runtime data ' +
            'and decide whether it is correct before continuing. Returns { waiting } — ' +
            'true means the debugger is paused and awaiting a command.',
        inputSchema: {
            type: 'object',
            properties: { workspace: { type: 'string' } },
        },
    },
    {
        name: 'debug_continue',
        description: 'Resume the paused debugger until the next breakpoint or completion.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'debug_step',
        description: 'Step the paused debugger. mode = over | in | out (default over).',
        inputSchema: {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['over', 'in', 'out'] },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'debug_set_variable',
        description:
            'Edit a live variable at the current pause. PREVIEWED by default: returns ' +
            '{willMutate, currentValue, confirmToken} and changes nothing until you call ' +
            'again with that confirmToken (or pass confirm:true to skip the preview).',
        inputSchema: {
            type: 'object',
            properties: {
                variablesReference: { type: 'number' },
                name: { type: 'string' },
                value: { type: 'string' },
                confirm: { type: 'boolean', description: 'Skip the preview and apply immediately.' },
                confirmToken: { type: 'string', description: 'Apply a previously-previewed change by its token.' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'get_call_map',
        description:
            'Read the whole request lifecycle as a method-grouped Call Map, rebuilt from ' +
            'the recorded pause log — NOT just the current pause. Returns the controller→' +
            'service→DB call tree with inferred data-in/out on each hop, loop hit-counts, ' +
            '⚠ N+1 suspects (a DB method called repeatedly in a loop), per-step mutation ' +
            'diffs (var: old→new), thrown exceptions, and per-method heap delta. Use this ' +
            'to understand how data flowed through the handler and to spot N+1s, unexpected ' +
            'mutations, errors, or memory growth. Set summary=true for a compact digest.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'boolean', description: 'Return a compact digest (methods, N+1 suspects, errors) instead of the full tree.' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'get_memory_timeline',
        description:
            'Read the debuggee heap/memory usage across the run (sampled via ' +
            'process.memoryUsage() at each pause): heapUsed over time, the peak, the ' +
            'net delta, and whether memory was reclaimed (freed) — so you can see how the ' +
            'application dealt with memory and whether it cleared. Use when the user asks ' +
            'about memory/heap behaviour, leaks, or growth.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'export_mermaid',
        description:
            'Export the recorded Call Map as a Mermaid sequence diagram (participants per ' +
            'method, call-down / return-up arrows with inferred data, N+1 and error notes). ' +
            'Paste the result into a ticket, MR, or doc for a shareable trace.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'auto_debug',
        description:
            'AUTONOMOUS INVESTIGATION — the one call to use when you want to understand ' +
            'how an endpoint behaves. Applies breakpoints, fires the API call(s), then ' +
            'automatically records AND resumes every debugger pause (no per-pause ' +
            'round-trip), and returns the full trace: the controller→service→DB call ' +
            'map, inferred data-in/out, loop counts, mutations, exceptions, heap usage, ' +
            'PLUS a severity-ranked diagnosis and a plain-language verdict. Prefer this ' +
            'over run_scenario + get_pause_state + debug_continue loops: it needs no ' +
            'further prompting and returns conclusions, not raw pause data. Requires the ' +
            'target API running under the debugger (F5) and the panel open.',
        inputSchema: {
            type: 'object',
            properties: {
                scenario: {
                    type: 'object',
                    description:
                        'Scenario: { name?, dbMode?, breakpoints?: [{file,line,condition?,label?}], ' +
                        'calls: [{name?,method,url,body?,extract?}] }. Omit `calls` to only arm ' +
                        'breakpoints and record whatever triggers them (e.g. a Postman request).',
                },
                waitMs: { type: 'number', description: 'How long to collect pauses before reporting (default 12000, max 60000).' },
                settleMs: { type: 'number', description: 'Stop early once no new pause arrives for this long (default 2500).' },
                workspace: { type: 'string' },
            },
            required: ['scenario'],
        },
    },
    {
        name: 'analyze_state',
        description:
            'INFER THE SYSTEM STATE from the trace already recorded: returns a ' +
            'severity-ranked list of findings (exceptions, N+1 queries, DB fan-out, heap ' +
            'growth without reclaim, values silently cleared) each with evidence, ' +
            'location and a concrete suggestion, plus an overall verdict and the call ' +
            'path. Use after auto_debug / run_scenario, or any time you want a diagnosis ' +
            'instead of reading raw pause data yourself.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'evaluate_expression',
        description:
            'Evaluate an expression in the CURRENTLY PAUSED frame. Reads run immediately ' +
            'and return the value. WRITES (an assignment like "user.level = 0") are ' +
            'PREVIEWED by default: you get {willMutate, currentValue, confirmToken} and ' +
            'nothing changes until you call again with that confirmToken (or pass ' +
            'confirm:true to skip the preview). Requires the debugger paused at a breakpoint.',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: 'e.g. "newAssignee.userLevel" (read) or "newAssignee.userLevel = 0" (write)' },
                context: { type: 'string', enum: ['repl', 'watch', 'hover'] },
                confirm: { type: 'boolean', description: 'Skip the preview and apply a write immediately.' },
                confirmToken: { type: 'string', description: 'Apply a previously-previewed write by its token.' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'list_variable_names',
        description:
            'List the NAMES and types of variables in the current pause WITHOUT reading ' +
            'any values — least-privilege discovery so you can pick exactly what to read ' +
            'with get_variable_values instead of pulling all of scope into your context.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'get_variable_values',
        description:
            'Read ONLY the named variables at the current pause (max 50, no wildcards) — ' +
            'least-privilege, so unrelated process state never enters your context. Use ' +
            'list_variable_names first to discover what exists. Values are secret-redacted.',
        inputSchema: {
            type: 'object',
            properties: {
                names: { type: 'array', items: { type: 'string' } },
                workspace: { type: 'string' },
            },
            required: ['names'],
        },
    },
    {
        name: 'start_debug_session',
        description:
            'ONE-STEP START — launch the target under the debugger AND open the panel AND ' +
            'bind it as the driven session, so you need not ask the user to press F5. ' +
            'configName is OPTIONAL: with none, it auto-detects a single .vscode/launch.json ' +
            'config, returns needsChoice with the list when there are several (then pass a ' +
            'chosen configName, or call list_debug_configs), or synthesizes a sensible Node/' +
            'Python default when there is none. Returns one of: {live:true,…} (ready), ' +
            '{pending:true,…} (accepted, liveness not confirmed — call get_debug_status), ' +
            '{needsChoice,configs} or {needsConfig,lookedFor}. Call get_debug_status first; ' +
            'use this when it says NOT RUNNING.',
        inputSchema: {
            type: 'object',
            properties: {
                configName: { type: 'string', description: 'OPTIONAL configuration name from .vscode/launch.json. Omit to auto-detect/synthesize.' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'get_debug_status',
        description:
            'CALL THIS FIRST. Reports — WITHOUT the panel being open — whether a debug ' +
            'session is live, its identity (name/config/type), whether it is PAUSED, and ' +
            'where obtainable its port/pid. Returns a crisp verdict: NOT RUNNING / RUNNING, ' +
            'NOT PAUSED / RUNNING, PAUSED at thread N / STALE (the status file is old — the ' +
            'debugger may have crashed). Also lists live but non-driven sessions in ' +
            'otherSessions (use their sessionId with use_session to switch). Read-only and ' +
            'safe to call anytime, even when nothing is or ever was paused.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'list_debug_configs',
        description:
            'List the launch configurations the extension discovered (from .vscode/launch.json ' +
            'and user/workspace settings), so you can pick a configName for start_debug_session ' +
            'without guessing. Returns { configs:[{name,type,request}] }.',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'use_session',
        description:
            'Switch which live debug session this tool DRIVES. Pass a sessionId you read from ' +
            'get_debug_status.otherSessions[i].sessionId. Use this when a human has F5\'d one ' +
            'session and you need to drive another: after this, continue/step/capture act on ' +
            'the session you selected. Returns { ok, message }.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'vscode.DebugSession.id from get_debug_status.otherSessions.' },
                workspace: { type: 'string' },
            },
            required: ['sessionId'],
        },
    },
    {
        name: 'stop_debug_session',
        description: 'Stop the active debug session (agent-owned lifecycle; no human needed).',
        inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    },
    {
        name: 'restart_debug_session',
        description:
            'Restart the debug session: stop it, then start the same config again (or a ' +
            'given configName). Breakpoints set in the editor persist across the restart.',
        inputSchema: { type: 'object', properties: { configName: { type: 'string' }, workspace: { type: 'string' } } },
    },
    {
        name: 'collect_trace_headless',
        description:
            'RECORD A TRACE WITH NO IDE. Launches the target program under a real debugger ' +
            '(Node: built-in inspector, nothing to install; Python: debugpy, which must already be ' +
            'installed in the TARGET project\'s environment), applies breakpoints, records and ' +
            'auto-resumes every pause, and writes the trace — works in CI and containers. Use this ' +
            'when there is no editor session available (or you are running in a pipeline); use ' +
            'auto_debug when the extension + F5 session is live. If language="python" fails with a ' +
            '"debugpy is not installed" error, tell the user to run `pip install debugpy` in the ' +
            'target project\'s own environment (not this tool\'s) and retry — do not silently fall ' +
            'back or guess. After it returns, analyze_state / get_call_map / generate_report / ' +
            'verify_behavior_contract all work on the recorded trace as usual.',
        inputSchema: {
            type: 'object',
            properties: {
                language: { type: 'string', enum: ['node', 'python'], description: 'Default "node". Python requires debugpy in the target environment.' },
                program: { type: 'string', description: 'Entry file to launch, relative to workspace (e.g. "src/server.js" or "app.py").' },
                breakpoints: {
                    type: 'array',
                    description: 'Where to pause: [{ file, line, condition? }] (file relative to workspace, 1-based line).',
                    items: {
                        type: 'object',
                        properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } },
                        required: ['file', 'line'],
                    },
                },
                args: { type: 'array', items: { type: 'string' }, description: 'Args passed to the program.' },
                pythonPath: { type: 'string', description: 'Python interpreter to use (default: python3 on PATH, or FLOW_PYTHON env var). Must be the SAME environment the target program runs in.' },
                timeoutMs: { type: 'number', description: 'Max collection window (default 60000).' },
                workspace: { type: 'string' },
            },
            required: ['program'],
        },
    },
    {
        name: 'start_headless_session',
        description:
            'HOLD A LIVE INTERACTIVE DEBUG SESSION WITH NO IDE. Launches the target program under a ' +
            'real debugger (Node: built-in inspector, nothing to install; Python: debugpy, which must ' +
            'already be installed in the TARGET project\'s environment) as a DETACHED long-lived ' +
            'session, applies breakpoints, and PARKS at each pause instead of auto-resuming. Returns ' +
            'once the first breakpoint binds (or an actionable error). After it returns, drive it ' +
            'exactly as in the IDE: get_pause_state to read the pause, then debug_set_variable / ' +
            'debug_step / debug_continue / evaluate_expression to steer, and the call-map tools to ' +
            'analyze. Only ONE session (IDE or headless) may be live at a time — this refuses to start ' +
            'while another is live. Use stop_headless_session to tear it down. (Use collect_trace_headless ' +
            'instead when you only need a one-shot recorded trace, not interactive steering.)',
        inputSchema: {
            type: 'object',
            properties: {
                language: { type: 'string', enum: ['node', 'python'], description: 'Default "node". Python requires debugpy in the target environment.' },
                program: { type: 'string', description: 'Entry file to launch, relative to workspace (e.g. "src/server.js" or "app.py").' },
                args: { type: 'array', items: { type: 'string' }, description: 'Args passed to the program.' },
                breakpoints: {
                    type: 'array',
                    description: 'Where to pause: [{ file, line, condition? }] (file relative to workspace, 1-based line).',
                    items: {
                        type: 'object',
                        properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } },
                        required: ['file', 'line'],
                    },
                },
                pythonPath: { type: 'string', description: 'Python interpreter to use (default: python3 on PATH, or FLOW_PYTHON env var). Must be the SAME environment the target program runs in.' },
                workspace: { type: 'string' },
            },
            required: ['program', 'breakpoints'],
        },
    },
    {
        name: 'stop_headless_session',
        description:
            'TERMINATE a live headless interactive session started with start_headless_session: kills ' +
            'the detached runner process (and its debug adapter + target) and flips the status surface ' +
            'to NOT RUNNING. Safe to call when nothing is live (reports that nothing was running).',
        inputSchema: {
            type: 'object',
            properties: { workspace: { type: 'string' } },
        },
    },
    {
        name: 'create_behavior_contract',
        description:
            'Derive a RUNTIME BEHAVIOR CONTRACT from the current (correct) run: which ' +
            'methods must run, DB-call ceilings, no-uncaught-exceptions, values that must ' +
            'never be cleared, mocks-must-inject. Asserts SEMANTIC behaviour rather than ' +
            'snapshotting values, so it survives refactors but fails when behaviour drifts. ' +
            'Save it, review it, then gate future runs with verify_behavior_contract.',
        inputSchema: {
            type: 'object',
            properties: {
                scenario: { type: 'string', description: 'Name for the contract.' },
                save: { type: 'boolean', description: 'Write to .flow-debugger/contracts/<scenario>.yaml' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'verify_behavior_contract',
        description:
            'Verify a saved contract against the current run. Returns pass/fail with ' +
            'EXACT evidence per violated rule (rule, expected, actual, location) so you can ' +
            'fix the specific behaviour that drifted. Use this to gate a change.',
        inputSchema: {
            type: 'object',
            properties: {
                contract: { type: 'string', description: 'Contract name or path (under .flow-debugger/contracts/).' },
                workspace: { type: 'string' },
            },
            required: ['contract'],
        },
    },
    {
        name: 'save_trace',
        description:
            'Save the currently recorded run as a named FlowTrace under ' +
            '.flow-debugger/traces/. Do this BEFORE changing code to capture a BASELINE, ' +
            'then run again and use compare_traces to prove whether behaviour changed.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Label, e.g. "baseline" or "after-fix".' },
                scenarioName: { type: 'string' },
                workspace: { type: 'string' },
            },
            required: ['name'],
        },
    },
    {
        name: 'compare_traces',
        description:
            'BEHAVIORAL DIFF — compare a baseline FlowTrace against the current run ' +
            '(or another saved trace) and report what changed about how the code BEHAVES: ' +
            'new/removed methods on the path, DB-call count deltas, new N+1, new exceptions, ' +
            'state newly cleared, response status/schema changes, memory-behaviour changes, ' +
            'and the verdict move. Returns REGRESSION / CHANGED / EQUIVALENT. Noise ' +
            '(uuids, timestamps, request ids) is normalized so it is not reported as a bug. ' +
            'Use this to PROVE a fix: verdict FAILING → LOOKS OK with no regressions.',
        inputSchema: {
            type: 'object',
            properties: {
                baseline: { type: 'string', description: 'Saved trace name (or file path) to compare against.' },
                candidate: { type: 'string', description: 'Saved trace name; omit to use the CURRENT recorded run.' },
                workspace: { type: 'string' },
            },
            required: ['baseline'],
        },
    },
    {
        name: 'generate_report',
        description:
            'Generate a shareable TEST REPORT from the recorded trace: what was tested and ' +
            'what happened — verdict, ranked findings, the controller→service→DB call map ' +
            'with data-in/out, variable mutations (old→new with line), memory (peak/net/' +
            'reclaimed), mock-injection status, and the live-edit audit trail, plus a ' +
            'Mermaid sequence diagram. Returns markdown (paste into a ticket/PR) and can ' +
            'save it to .flow-debugger/reports/. Use after auto_debug or a scenario run.',
        inputSchema: {
            type: 'object',
            properties: {
                save: { type: 'boolean', description: 'Also write the report to .flow-debugger/reports/<id>.md' },
                scenarioName: { type: 'string', description: 'Label for the report header.' },
                workspace: { type: 'string' },
            },
        },
    },
    {
        name: 'get_audit_log',
        description:
            'Read the audit trail of every LIVE MUTATION made this session — setVariable, ' +
            'evaluate-writes, and boundary-mock injections — each with actor (agent/human), ' +
            'target, value, and timestamp. Use to review or report what was changed in the ' +
            'running process. Read-only.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' }, workspace: { type: 'string' } } },
    },
];

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'flow-debugger', version: '0.0.1' },
            },
        };
    }
    if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
        const { name, arguments: a = {} } = params || {};
        try {
            if (name === 'get_instructions') {
                return text(id, INSTRUCTIONS);
            }
            if (name === 'get_capabilities') {
                const drivers = availableDrivers({ pythonPath: a.pythonPath });
                const headlessLanguages = Object.entries(drivers).map(([lang, d]) => ({
                    language: lang,
                    ready: !!d.ok,
                    ...(d.ok ? {} : { reason: d.reason }),
                }));
                // Reuse the easy-start status surface so this agrees with get_debug_status.
                const status = evaluateDebugStatus(readSessionJson(a.workspace), Date.now());
                const launch = readLaunchConfigsFile(a.workspace);
                const configNames = launch && Array.isArray(launch.configs)
                    ? launch.configs.map((c) => c && c.name).filter(Boolean)
                    : [];
                return text(id, JSON.stringify({
                    server: { name: 'flow-debugger', version: '0.0.1', transport: 'stdio' },
                    workspace: a.workspace || DEFAULT_WORKSPACE,
                    headless: {
                        tool: 'collect_trace_headless',
                        languages: headlessLanguages,
                        note: 'collect_trace_headless records a trace and auto-resumes every pause (one-shot, no IDE). For a LIVE interactive session with no IDE — park at each pause and steer with debug_set_variable / debug_step / debug_continue / evaluate_expression — use start_headless_session (and stop_headless_session to end it). Use the IDE path (start_debug_session) when an editor is available.',
                    },
                    debugSession: {
                        verdict: status.verdict,
                        live: status.live,
                        paused: status.paused === true,
                        stale: status.stale === true,
                        sessionId: status.sessionId ?? null,
                        // true iff the live driven session is a headless runner (headless:* id)
                        // rather than an IDE session — same status surface, no new read.
                        headlessSessionLive: status.live === true && typeof status.sessionId === 'string' && status.sessionId.startsWith('headless:'),
                        note: 'Full detail via get_debug_status. The interactive tools (get_pause_state, debug_continue, debug_step, debug_set_variable, evaluate_expression) require live:true and a pause. headlessSessionLive:true means that live session is a headless runner (start_headless_session).',
                    },
                    debugConfigs: {
                        launchConfigsProjected: !!launch,
                        names: configNames,
                        usableWith: 'start_debug_session (pass a name) / list_debug_configs',
                    },
                    driveModes: ['mcp (this server)', 'trigger-file (.flow-debugger/scenario.json)', 'cli (cli/flow-run.mjs)', 'vscode-command'],
                }, null, 2));
            }
            if (name === 'run_scenario') {
                if (!a.scenario || !Array.isArray(a.scenario.calls)) {
                    throw new Error('scenario.calls[] is required');
                }
                // easy-start: auto-launch when nothing is live (design §3.1 Option B).
                const gate = await autoLaunchGate(a.workspace);
                if (!gate.proceed) {
                    return text(id, JSON.stringify({ note: 'did not run — no live debug session could be started automatically.', ...gate.result }, null, 2));
                }
                const out = writeScenario(a.scenario, a.workspace);
                return text(id, `Scenario written to ${out}; the extension will run it.${gate.launched ? ' (auto-started a debug session first.)' : ''}`);
            }
            if (name === 'set_breakpoints') {
                if (!Array.isArray(a.breakpoints)) throw new Error('breakpoints[] is required');
                const out = writeScenario({ name: 'breakpoints-only', calls: [], breakpoints: a.breakpoints }, a.workspace);
                return text(id, `Breakpoints written to ${out}; the extension will apply them.`);
            }
            if (name === 'get_pause_state') {
                const snap = readCapture(a.workspace);
                if (!snap) return text(id, 'No pause captured yet. Run a scenario with breakpoints first.');
                // CRITICAL for agents: a capture file persists after the debug
                // session dies, so a naive read looks like a live pause. Report
                // freshness explicitly instead of letting the agent assume.
                const ageMs = Date.now() - Date.parse(snap.at || 0);
                const stale = snap.sessionEnded === true || !snap.waiting || !Number.isFinite(ageMs) || ageMs > 120000;
                const why = snap.sessionEnded
                    ? 'The debug session has ENDED — this is a historical capture, not a live pause.'
                    : !snap.waiting
                      ? 'The debugger is NOT paused (already resumed) — this is the last recorded pause.'
                      : ageMs > 120000
                        ? `This capture is ${Math.round(ageMs / 1000)}s old — likely from an earlier run.`
                        : undefined;
                return text(id, JSON.stringify({
                    live: !stale,
                    stale,
                    ...(why ? { staleReason: why, advice: 'Re-run auto_debug/run_scenario, or have the user restart the debug session (F5). Do NOT treat this as the current state.' } : {}),
                    ageMs: Number.isFinite(ageMs) ? ageMs : null,
                    sessionId: snap.sessionId ?? null,
                    mockInjection: readMockInjection(a.workspace) ?? undefined,
                    pause: snap,
                }, null, 2));
            }
            if (name === 'debug_continue') {
                writeCommand({ action: 'continue' }, a.workspace);
                return text(id, 'Sent continue.');
            }
            if (name === 'debug_step') {
                const map = { over: 'stepOver', in: 'stepIn', out: 'stepOut' };
                writeCommand({ action: map[a.mode] || 'stepOver' }, a.workspace);
                return text(id, `Sent step ${a.mode || 'over'}.`);
            }
            if (name === 'debug_set_variable') {
                if ((a.variablesReference == null || !a.name) && !a.confirmToken) throw new Error('variablesReference + name required');
                const svId = writeCommand(
                    { action: 'setVariable', variablesReference: a.variablesReference, name: a.name, value: String(a.value ?? ''), confirm: a.confirm, confirmToken: a.confirmToken },
                    a.workspace
                );
                const svAck = await waitForAck(svId, a.workspace);
                return text(id, JSON.stringify(svAck.ok ? svAck.result : { ok: false, error: svAck.message }, null, 2));
            }
            if (name === 'get_call_map') {
                const { pauses: log, belongsToDriven } = readLogFiltered(a.workspace);
                if (!log.length) {
                    // Distinguish "nothing recorded" from "the recorded trace
                    // belongs to a DIFFERENT (non-driven) session" (design §2.3).
                    if (!belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                    return text(id, 'No pauses recorded yet. Run a scenario with breakpoints across your layers first.');
                }
                const roots = buildCallTree(log);
                const payload = a.summary ? summarizeTree(roots) : roots;
                return text(id, JSON.stringify(payload, null, 2));
            }
            if (name === 'get_memory_timeline') {
                const { pauses: log, belongsToDriven } = readLogFiltered(a.workspace);
                if (!log.length && !belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                const samples = log.filter((p) => typeof p.heapUsed === 'number').map((p) => ({ order: p.order, heapUsed: p.heapUsed }));
                if (!samples.length) return text(id, 'No memory samples recorded. Memory is sampled via process.memoryUsage() at each pause (Node debuggee).');
                const used = samples.map((s) => s.heapUsed);
                const peak = Math.max(...used);
                const first = used[0], last = used[used.length - 1];
                const net = last - first;
                const reclaimed = used.some((h, i) => i > 0 && h < used[i - 1]);
                const fmt = (n) => (Math.abs(n) < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
                const summary = {
                    samples: samples.length,
                    heapUsedFirst: fmt(first), heapUsedLast: fmt(last), heapPeak: fmt(peak),
                    netDelta: (net >= 0 ? '+' : '') + fmt(net),
                    memoryReclaimed: reclaimed,
                    note: reclaimed
                        ? 'Heap decreased at least once — GC/free observed (memory cleared during the run).'
                        : 'Heap never decreased across sampled pauses — no reclaim observed (could be normal for a short trace).',
                    timeline: samples,
                };
                return text(id, JSON.stringify(summary, null, 2));
            }
            if (name === 'export_mermaid') {
                const { pauses: log, belongsToDriven } = readLogFiltered(a.workspace);
                if (!log.length) {
                    if (!belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                    return text(id, 'No pauses recorded yet — nothing to export.');
                }
                return text(id, toMermaidSequence(buildCallTree(log)));
            }
            if (name === 'auto_debug') {
                if (!a.scenario || typeof a.scenario !== 'object') throw new Error('scenario object is required');
                const ws = a.workspace;
                const waitMs = Math.min(Math.max(Number(a.waitMs) || 12000, 1000), 60000);
                const settleMs = Math.max(Number(a.settleMs) || 2500, 500);

                // easy-start: auto-launch when nothing is live (design §3.1 Option B).
                const gate = await autoLaunchGate(ws);
                if (!gate.proceed) {
                    return text(id, JSON.stringify({ verdict: 'DID NOT RUN — no live debug session could be started automatically.', ...gate.result }, null, 2));
                }

                // 1. Arm autonomy so every pause is recorded AND auto-resumed.
                writeCommand({ action: 'setAutoContinue', enabled: true }, ws);
                // 2. Clear the previous trace so the report is only this run.
                truncateLog(ws);
                await sleep(150);
                // 3. Apply breakpoints + fire the calls (calls optional: omit to
                //    record whatever an external trigger like Postman produces).
                const scn = { name: 'auto_debug', dbMode: 'real', breakpoints: [], calls: [], ...a.scenario };
                writeScenario(scn, ws);

                // 4. Collect until the trace settles or the window closes.
                const started = Date.now();
                let lastCount = -1;
                let lastChange = Date.now();
                while (Date.now() - started < waitMs) {
                    await sleep(300);
                    const n = readLog(ws).length;
                    if (n !== lastCount) { lastCount = n; lastChange = Date.now(); }
                    else if (n > 0 && Date.now() - lastChange > settleMs) break; // settled
                }
                // 5. Disarm autonomy so the human keeps normal step control.
                writeCommand({ action: 'setAutoContinue', enabled: false }, ws);

                const log = readLog(ws);
                if (!log.length) {
                    return text(id, JSON.stringify({
                        verdict: 'NO DATA — no debugger pause was recorded.',
                        likelyCauses: [
                            'The target API is not running under the debugger (press F5 in the target repo).',
                            'The panel is not open (run "API Flow Test Debugger: Start").',
                            'No breakpoint bound — check that breakpoint file paths are repo-root-relative and the lines are executable.',
                            'The request never reached the handler (wrong URL/port, or it failed before your breakpoint).',
                        ],
                        scenarioUsed: scn,
                    }, null, 2));
                }
                const roots = buildCallTree(log);
                const mi = readMockInjection(ws);
                const notIsolated = scn.dbMode === 'mocked' &&
                    (!mi || !mi.results?.length || mi.results.some((r) => r.status !== 'ok'));
                return text(id, JSON.stringify({
                    ...inferState(log, roots),
                    ...(notIsolated ? {
                        WARNING: 'dbMode was "mocked" but one or more boundary mocks did NOT inject — ' +
                            'those calls hit the REAL dependency, so this run was not isolated. ' +
                            'Check mockInjection below; an auth/credential error in the trace usually means this.',
                    } : {}),
                    mockInjection: mi ?? null,
                    summary: summarizeTree(roots),
                    mermaid: toMermaidSequence(roots),
                }, null, 2));
            }
            if (name === 'analyze_state') {
                const { pauses: log, belongsToDriven } = readLogFiltered(a.workspace);
                if (!log.length) {
                    if (!belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                    return text(id, 'No trace recorded yet. Run auto_debug (or run_scenario) first.');
                }
                const roots = buildCallTree(log);
                return text(id, JSON.stringify(inferState(log, roots), null, 2));
            }
            if (name === 'evaluate_expression') {
                if (!a.expression && !a.confirmToken) throw new Error('expression (or confirmToken) is required');
                const cmdId = writeCommand({ action: 'evaluate', expression: a.expression, context: a.context, confirm: a.confirm, confirmToken: a.confirmToken }, a.workspace);
                const ack = await waitForAck(cmdId, a.workspace);
                return text(id, JSON.stringify(ack.ok ? ack.result : { ok: false, error: ack.message }, null, 2));
            }
            if (name === 'start_debug_session') {
                return text(id, JSON.stringify(await startDebugSession(a.configName, a.workspace), null, 2));
            }
            if (name === 'get_debug_status') {
                const status = readSessionJson(a.workspace);
                return text(id, JSON.stringify(evaluateDebugStatus(status, Date.now()), null, 2));
            }
            if (name === 'list_debug_configs') {
                const file = readLaunchConfigsFile(a.workspace);
                if (!file) {
                    return text(id, JSON.stringify({
                        ok: false,
                        configs: [],
                        note: 'no discovery file yet — update/open the extension (it writes launch-configs.json on activation), or pass configName to start_debug_session directly.',
                    }, null, 2));
                }
                return text(id, JSON.stringify({ ok: true, configs: file.configs ?? [], at: file.at }, null, 2));
            }
            if (name === 'use_session') {
                if (!a.sessionId) throw new Error('sessionId is required (read it from get_debug_status.otherSessions)');
                const cmdId = writeCommand({ action: 'useSession', sessionId: a.sessionId }, a.workspace);
                const ack = await waitForAck(cmdId, a.workspace, 20000);
                return text(id, JSON.stringify({ ok: ack.ok, message: ack.message }, null, 2));
            }
            if (name === 'stop_debug_session') {
                const cid = writeCommand({ action: 'stopSession' }, a.workspace);
                const ack = await waitForAck(cid, a.workspace, 15000);
                return text(id, JSON.stringify({ ok: ack.ok, message: ack.message }, null, 2));
            }
            if (name === 'restart_debug_session') {
                const cid = writeCommand({ action: 'restartSession', configName: a.configName }, a.workspace);
                const ack = await waitForAck(cid, a.workspace, 25000);
                return text(id, JSON.stringify({ ok: ack.ok, message: ack.message }, null, 2));
            }
            if (name === 'list_variable_names') {                const snap = readCapture(a.workspace);
                const names = [];
                for (const sc of (snap?.scopes ?? [])) for (const v of (sc.variables ?? [])) names.push({ name: v.name, type: v.type, scope: sc.name });
                return text(id, JSON.stringify({ count: names.length, names }, null, 2));
            }
            if (name === 'get_variable_values') {
                if (!Array.isArray(a.names) || !a.names.length) throw new Error('names[] is required');
                if (a.names.length > 50) throw new Error('at most 50 names (least-privilege)');
                const want = new Set(a.names);
                const snap = readCapture(a.workspace);
                const out = [];
                for (const sc of (snap?.scopes ?? [])) for (const v of (sc.variables ?? [])) {
                    if (want.has(v.name)) out.push({ name: v.name, value: v.value, type: v.type, scope: sc.name });
                }
                const missing = a.names.filter((n) => !out.some((o) => o.name === n));
                return text(id, JSON.stringify({ variables: out, missing }, null, 2));
            }
            if (name === 'collect_trace_headless') {
                if (!a.program) throw new Error('program is required');
                const ws = a.workspace || DEFAULT_WORKSPACE;
                const { collect } = await import(new URL('../cli/collector.mjs', import.meta.url).href);
                let res;
                try {
                    res = await collect({
                        language: a.language || 'node', program: a.program, args: a.args ?? [],
                        cwd: ws, workspace: ws, breakpoints: a.breakpoints ?? [],
                        totalMs: Number(a.timeoutMs) || 60000, pythonPath: a.pythonPath,
                    });
                } catch (e) {
                    const isPython = (a.language || 'node') === 'python';
                    return text(id, JSON.stringify({
                        ok: false, error: e.message,
                        likelyCauses: isPython ? [
                            'debugpy is not installed in the target Python environment — pip install debugpy there (not in this tool\'s own environment) and retry.',
                            'pythonPath / FLOW_PYTHON points at the wrong interpreter for this project.',
                            'The program path is wrong (it is relative to the workspace).',
                        ] : [
                            'The program path is wrong (it is relative to the workspace).',
                            'This Node build predates the global WebSocket (need Node 22+).',
                            'The program crashed before the inspector attached — check its own output.',
                        ],
                    }, null, 2));
                }
                const unbound = (res.boundBreakpoints ?? []).filter((b) => !b.verified);
                if (!res.pauses) {
                    return text(id, JSON.stringify({
                        ok: false,
                        pauses: 0,
                        boundBreakpoints: res.boundBreakpoints,
                        programOutput: res.programOutput?.slice(0, 2000),
                        likelyCauses: [
                            'No breakpoint was hit — check the file path and that the line is executable.',
                            'The program finished before reaching the breakpoint.',
                        ],
                    }, null, 2));
                }
                // Diagnose immediately so one call gives a conclusion, like auto_debug.
                const log = readLog(a.workspace);
                const roots = buildCallTree(log);
                return text(id, JSON.stringify({
                    ok: true,
                    pauses: res.pauses,
                    boundBreakpoints: res.boundBreakpoints,
                    ...(unbound.length ? { WARNING: `${unbound.length} breakpoint(s) never resolved — those lines were not observed.` } : {}),
                    programOutput: res.programOutput?.slice(0, 2000),
                    ...inferState(log, roots),
                }, null, 2));
            }
            if (name === 'start_headless_session') {
                if (!a.program) throw new Error('program is required');
                if (!Array.isArray(a.breakpoints) || !a.breakpoints.length) throw new Error('breakpoints[] is required');
                const ws = a.workspace || DEFAULT_WORKSPACE;
                // SINGLE-OWNER GUARD: refuse while any session (IDE or another
                // runner) is already live — two writers would corrupt the shared
                // status/trace surface (design §5, non-goals/risks).
                const st = evaluateDebugStatus(readSessionJson(ws), Date.now());
                if (st.live) {
                    return text(id, JSON.stringify({
                        ok: false,
                        error: `a debug session is already live (${st.verdict}) — starting a headless session while one is live (IDE or another runner) is unsupported.`,
                        liveSessionId: st.sessionId ?? null,
                        verdict: st.verdict,
                        advice: 'Stop the current session first (stop_headless_session for a headless one, or end the IDE session), then retry.',
                    }, null, 2));
                }
                // Clear any stale start artifact so we don't read a previous run's verdict.
                try { fs.rmSync(path.join(ws, '.flow-debugger', 'captures', 'headless-start.json'), { force: true }); } catch { /* none */ }
                const cfg = {
                    language: a.language || 'node', program: a.program, args: a.args ?? [],
                    breakpoints: a.breakpoints, pythonPath: a.pythonPath, workspace: ws, cwd: ws,
                };
                const child = spawn(process.execPath, [headlessSessionPath, '--config', JSON.stringify(cfg)], {
                    detached: true, stdio: 'ignore', cwd: ws,
                });
                child.unref();
                // Poll until the session reports live AND the first breakpoint bound.
                const BUDGET = 20000;
                const started = Date.now();
                while (Date.now() - started < BUDGET) {
                    await sleep(120);
                    const status = evaluateDebugStatus(readSessionJson(ws), Date.now());
                    const start = readHeadlessStart(ws);
                    if (start && start.status === 'error') {
                        const isPython = (a.language || 'node') === 'python';
                        return text(id, JSON.stringify({
                            ok: false, error: start.error,
                            likelyCauses: isPython ? [
                                'debugpy is not installed in the target Python environment — pip install debugpy there (not in this tool\'s own environment) and retry.',
                                'pythonPath / FLOW_PYTHON points at the wrong interpreter for this project.',
                                'The program path is wrong (it is relative to the workspace).',
                            ] : [
                                'The program path is wrong (it is relative to the workspace).',
                                'This Node build predates the global WebSocket (need Node 22+).',
                                'The program crashed before the inspector attached — check its own output.',
                            ],
                        }, null, 2));
                    }
                    if (status.live && start && start.bound === true) {
                        return text(id, JSON.stringify({
                            ok: true,
                            sessionId: status.sessionId,
                            verdict: status.verdict,
                            pid: status.pid ?? null,
                            note: 'Headless interactive session is live and parked at the first pause. Use get_pause_state to read it, then debug_step / debug_continue / debug_set_variable / evaluate_expression to steer it, and stop_headless_session to end it.',
                        }, null, 2));
                    }
                }
                // Timed out: report the most actionable state we observed.
                const start = readHeadlessStart(ws);
                const isPython = (a.language || 'node') === 'python';
                return text(id, JSON.stringify({
                    ok: false,
                    error: 'the headless session did not confirm a bound breakpoint within 20s.',
                    lastStartStatus: start?.status ?? null,
                    likelyCauses: isPython ? [
                        'debugpy is not installed in the target Python environment — pip install debugpy there and retry.',
                        'No breakpoint bound — check the file path (relative to the workspace) and that the line is executable.',
                        'The program path is wrong, or it finished before reaching the breakpoint.',
                    ] : [
                        'No breakpoint bound — check the file path (relative to the workspace) and that the line is executable.',
                        'The program path is wrong (it is relative to the workspace).',
                        'This Node build predates the global WebSocket (need Node 22+).',
                        'The program crashed before the inspector attached, or finished before the breakpoint.',
                    ],
                }, null, 2));
            }
            if (name === 'stop_headless_session') {
                const ws = a.workspace || DEFAULT_WORKSPACE;
                const sess = readSessionJson(ws);
                const status = evaluateDebugStatus(sess, Date.now());
                const pid = (sess && typeof sess.pid === 'number') ? sess.pid : (readHeadlessStart(ws)?.pid ?? null);
                if (!status.live && !status.stale) {
                    return text(id, JSON.stringify({ ok: true, note: 'nothing was live — no headless session to stop.' }, null, 2));
                }
                // A STALE session means the heartbeat stopped — the runner has almost
                // certainly already exited, so its recorded pid may have been reused by
                // an unrelated process. Do NOT SIGTERM it (that could kill a bystander);
                // just clear the status file to NOT RUNNING so the surface is honest.
                if (status.stale) {
                    try {
                        const obj = projectSessionStatus(null, [], new Date().toISOString());
                        obj.note = 'headless session was stale (heartbeat stopped); cleared by stop_headless_session without signalling a possibly-reused pid.';
                        const dir = path.join(ws, '.flow-debugger', 'captures');
                        fs.mkdirSync(dir, { recursive: true });
                        const out = path.join(dir, 'session.json');
                        const tmp = `${out}.tmp`;
                        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
                        fs.renameSync(tmp, out);
                    } catch { /* best-effort */ }
                    return text(id, JSON.stringify({ ok: true, note: 'session was stale (runner likely already exited); cleared the status file without killing a possibly-reused pid.', wasStale: true }, null, 2));
                }
                if (!pid) {
                    return text(id, JSON.stringify({ ok: false, error: 'could not find the runner pid to terminate (session.json has no pid).', verdict: status.verdict }, null, 2));
                }
                try { process.kill(pid, 'SIGTERM'); } catch (e) {
                    if (e.code === 'ESRCH') {
                        return text(id, JSON.stringify({ ok: true, note: 'runner process was already gone.' }, null, 2));
                    }
                    throw e;
                }
                // Wait briefly for the runner to flip session.json live:false.
                const BUDGET = 8000;
                const started = Date.now();
                while (Date.now() - started < BUDGET) {
                    await sleep(120);
                    const now = evaluateDebugStatus(readSessionJson(ws), Date.now());
                    if (!now.live) return text(id, JSON.stringify({ ok: true, stoppedPid: pid }, null, 2));
                }
                return text(id, JSON.stringify({ ok: true, stoppedPid: pid, note: 'SIGTERM sent; session.json had not flipped to NOT RUNNING within 8s — it should settle shortly.' }, null, 2));
            }
            if (name === 'create_behavior_contract') {
                const t = buildCurrentTrace(a.workspace, a.scenario);
                if (!t) return text(id, 'No trace recorded yet. Run auto_debug (or a scenario) first.');
                const c = createContract(t, { scenario: a.scenario });
                const yaml = contractToYaml(c);
                let savedTo;
                if (a.save) {
                    const ws = a.workspace || DEFAULT_WORKSPACE;
                    const dir = path.join(ws, '.flow-debugger', 'contracts');
                    fs.mkdirSync(dir, { recursive: true });
                    savedTo = path.join(dir, `${String(c.scenario).replace(/[^\w.-]/g, '_')}.yaml`);
                    fs.writeFileSync(savedTo, yaml, 'utf8');
                }
                return text(id, JSON.stringify({ contract: c, yaml, savedTo,
                    note: 'Review this before gating on it — it asserts the behaviour of the run it came from.' }, null, 2));
            }
            if (name === 'verify_behavior_contract') {
                const ws = a.workspace || DEFAULT_WORKSPACE;
                const tries = [a.contract, path.join(ws, a.contract),
                    path.join(ws, '.flow-debugger', 'contracts', a.contract),
                    path.join(ws, '.flow-debugger', 'contracts', `${a.contract}.yaml`)];
                let raw;
                for (const p of tries) { try { raw = fs.readFileSync(p, 'utf8'); break; } catch { /* next */ } }
                if (!raw) throw new Error(`contract "${a.contract}" not found under .flow-debugger/contracts/`);
                const t = buildCurrentTrace(a.workspace);
                if (!t) return text(id, 'No trace recorded yet — run the scenario first, then verify.');
                const result = verifyContract(parseContract(raw), t);
                return text(id, JSON.stringify({ ...result, explanation: explainResult(result) }, null, 2));
            }
            if (name === 'save_trace') {
                const { belongsToDriven } = readLogFiltered(a.workspace);
                if (!belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                const t = buildCurrentTrace(a.workspace, a.scenarioName);
                if (!t) return text(id, 'No trace recorded yet. Run auto_debug (or a scenario) first.');
                const ws = a.workspace || DEFAULT_WORKSPACE;
                const dir = path.join(ws, '.flow-debugger', 'traces');
                fs.mkdirSync(dir, { recursive: true });
                const file = path.join(dir, `${String(a.name).replace(/[^\w.-]/g, '_')}.flowtrace.json`);
                fs.writeFileSync(file, JSON.stringify(t, null, 2), 'utf8');
                return text(id, JSON.stringify({ saved: file, traceId: t.id, verdict: t.verdict, stats: t.stats }, null, 2));
            }
            if (name === 'compare_traces') {
                const base = readTraceByName(a.baseline, a.workspace);
                if (!base) throw new Error(`baseline trace "${a.baseline}" not found in .flow-debugger/traces/`);
                if (!a.candidate) {
                    const { belongsToDriven } = readLogFiltered(a.workspace);
                    if (!belongsToDriven && parseLogLines(a.workspace).length) return text(id, JSON.stringify(NO_DRIVEN_TRACE, null, 2));
                }
                const cand = a.candidate
                    ? readTraceByName(a.candidate, a.workspace)
                    : buildCurrentTrace(a.workspace);
                if (!cand) throw new Error(a.candidate ? `candidate trace "${a.candidate}" not found` : 'no current run recorded to compare');
                const d = diffTraces(base, cand);
                return text(id, JSON.stringify({ ...d, markdown: diffMarkdown(d) }, null, 2));
            }
            if (name === 'generate_report') {
                const ws = a.workspace || DEFAULT_WORKSPACE;
                const log = readLog(a.workspace);
                if (!log.length) return text(id, 'No trace recorded yet. Run auto_debug (or a scenario) first.');
                const roots = buildCallTree(log);
                // audit trail (live edits) if present
                let audit;
                try {
                    const raw = fs.readFileSync(path.join(ws, '.flow-debugger', 'audit.ndjson'), 'utf8');
                    audit = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                } catch { /* none */ }
                const trace = buildFlowTrace({
                    pauses: log, roots,
                    diagnosis: inferState(log, roots),
                    scenario: { name: a.scenarioName || 'recorded run', dbMode: log.some((p) => p.dbMode === 'mocked') ? 'mocked' : 'real' },
                    mockInjection: readMockInjection(a.workspace),
                    audit,
                });
                const md = reportMarkdown(trace);
                let savedTo;
                if (a.save) {
                    try {
                        const dir = path.join(ws, '.flow-debugger', 'reports');
                        fs.mkdirSync(dir, { recursive: true });
                        savedTo = path.join(dir, `${trace.id}.md`);
                        fs.writeFileSync(savedTo, md, 'utf8');
                    } catch (e) { savedTo = `failed to save: ${e.message}`; }
                }
                return text(id, JSON.stringify({ traceId: trace.id, verdict: trace.verdict, savedTo, markdown: md }, null, 2));
            }
            if (name === 'get_audit_log') {
                const ws = a.workspace || DEFAULT_WORKSPACE;
                let raw = '';
                try { raw = fs.readFileSync(path.join(ws, '.flow-debugger', 'audit.ndjson'), 'utf8'); } catch { /* none yet */ }
                const rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                const limited = a.limit ? rows.slice(-a.limit) : rows;
                return text(id, JSON.stringify({ count: rows.length, entries: limited }, null, 2));
            }
            throw new Error(`unknown tool ${name}`);
        } catch (e) {
            return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } };
        }
    }
    if (method && method.startsWith('notifications/')) return null; // no reply
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

function text(id, s) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: s }] } };
}

// ---- stdio framing: newline-delimited JSON (works with MCP stdio clients) ----
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        void (async () => {
            const reply = await handle(msg);
            if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
        })();
    }
});
