import * as vscode from 'vscode';
import type {
    ToWebview,
    FromWebview,
    StackFrameDTO,
    VariableDTO,
    ScopeDTO,
    Scenario,
    CallResult,
    MockSet,
    Breakpoint,
    MockInjectionReport,
    MockInjectionResult,
} from './protocol.js';
import { spawn } from 'node:child_process';
import { runScenario, type FetchLike } from './flowRunner.js';
import { MockStore } from './mockStore.js';
import { generateTest, type RecordedRun } from './testGenerator.js';
import { BreakpointManager, bpKey } from './breakpointManager.js';
import { resolveResumeThreadId } from './breakpointPath.js';
import { PauseBridge } from './pauseBridge.js';
import { redactValue } from './redact.js';
import { LicenseService } from './licenseService.js';
import { SessionManager, type DrivenState } from './sessionManager.js';
import { esmImport } from './esmImport.js';

let panel: vscode.WebviewPanel | undefined;

// State for the active run that is NOT per-session (UI/mock-set bookkeeping the
// panel owns regardless of which session is driven).
let activeMockSet: MockSet | undefined;
let mockInjectionReport: MockInjectionReport | undefined;
let lastScenario: Scenario | undefined;
let lastResults: CallResult[] = [];
type StoppedMessage = Extract<ToWebview, { kind: 'stopped' }>;
let breakpointManager: BreakpointManager;
let pauseBridge: PauseBridge;
let licenseService: LicenseService;
let extensionUri: vscode.Uri | undefined;

/**
 * easy-start: the single owner of session/pause/trace state. Every value that
 * used to be a module global (stepCounter, pauseCounts, currentCallId,
 * currentRunId, externalRunId, lastCompletedRunId, runAbortController,
 * pauseHistory, currentDbMode, pausedThreadId, pausedSession, prevHeapUsed) now
 * lives PER-SESSION on a DrivenState inside this manager (design §2.2), so a
 * second debug session can never clobber the driven session's trace.
 */
let sessionManager: SessionManager;

/** 5s heartbeat cadence; mirrors HEARTBEAT_MS in mcp/callmap.mjs (design §4.4). */
const HEARTBEAT_MS = 5000;

/**
 * easy-start: a pending one-step start we initiated, used by
 * onDidStartDebugSession to adopt the right session as DRIVEN by name match
 * (design §2.3). `name` is the RESOLVED config name we are about to launch
 * (always known). A 10s expiry timer clears an unconsumed flag so it cannot
 * mislabel a much-later unrelated start.
 */
let pendingStart: { name: string; type?: string; startedBy: 'agent' | 'human'; at: number } | undefined;
let pendingStartTimer: NodeJS.Timeout | undefined;

/**
 * Diagnostic log channel ("Tracegrab"). The extension used to have ZERO logging,
 * which made "panel shows nothing / session.json stays live:false" impossible to
 * diagnose from the user's side. Everything the adoption/write path does now
 * leaves a line here (View → Output → Tracegrab).
 */
let logChannel: vscode.OutputChannel | undefined;
function log(msg: string): void {
    try { logChannel?.appendLine(`[${new Date().toISOString()}] ${msg}`); } catch { /* never break the flow for a log */ }
}

/**
 * VS Code's JS debugger rewrites a launch.json `type:"node"` into `"pwa-node"`
 * (and `type:"python"` into `"debugpy"`) at session-start time, so the raw
 * `session.type` reported by onDidStartDebugSession does NOT equal the config's
 * declared type. Comparing them literally silently drops the pendingStart match
 * (the classic node/pwa-node gotcha). Normalize both sides to a family before
 * comparing so the adopt-as-driven path fires for the session the user launched.
 */
function debugTypeFamily(t: string | undefined): string {
    const s = (t || '').toLowerCase();
    if (/node|pwa-node|js|chrome|pwa-chrome|pwa-msedge|node-terminal/.test(s)) return 'node';
    if (/python|debugpy/.test(s)) return 'python';
    return s;
}
function typesCompatible(declared: string | undefined, actual: string | undefined): boolean {
    if (!declared) return true; // no declared type → name match alone is enough
    return debugTypeFamily(declared) === debugTypeFamily(actual);
}

function setPendingStart(p: { name: string; type?: string; startedBy: 'agent' | 'human' }): void {
    pendingStart = { ...p, at: Date.now() };
    if (pendingStartTimer) clearTimeout(pendingStartTimer);
    pendingStartTimer = setTimeout(() => { pendingStart = undefined; pendingStartTimer = undefined; }, 10_000);
}
function clearPendingStart(): void {
    pendingStart = undefined;
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = undefined; }
}

// Throttle the "external breakpoint hit while panel closed" prompt so a burst
// of pauses (or repeated hits) doesn't stack notifications. Also suppressed for
// the rest of the session once the user picks "Don't show again".
let lastExternalNotifyAt = 0;
let suppressExternalNotify = false;

const DEFAULT_SCENARIO: Scenario = {
    id: 'default',
    name: 'New scenario',
    dbMode: 'real',
    breakpoints: [
        { file: 'src/handler.ts', line: 20, label: 'handler entry', enabled: true },
    ],
    calls: [
        {
            id: 'c1',
            name: 'Example: create',
            method: 'POST',
            url: 'http://127.0.0.1:3000/items',
            body: '{\n  "name": "widget"\n}',
            extract: { itemId: '$.id' },
        },
        {
            id: 'c2',
            name: 'Example: fetch created',
            method: 'GET',
            url: 'http://127.0.0.1:3000/items/${itemId}',
        },
    ],
};

function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/**
 * Headless-collection Python readiness check for the PANEL hint only.
 *
 * Mirrors `PythonDapDriver.isAvailable()` in `cli/collectors/pythonDapDriver.mjs`
 * — duplicated intentionally (like `mcp/callmap.mjs` mirrors the src/*.ts pure
 * modules) so the extension host never needs `cli/**` shipped in the vsix.
 * Keep the two in sync if the detection logic changes.
 *
 * debugpy is a dependency of the TARGET project, not this extension, so a
 * missing debugpy is not an error — it just means the panel shows nothing for
 * this feature (see the `pythonReadiness` message: only sent when a check
 * actually ran, and the webview renders it only when `ready === true`).
 */
function checkPythonReadiness(): Promise<{ ready: boolean; reason?: string; version?: string; python?: string }> {
    const python = process.env.FLOW_PYTHON || 'python3';
    return new Promise((resolve) => {
        const proc = spawn(python, ['-c', 'import debugpy,sys;sys.stdout.write(debugpy.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let settled = false;
        const finish = (result: { ready: boolean; reason?: string; version?: string; python?: string }) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.on('error', (e) => finish({ ready: false, reason: `could not run "${python}": ${e.message}` }));
        proc.on('exit', (code) => {
            if (code === 0) finish({ ready: true, version: out.trim(), python });
            else finish({ ready: false, reason: `debugpy is not installed in "${python}"` });
        });
        setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } finish({ ready: false, reason: 'timed out checking for debugpy' }); }, 4000);
    });
}

/** Resolve this extension's bundled mcp/callmap.mjs uri (for the SessionManager projector). */
function callmapUri(): vscode.Uri {
    return vscode.Uri.joinPath(extensionUri!, 'mcp', 'callmap.mjs');
}

export function activate(context: vscode.ExtensionContext) {
    extensionUri = context.extensionUri;
    logChannel = vscode.window.createOutputChannel('Tracegrab');
    context.subscriptions.push(logChannel);
    log(`activate: workspaceRoot=${workspaceRoot()}  session.json=${workspaceRoot()}/.flow-debugger/captures/session.json`);
    const store = new MockStore(workspaceRoot());
    breakpointManager = new BreakpointManager(workspaceRoot());
    // easy-start: the manager owns the driven session; the bridge resolves its
    // session against the DRIVEN one (not whatever VS Code last focused), which
    // single-handedly fixes "the bridge drives whatever is focused" (design §2.2).
    sessionManager = new SessionManager(workspaceRoot(), callmapUri, log);
    pauseBridge = new PauseBridge(workspaceRoot(), () => sessionManager.get()?.session);
    pauseBridge.register(context, (m) => postToWebview({ kind: 'info', message: m }));
    // Wire the one-step-start / switch callbacks so the bridge delegates to the
    // extension's detection + switch logic instead of duplicating it.
    pauseBridge.setHandlers({
        startDebugging: (configName) => startDebuggingFlow(configName, 'agent'),
        useSession: (sessionId) => switchDrivenSession(sessionId),
    });
    licenseService = new LicenseService(workspaceRoot());
    void licenseService.refresh();

    // easy-start host-reload safety: no debug session survives an extension-host
    // reload, so stamp any leftover session.json to live:false immediately rather
    // than letting a seconds-old heartbeat read as RUNNING (design §2.5).
    //
    // The adopt-already-running reconciliation below is chained AFTER this write
    // resolves, because adoptAsDriven() fires its own session.json write (via
    // touch()); if writeNotLive landed last it would clobber the fresh live:true
    // back to false. activate() stays synchronous — only the two file writes are
    // ordered relative to each other.
    void sessionManager.writeNotLive('host reloaded; previous session did not survive')
        .then(() => {
            // easy-start reconciliation (fixes "panel shows RUNNING but session.json
            // stays live:false"): onDidStartDebugSession only fires for sessions that
            // start AFTER we subscribe, so a debug session already running when the
            // extension host (re)activates — e.g. the user reloads the window to pick
            // up mcp.json while a Tracegrab session is live — is never adopted, and
            // session.json is frozen at the live:false stamp above even though the VS
            // Code debug API still sees it. Adopt it here so the file bridge the MCP
            // tools read reflects reality.
            const alreadyRunning = vscode.debug.activeDebugSession;
            if (alreadyRunning && !sessionManager.get()) {
                log(`activate-reconcile: adopting already-running session "${alreadyRunning.name}" (${alreadyRunning.type})`);
                adoptAsDriven(alreadyRunning, 'human', alreadyRunning.name);
            } else {
                log(`activate-reconcile: nothing to adopt (activeDebugSession=${alreadyRunning ? `"${alreadyRunning.name}"` : 'null'}, alreadyDriven=${!!sessionManager.get()})`);
            }
        });
    // Project the folder's launch configs so an agent can discover names, and
    // keep it fresh on any launch-config change (design §3.2).
    void writeLaunchConfigs();
    sessionManager.startHeartbeat(HEARTBEAT_MS);

    const disposable = vscode.commands.registerCommand('tracegrab.start', () => {
        openPanel(context, store);
    });
    context.subscriptions.push(disposable);

    // easy-start: one-step start (launch under debugger + open panel + bind driven).
    context.subscriptions.push(
        vscode.commands.registerCommand('tracegrab.startDebugging', async (arg?: unknown) => {
            // Opening the panel first so the human watches the session come up.
            openPanel(context, store);
            const configName = typeof arg === 'string' ? arg
                : (arg && typeof arg === 'object' && typeof (arg as { configName?: unknown }).configName === 'string')
                    ? (arg as { configName: string }).configName : undefined;
            const res = await startDebuggingFlow(configName, 'human');
            if (!res.ok) postToWebview({ kind: 'error', message: res.message ?? 'Could not start a debug session.' });
            return res;
        }),
        // easy-start: switch which live session the tool drives (human QuickPick).
        vscode.commands.registerCommand('tracegrab.useSession', async () => {
            const sessions = sessionManager.list();
            if (!sessions.length) { void vscode.window.showInformationMessage('No live debug sessions to switch to.'); return; }
            const pick = await vscode.window.showQuickPick(
                sessions.map((s) => ({ label: s.name, description: `${s.type}${s.driven ? ' (driving)' : ''}${s.paused ? ' · paused' : ''}`, id: s.id })),
                { title: 'Drive which debug session?' }
            );
            if (!pick) return;
            const res = await switchDrivenSession(pick.id);
            postToWebview({ kind: res.ok ? 'info' : 'error', message: res.message ?? '' });
            return res;
        })
    );

    // Refresh the launch-config projection when configs change (design §3.2,
    // finding #11: use onDidChangeConfiguration — NOT a file watcher — so
    // user-level and .code-workspace configs are seen too).
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('launch')) void writeLaunchConfigs();
        })
    );

    // Agent-facing: an AI agent (or any caller) can pass a scenario object with
    // breakpoints + calls; we set the breakpoints programmatically and run it.
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tracegrab.runScenarioJson',
            async (raw: unknown) => {
                const scenario = normalizeScenario(raw);
                await runScenarioObject(scenario, store);
                return { ok: true, breakpoints: scenario.breakpoints.length, calls: scenario.calls.length };
            }
        ),
        // Agent-facing: set breakpoints without running (e.g. from a proposed test flow).
        vscode.commands.registerCommand(
            'tracegrab.setBreakpoints',
            (raw: unknown) => {
                const bps = normalizeBreakpoints(raw);
                const applied = breakpointManager.apply(bps);
                postToWebview({ kind: 'breakpointsApplied', breakpoints: applied });
                return { ok: true, applied: applied.length };
            }
        )
    );

    // Option 1 — trigger file. Watch <workspace>/.flow-debugger/scenario.json;
    // when an AI agent or CLI writes/updates it, auto-run the scenario. This is
    // the drive path that needs no editor-command access from the caller.
    const triggerGlob = new vscode.RelativePattern(
        workspaceRoot(),
        '.flow-debugger/scenario.json'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(triggerGlob);
    const onTrigger = async (uri: vscode.Uri) => {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const scenario = normalizeScenario(JSON.parse(Buffer.from(bytes).toString('utf8')));
            postToWebview({ kind: 'info', message: 'Trigger file changed — running scenario.' });
            await runScenarioObject(scenario, store);
        } catch (err) {
            postToWebview({ kind: 'error', message: `Trigger file error: ${String(err)}` });
        }
    };
    watcher.onDidCreate(onTrigger);
    watcher.onDidChange(onTrigger);
    context.subscriptions.push(watcher);

    context.subscriptions.push(
        // easy-start: adopt a STARTED session as driven (design §2.3). This is now
        // the sole source of the "a session began" side-effects, which used to live
        // on onDidChangeActiveDebugSession (relocated here so the F5 start does not
        // regress). Match rule: name-match only against pendingStart (plus a type
        // cross-check when known); else adopt-as-human when nothing is driven; else
        // track as non-driven WITHOUT touching any capture file.
        vscode.debug.onDidStartDebugSession((session) => {
            let startedBy: 'agent' | 'human' | undefined;
            let configName: string | undefined;
            if (pendingStart && session.name === pendingStart.name
                && typesCompatible(pendingStart.type, session.type)) {
                startedBy = pendingStart.startedBy;
                configName = pendingStart.name;
                clearPendingStart();
            }
            if (startedBy) {
                log(`onDidStartDebugSession: ADOPT-DRIVEN (pendingStart match) name="${session.name}" type="${session.type}" startedBy=${startedBy}`);
                adoptAsDriven(session, startedBy, configName);
            } else if (!sessionManager.get()) {
                // No session driven yet — the common F5 case: bind this one.
                log(`onDidStartDebugSession: ADOPT-HUMAN (nothing driven) name="${session.name}" type="${session.type}" pendingStart=${pendingStart ? `name="${pendingStart.name}" type="${pendingStart.type}"` : 'none'}`);
                adoptAsDriven(session, 'human', undefined);
            } else {
                // A second, unrelated session: track it but do not steal the driver
                // and do not touch any capture file (design §2.3).
                log(`onDidStartDebugSession: TRACK-OTHER (already driving "${sessionManager.get()?.name}") name="${session.name}" type="${session.type}"`);
                sessionManager.track(session, { startedBy: 'human' });
                void sessionManager.touch(); // reproject otherSessions only
            }
        }),
        // easy-start: fully DEMOTED. It writes nothing, resets no trace, posts no
        // session/debugStatus, and never changes the driven pointer (design §2.3
        // finding #5). The "a session began" side-effects moved to adopt, above.
        vscode.debug.onDidChangeActiveDebugSession(() => { /* intentionally inert */ }),
        vscode.debug.onDidTerminateDebugSession((s) => {
            const wasDriven = sessionManager.isDriven(s);
            const st = sessionManager.getById(s.id);
            if (wasDriven && st) {
                st.runAbortController?.abort();
            }
            // Remove from the manager; promote a surviving session if the driven
            // one ended (design §2.3 terminate-promotion).
            const promoted = sessionManager.remove(s.id);
            if (wasDriven) {
                // Stamp the ended session's latest.json historical first (A7).
                void (async () => {
                    await pauseBridge.markSessionEnded();
                    if (promoted) {
                        // Reconcile the capture surface to the promoted session so
                        // get_pause_state cannot return the dead session's pause as
                        // the promoted one's live pause (design §2.3 finding #4).
                        pauseBridge.newSession(promoted.session);
                        if (promoted.pausedThreadId !== undefined && promoted.pauseHistory.length) {
                            // Re-emit its current live pause.
                            await reemitPause(promoted);
                        } else {
                            await pauseBridge.writeNeutral(promoted.session.id);
                        }
                        await sessionManager.touch();
                        postToWebview({ kind: 'session', status: 'started', name: promoted.name, restore: true });
                        postToWebview({ kind: 'debugStatus', status: promoted.pausedThreadId !== undefined ? 'paused' : 'running', threadId: promoted.pausedThreadId });
                    } else {
                        await sessionManager.writeNotLive('no live driven session');
                        postToWebview({ kind: 'session', status: 'ended' });
                        postToWebview({ kind: 'debugStatus', status: 'ended' });
                    }
                })();
            } else {
                // A non-driven session ended: just reproject otherSessions.
                void sessionManager.touch();
            }
        }),
        // Keep the panel's breakpoint list in sync with the editor, so breakpoints
        // the user sets by hand appear alongside scenario/agent-set ones.
        vscode.debug.onDidChangeBreakpoints(() => publishAllBreakpoints())
    );

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker(session: vscode.DebugSession) {
                return {
                    onDidSendMessage: (m: any) => {
                        if (m.type === 'event' && m.event === 'stopped') {
                            const threadId: number | undefined = m.body?.threadId;
                            const reason: string = m.body?.reason ?? 'step';
                            // Update THIS session's state, keyed by session.id, so a
                            // stop on session B cannot clobber a live pause on A.
                            sessionManager.recordStopped(session.id, threadId, new Date().toISOString());
                            // Reproject session.json for EVERY tracked session (so
                            // otherSessions[i].paused stays fresh — design §2.4
                            // finding #5), gating only UI + capture on isDriven.
                            void sessionManager.touch();
                            if (sessionManager.isDriven(session)) {
                                postToWebview({ kind: 'debugStatus', status: 'paused', threadId, reason });
                                void captureAndPublishState(session, threadId, reason);
                            }
                        } else if (m.type === 'event' && m.event === 'continued') {
                            sessionManager.recordResumed(session.id);
                            void sessionManager.touch();
                            if (sessionManager.isDriven(session)) {
                                void pauseBridge.markResumed();
                                postToWebview({ kind: 'debugStatus', status: 'running' });
                            }
                        }
                    },
                };
            },
        })
    );
}

/**
 * easy-start: open the flow-debugger webview panel. Extracted from the original
 * `tracegrab.start` body so the one-step start can open it too (its
 * behaviour is identical to the old `start` command).
 */
function openPanel(context: vscode.ExtensionContext, store: MockStore): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    panel = vscode.window.createWebviewPanel(
        'aiDebugVisualizer',
        'API Flow Test Debugger',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'dist')],
        }
    );
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
    panel.webview.onDidReceiveMessage(
        (msg: FromWebview) => handleWebviewMessage(msg, store),
        undefined,
        context.subscriptions
    );
    panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);

    postToWebview({ kind: 'init', scenario: lastScenario ?? DEFAULT_SCENARIO, mockSets: store.list() });

    // Fire-and-forget: never block panel open on a subprocess spawn. The
    // webview renders nothing for this until (and unless) it resolves ready.
    void checkPythonReadiness().then((r) => postToWebview({ kind: 'pythonReadiness', ...r }));
}

/**
 * easy-start: perform the driven-session side-effects for a newly adopted session
 * (design §2.3). This is the ONE place that resets the trace + capture surface
 * and announces the session; a non-driven adoption performs NONE of this.
 */
function adoptAsDriven(session: vscode.DebugSession, startedBy: 'agent' | 'human', configName?: string): void {
    sessionManager.adopt(session, { startedBy, configName });
    pauseBridge.newSession(session);
    void pauseBridge.resetLog();
    // Read a config-sourced port immediately (no pause needed, design §4.3).
    seedConnectionFromConfig(session);
    log(`adoptAsDriven: driving "${session.name}" (${session.type}) → writing session.json live:true`);
    void sessionManager.touch();
    postToWebview({ kind: 'session', status: 'started', name: session.name });
    postToWebview({ kind: 'debugStatus', status: 'running' });
}

/**
 * easy-start: best-effort pid/port probe at a pause (design §4.3). Node only, once
 * per session (cache-guarded). pid via `process.pid` is reliable; `process.debugPort`
 * is only a LAST-RESORT approximation (defaults to 9229, does not track ephemeral
 * ports) and is only used when no config-sourced port was found — flagged as approx.
 * Results are cached onto the DrivenState and serialized by every later touch().
 */
async function probeConnection(
    session: vscode.DebugSession,
    frameId: number | undefined,
    st: DrivenState | undefined
): Promise<void> {
    if (!st || st.connectionProbed) return;
    const type = (session.type || '').toLowerCase();
    if (!/node|chrome|js|pwa/.test(type)) { st.connectionProbed = true; return; }
    st.connectionProbed = true; // attempt at most once regardless of outcome
    try {
        const pidResp = await session.customRequest('evaluate', { expression: 'process.pid', frameId, context: 'repl' });
        const pid = Number(String(pidResp?.result ?? '').replace(/[^\d]/g, ''));
        if (Number.isFinite(pid) && pid > 0) st.pid = pid;
    } catch { /* best-effort */ }
    // Only fall back to the approximate debugPort if config gave us nothing.
    if (st.port === undefined) {
        try {
            const portResp = await session.customRequest('evaluate', { expression: 'process.debugPort', frameId, context: 'repl' });
            const port = Number(String(portResp?.result ?? '').replace(/[^\d]/g, ''));
            if (Number.isFinite(port) && port > 0) { st.port = port; st.portSource = 'debugPort(approx)'; }
        } catch { /* best-effort */ }
    }
    void sessionManager.touch();
}

/** Read a port off the resolved session.configuration if present (design §4.3). */
function seedConnectionFromConfig(session: vscode.DebugSession): void {
    try {
        const st = sessionManager.getById(session.id);
        if (!st) return;
        const cfg = session.configuration as Record<string, unknown> | undefined;
        const port = cfg && (typeof cfg.port === 'number' ? cfg.port
            : typeof cfg.debugServer === 'number' ? cfg.debugServer : undefined);
        if (typeof port === 'number' && Number.isFinite(port)) {
            st.port = port;
            st.portSource = 'config';
        }
    } catch { /* best-effort */ }
}

/**
 * easy-start: re-emit a session's current live pause to latest.json (used on
 * switch/promotion when the newly driven session is already paused). Builds the
 * snapshot from the live DAP state so get_pause_state sees the right session.
 */
async function reemitPause(st: DrivenState): Promise<void> {
    // Re-emit the CACHED tail pause (no re-capture, no new log line, no fabricated
    // pause — design §2.3). If there is nothing cached, fall back to neutral.
    const tail = st.pauseHistory[st.pauseHistory.length - 1];
    if (st.pausedThreadId === undefined || !tail) {
        await pauseBridge.writeNeutral(st.session.id);
        return;
    }
    try {
        await pauseBridge.reemitLatest(st.session.id, {
            reason: tail.reason,
            runId: tail.runId,
            pauseId: tail.pauseId,
            callId: tail.callId,
            frame: tail.frame,
            stack: tail.stack,
            scopes: tail.scopes,
            dbMode: tail.dbMode,
            exception: tail.exception,
        }, st.pausedThreadId);
    } catch {
        await pauseBridge.writeNeutral(st.session.id);
    }
}

// ---- easy-start: launch-config detection + the one-step start ----

interface LaunchConfigLite {
    name: string;
    type?: string;
    request?: string;
    program?: string;
}

/** Read the folder's launch configurations via the config API (design §3.2). */
function readLaunchConfigs(): LaunchConfigLite[] {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
    const configs = launch.get<Array<Record<string, unknown>>>('configurations') ?? [];
    return configs
        .filter((c) => c && typeof c.name === 'string')
        .map((c) => ({
            name: c.name as string,
            type: typeof c.type === 'string' ? c.type : undefined,
            request: typeof c.request === 'string' ? c.request : undefined,
            program: typeof c.program === 'string' ? c.program : undefined,
        }));
}

/**
 * Project the launch configs to .flow-debugger/captures/launch-configs.json so an
 * agent can discover names via the list_debug_configs tool without any editor
 * access (design §3.2). Best-effort; this is a convenience projection, not the
 * authority (start resolution always re-reads the live config list).
 */
async function writeLaunchConfigs(): Promise<void> {
    try {
        const configs = readLaunchConfigs();
        const root = workspaceRoot();
        const dir = vscode.Uri.file(`${root}/.flow-debugger/captures`);
        await vscode.workspace.fs.createDirectory(dir);
        const file = vscode.Uri.joinPath(dir, 'launch-configs.json');
        const tmp = file.with({ path: file.path + '.tmp' });
        const body = JSON.stringify({ at: new Date().toISOString(), configs }, null, 2);
        await vscode.workspace.fs.writeFile(tmp, Buffer.from(body, 'utf8'));
        await vscode.workspace.fs.rename(tmp, file, { overwrite: true });
    } catch { /* best-effort */ }
}

/** Does a file exist under the workspace? (for synthesized-config entry detection) */
async function fileExists(rel: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(`${workspaceRoot()}/${rel}`));
        return true;
    } catch { return false; }
}

/** Detect a plausible Node entry point for a synthesized launch config (design §3.2). */
async function detectNodeEntry(): Promise<string | undefined> {
    // Prefer package.json main / scripts.start, then common entries.
    try {
        const pkgRaw = await vscode.workspace.fs.readFile(vscode.Uri.file(`${workspaceRoot()}/package.json`));
        const pkg = JSON.parse(Buffer.from(pkgRaw).toString('utf8')) as { main?: string; scripts?: Record<string, string> };
        if (typeof pkg.main === 'string' && await fileExists(pkg.main)) return pkg.main;
    } catch { /* fall through to filename probing */ }
    for (const cand of ['src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'app.js', 'index.js', 'server.js']) {
        if (await fileExists(cand)) return cand;
    }
    return undefined;
}

/** Detect a plausible Python entry point (design §3.2). */
async function detectPythonEntry(): Promise<string | undefined> {
    for (const cand of ['app.py', 'main.py', 'manage.py']) {
        if (await fileExists(cand)) return cand;
    }
    return undefined;
}

type StartResult = { ok: boolean; message?: string; result?: unknown };

/**
 * easy-start: THE one-step start (design §3.1/§3.2/§3.3). Resolve a launch config
 * (caller name → single config → QuickPick for human / needsChoice for agent →
 * synthesized in-memory config, never writing .vscode/launch.json), set
 * pendingStart, launch it, and let onDidStartDebugSession adopt it as driven. The
 * MCP start_debug_session polls session.json for liveness after the ack.
 */
async function startDebuggingFlow(configName: string | undefined, startedBy: 'agent' | 'human'): Promise<StartResult> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return { ok: false, message: 'no workspace folder open' };

    // Guard "already driven" (design §5.3). Only an explicit start reaches this;
    // the MCP auto-launch gate skips when a session is live.
    const current = sessionManager.get();
    if (current) {
        return { ok: false, message: `a debug session is already active (${current.name}); stop or switch it first` };
    }

    const configs = readLaunchConfigs();
    let cfg: string | vscode.DebugConfiguration | undefined;
    let resolvedName: string | undefined;
    let resolvedType: string | undefined;

    if (configName) {
        const match = configs.find((c) => c.name === configName);
        if (!match) {
            return { ok: false, result: { needsChoice: true, configs }, message: `no launch config named "${configName}" — pick one of the listed names` };
        }
        cfg = match.name; resolvedName = match.name; resolvedType = match.type;
    } else if (configs.length === 1) {
        cfg = configs[0].name; resolvedName = configs[0].name; resolvedType = configs[0].type;
    } else if (configs.length > 1) {
        if (startedBy === 'human') {
            const pick = await vscode.window.showQuickPick(
                configs.map((c) => ({ label: c.name, description: `${c.type ?? ''} ${c.request ?? ''}`.trim(), name: c.name, type: c.type })),
                { title: 'Start which debug configuration?' }
            );
            if (!pick) return { ok: false, message: 'start cancelled' };
            cfg = pick.name; resolvedName = pick.name; resolvedType = pick.type;
        } else {
            return { ok: false, result: { needsChoice: true, configs }, message: 'multiple launch configs — call again with a configName' };
        }
    } else {
        // No config: synthesize one in memory (never writes .vscode/launch.json).
        const nodeEntry = await detectNodeEntry();
        if (nodeEntry) {
            resolvedName = 'Flow: launch (auto)';
            resolvedType = 'node';
            cfg = { type: 'node', request: 'launch', name: resolvedName, program: `\${workspaceFolder}/${nodeEntry}` } as vscode.DebugConfiguration;
        } else {
            const pyEntry = await detectPythonEntry();
            if (pyEntry) {
                resolvedName = 'Flow: launch (auto)';
                resolvedType = 'debugpy';
                cfg = { type: 'debugpy', request: 'launch', name: resolvedName, program: `\${workspaceFolder}/${pyEntry}` } as vscode.DebugConfiguration;
            } else {
                return {
                    ok: false,
                    result: {
                        needsConfig: true,
                        lookedFor: ['package.json main', 'src/server.*', 'src/index.*', 'app.js', 'app.py', 'main.py', 'manage.py'],
                    },
                    message: 'no .vscode/launch.json config and no entry point to synthesize — add a config or pass configName',
                };
            }
        }
    }

    setPendingStart({ name: resolvedName!, type: resolvedType, startedBy });
    try {
        const started = await vscode.debug.startDebugging(folder, cfg!);
        if (!started) {
            clearPendingStart();
            return { ok: false, message: `VS Code refused to start "${resolvedName}" — check the config` };
        }
        return { ok: true, message: `starting "${resolvedName}"`, result: { live: true, name: resolvedName, configName: resolvedName } };
    } catch (err) {
        clearPendingStart();
        return { ok: false, message: `startDebugging failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/**
 * easy-start: switch the DRIVEN session to an existing live session (design §2.3).
 * Re-binds the bridge (via the manager pointer the resolver reads) and reconciles
 * the capture surface so session.json.sessionId == latest.json.sessionId
 * immediately. Does NOT reset either session's trace.
 */
async function switchDrivenSession(sessionId: string): Promise<StartResult> {
    if (!sessionManager.drive(sessionId)) {
        return { ok: false, message: 'that session is no longer live' };
    }
    const st = sessionManager.get();
    if (!st) return { ok: false, message: 'that session is no longer live' };
    // The resolver now returns st.session automatically. Reconcile identity:
    pauseBridge.newSession(st.session);
    if (st.pausedThreadId !== undefined && st.pauseHistory.length) {
        await reemitPause(st);
    } else {
        await pauseBridge.writeNeutral(st.session.id);
    }
    await sessionManager.touch();
    postToWebview({ kind: 'session', status: 'started', name: st.name, restore: true });
    postToWebview({ kind: 'debugStatus', status: st.pausedThreadId !== undefined ? 'paused' : 'running', threadId: st.pausedThreadId });
    return { ok: true, message: `now driving ${st.name}` };
}

async function handleWebviewMessage(msg: FromWebview, store: MockStore) {
    // easy-start: panel actions target the DRIVEN session, not whatever VS Code
    // last focused (design §2.2).
    const session = sessionManager.get()?.session ?? vscode.debug.activeDebugSession;
    switch (msg.kind) {
        case 'expand':
            if (session) void expandVariable(session, msg.variablesReference);
            break;
        case 'setVariable':
            if (session) void setVariable(session, msg.variablesReference, msg.name, msg.value);
            else postToWebview({ kind: 'variableSet', ok: false, name: msg.name, message: 'No active debug session' });
            break;
        case 'runScenario':
            void runScenarioCmd(msg.scenario);
            break;
        case 'loadMockSet': {
            const ms = store.load(msg.name);
            if (ms) {
                activeMockSet = ms;
                postToWebview({ kind: 'mockSet', mockSet: ms });
            } else {
                postToWebview({ kind: 'error', message: `Mock set "${msg.name}" not found` });
            }
            break;
        }
        case 'saveMockSet':
            store.save(msg.mockSet);
            activeMockSet = msg.mockSet;
            postToWebview({ kind: 'info', message: `Saved mock set "${msg.mockSet.name}"` });
            postToWebview({ kind: 'init', scenario: lastScenario ?? DEFAULT_SCENARIO, mockSets: store.list() });
            break;
        case 'generateTest':
            void generateTestCmd();
            break;
        case 'applyBreakpoints': {
            const applied = breakpointManager.apply(msg.breakpoints);
            postToWebview({ kind: 'breakpointsApplied', breakpoints: applied, message: `Applied ${applied.filter((b) => b.enabled).length} breakpoint(s)` });
            break;
        }
        case 'clearBreakpoints':
            breakpointManager.clear();
            postToWebview({ kind: 'breakpointsApplied', breakpoints: [], message: 'Cleared breakpoints' });
            break;
        case 'openSource':
            void openSource(msg.file, msg.line);
            break;
        case 'generateReport':
            await generateReportCmd(msg.format);
            break;
        case 'listBaselines':
            await listBaselinesCmd();
            break;
        case 'saveBaseline':
            await saveBaselineCmd(msg.name);
            break;
        case 'compareBaseline':
            await compareBaselineCmd(msg.name);
            break;
        case 'saveContract':
            await saveContractCmd(msg.name);
            break;
        case 'verifyContract':
            await verifyContractCmd(msg.name);
            break;
        case 'openInNewWindow':            // VS Code 1.85+ floating editor windows. The panel is a normal editor
            // tab, so it can be torn out to its own OS window for a big screen.
            try {
                panel?.reveal(undefined, false);
                await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
            } catch (err) {
                postToWebview({
                    kind: 'error',
                    message: `Could not open a new window (needs VS Code/Kiro 1.85+): ${err instanceof Error ? err.message : String(err)}`,
                });
            }
            break;
        case 'continue':
            void controlDebugger('continue');
            break;
        case 'debugControl':
            void controlDebugger(msg.action);
            break;
        case 'cancelRun': {
            const st = sessionManager.get();
            if (st?.runAbortController) {
                st.runAbortController.abort();
                postToWebview({ kind: 'info', message: 'Cancelling the active request…' });
            }
            break;
        }
        case 'ready':
            // The webview is recreated whenever VS Code moves the panel (e.g.
            // "Move Editor into New Window") or reloads it. It renders nothing
            // until it receives `init`, so ALWAYS answer `ready` with the
            // current state — otherwise the panel hangs on "Loading…".
            postToWebview({
                kind: 'init',
                scenario: lastScenario ?? DEFAULT_SCENARIO,
                mockSets: store.list(),
            });
            if (activeMockSet) postToWebview({ kind: 'mockSet', mockSet: activeMockSet });
            // easy-start: rehydrate from the DRIVEN session (not whatever VS Code
            // last focused), so reopening the panel restores the CORRECT session's
            // trace (design §2.5, A6). pauseHistory now lives on the DrivenState.
            const driven = sessionManager.get();
            if (driven) {
                postToWebview({ kind: 'session', status: 'started', name: driven.name, restore: true });
                postToWebview({
                    kind: 'debugStatus',
                    status: driven.pausedThreadId !== undefined ? 'paused' : 'running',
                    threadId: driven.pausedThreadId,
                });
                // Rebuild the exact current UI after panel recreation/new-window.
                // These are cached messages only — DO NOT recapture or persist again.
                for (const pause of driven.pauseHistory) postToWebview(pause);
            }
            void listBaselinesCmd();
            if (driven?.lastCompletedRunId && lastScenario && lastResults.length) {
                postToWebview({
                    kind: 'runFinished', scenarioId: lastScenario.id,
                    runId: driven.lastCompletedRunId, results: lastResults,
                });
            }
            publishAllBreakpoints();
            break;
        case 'saveScenario':
            // Persist the user's edits host-side so a reload / new window / test
            // generation sees the current scenario, not the stale default.
            lastScenario = msg.scenario;
            break;
    }
}

// ---- Flow Runner command ----
async function runScenarioObject(scenario: Scenario, store: MockStore) {
    // Load the named mock set (if any) so DB=mocked / variable overrides apply.
    if (scenario.mockSetName) {
        const ms = store.load(scenario.mockSetName);
        if (ms) {
            activeMockSet = ms;
            postToWebview({ kind: 'mockSet', mockSet: ms });
        }
    }
    breakpointManager.apply(scenario.breakpoints);
    postToWebview({ kind: 'init', scenario, mockSets: store.list() });
    postToWebview({ kind: 'breakpointsApplied', breakpoints: scenario.breakpoints });
    await runScenarioCmd(scenario);
}

async function runScenarioCmd(scenario: Scenario) {
    // easy-start: run state lives on the DRIVEN session's DrivenState (design
    // §2.2). A scenario drives the session this tool is bound to; if nothing is
    // driven yet the HTTP calls still fire (so an external breakpoint can be hit
    // once a session comes up), but there is no per-session trace target.
    const st = sessionManager.get();
    if (st?.runAbortController) {
        postToWebview({ kind: 'error', message: 'A scenario is already running. Cancel it before starting another.' });
        return;
    }

    const runId = `${scenario.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    lastScenario = scenario;
    lastResults = [];
    mockInjectionReport = undefined;
    const controller = new AbortController();
    if (st) {
        st.dbMode = scenario.dbMode;
        st.currentRunId = runId;
        st.externalRunId = undefined;
        st.lastCompletedRunId = undefined;
        st.currentCallId = undefined;
        st.pauseCounts.clear();
        st.pauseHistory = [];
        st.stepCounter = 0;
        st.prevHeapUsed = undefined;
        st.runAbortController = controller;
    }
    // resetLog() is run-start truncation of the driven session's trace (design
    // §2.3 resetLog ownership) — the only destructive clear besides adopt→driven.
    await pauseBridge.resetLog();
    postToWebview({ kind: 'runStarted', scenarioId: scenario.id, runId });

    // Programmatically set the scenario's breakpoints before firing calls.
    if (scenario.breakpoints && scenario.breakpoints.length > 0) {
        const applied = breakpointManager.apply(scenario.breakpoints);
        postToWebview({ kind: 'breakpointsApplied', breakpoints: applied });
    }

    // Mocked mode is ALWAYS fail-closed. No entitlement, no mocks, or one
    // failed injection means no HTTP request is allowed to leave this runner.
    if (scenario.dbMode === 'mocked') {
        const g = licenseService.check('mock.injection');
        if (!g.allowed) {
            postToWebview({ kind: 'error', message: `${g.message} Run ABORTED — no request was sent. Set DB to "real" or unlock mock injection.` });
            postToWebview({ kind: 'runFinished', scenarioId: scenario.id, runId, results: [] });
            if (st) { st.currentRunId = undefined; if (st.runAbortController === controller) st.runAbortController = undefined; }
            return;
        }
        const report = await applyBoundaryMocks(scenario);
        mockInjectionReport = report;
        postToWebview({ kind: 'mockInjection', report });
        void pauseBridge.writeMockInjection(report);
        for (const r of report.results) {
            void pauseBridge.audit({ actor: 'agent', action: 'mockInject', target: r.match, ok: r.status === 'ok', detail: r.status });
        }
        const failed = report.results.filter((r) => r.status !== 'ok');
        if (!report.results.length || failed.length) {
            postToWebview({
                kind: 'error',
                message: !report.results.length
                    ? 'DB is "mocked" but no boundary mocks are defined — run ABORTED before any request (would hit the real DB).'
                    : `${failed.length}/${report.results.length} boundary mock(s) failed to inject — run ABORTED before any request.`,
            });
            postToWebview({ kind: 'runFinished', scenarioId: scenario.id, runId, results: [] });
            if (st) { st.currentRunId = undefined; if (st.runAbortController === controller) st.runAbortController = undefined; }
            return;
        }
        postToWebview({ kind: 'info', message: `Injected ${report.results.length} boundary mock(s).` });
    }

    // Node global fetch adapts to the FetchLike shape.
    const fetchImpl: FetchLike = async (url, init) => {
        const r = await fetch(url, init as RequestInit);
        return { status: r.status, ok: r.ok, text: () => r.text() };
    };

    try {
        const results = await runScenario(scenario, fetchImpl, {
            signal: controller.signal,
            timeoutMs: 30_000,
            onCallStart: (call, index) => {
                if (st) st.currentCallId = call.id;
                postToWebview({ kind: 'callStarted', runId, callId: call.id, name: call.name, index });
            },
            onCallResult: (result) => postToWebview({ kind: 'callResult', runId, result }),
            onCallEnd: (result) => {
                if (st && st.currentCallId === result.callId) st.currentCallId = undefined;
            },
            pauseCountFor: (callId) => st?.pauseCounts.get(callId) ?? 0,
        });
        lastResults = results;
        if (st) st.lastCompletedRunId = runId;
        postToWebview({
            kind: 'runFinished', scenarioId: scenario.id, runId, results,
            cancelled: controller.signal.aborted,
        });
    } catch (err) {
        postToWebview({ kind: 'error', message: `Scenario failed: ${err instanceof Error ? err.message : String(err)}` });
        postToWebview({ kind: 'runFinished', scenarioId: scenario.id, runId, results: [], cancelled: controller.signal.aborted });
    } finally {
        if (st) {
            st.currentCallId = undefined;
            st.currentRunId = undefined;
            if (st.runAbortController === controller) st.runAbortController = undefined;
        }
    }
}

// ---- DAP capture ----
async function captureAndPublishState(
    session: vscode.DebugSession,
    threadId: number | undefined,
    reason: string
) {
    try {
        if (threadId === undefined) {
            const threads = await session.customRequest('threads');
            threadId = threads?.threads?.[0]?.id;
        }
        if (threadId === undefined) return;

        const stackTrace = await session.customRequest('stackTrace', {
            threadId,
            startFrame: 0,
            levels: 20,
        });
        const rawFrames: any[] = stackTrace?.stackFrames ?? [];

        // Real call-stack depth: the `levels: 20` request above TRUNCATES the
        // returned frames, so `rawFrames.length` saturates at 20 and recursion
        // deeper than that stops increasing — which collapses genuine recursion
        // into a single non-recursive node in the Call Map. DAP's stackTrace
        // response carries `totalFrames` = the TRUE total even when stackFrames
        // is truncated, so prefer it. Some adapters omit totalFrames; only then,
        // and only when we actually hit the truncation cap, pay for ONE extra
        // full-stack request (no `levels`) to read the real depth.
        const totalFrames = stackTrace?.totalFrames;
        let stackDepth = (typeof totalFrames === 'number' && totalFrames >= rawFrames.length)
            ? totalFrames
            : rawFrames.length;
        if (!(typeof totalFrames === 'number' && totalFrames >= rawFrames.length) && rawFrames.length === 20) {
            try {
                const fullResp = await session.customRequest('stackTrace', { threadId, startFrame: 0 });
                stackDepth = fullResp?.stackFrames?.length ?? rawFrames.length;
            } catch {
                /* adapter refused a full stack — keep the truncated length */
            }
        }
        const stack: StackFrameDTO[] = rawFrames.map((f) => ({
            id: f.id,
            name: f.name,
            source: f.source?.name,
            line: f.line,
        }));

        const topFrame = rawFrames[0];
        const scopes: ScopeDTO[] = [];
        if (topFrame) {
            const scopeResp = await session.customRequest('scopes', { frameId: topFrame.id });
            for (const scope of scopeResp?.scopes ?? []) {
                if (scope.expensive) {
                    scopes.push({ name: scope.name, variablesReference: scope.variablesReference, variables: [] });
                    continue;
                }
                const varResp = await session.customRequest('variables', {
                    variablesReference: scope.variablesReference,
                });
                scopes.push({
                    name: scope.name,
                    variablesReference: scope.variablesReference,
                    variables: mapVariables(varResp?.variables ?? []),
                });
            }
        }

        // Apply boundary mocks / variable overrides from the active mock set.
        if (activeMockSet && topFrame) {
            await applyMockOverrides(session, scopes, topFrame);
        }

        // Sample debuggee heap/memory via DAP evaluate (Node target). Best-effort.
        // easy-start: the heap baseline is PER-SESSION (design §2.4 finding #9) —
        // switching the driven session must not carry a stale baseline across.
        const memSt = sessionManager.getById(session.id);
        const memory = await sampleMemory(session, topFrame?.id, memSt);

        // easy-start: best-effort pid/port probe (design §4.3). A frame exists only
        // at a pause, so this runs here — once per session, Node only, cached onto
        // the DrivenState; every later touch()/heartbeat just serializes the cache.
        await probeConnection(session, topFrame?.id, memSt);

        // Exception info when this stop is a throw.
        let exception: { message: string; type?: string } | undefined;
        if (/exception|throw/i.test(reason)) {
            exception = await captureException(session, threadId);
        }

        // easy-start: all run/trace state is on THIS session's DrivenState.
        const st = sessionManager.getById(session.id);
        const currentCallId = st?.currentCallId;
        st && (st.stepCounter += 1);
        const stepCounter = st?.stepCounter ?? 1;
        if (st && currentCallId) {
            st.pauseCounts.set(currentCallId, (st.pauseCounts.get(currentCallId) ?? 0) + 1);
        }

        if (memory) memory.order = stepCounter;

        let runId: string;
        if (st?.currentRunId) {
            runId = st.currentRunId;
        } else if (st) {
            runId = st.externalRunId ??= `external-${session.id}-${Date.now().toString(36)}`;
        } else {
            runId = `external-${session.id}-${Date.now().toString(36)}`;
        }
        const pauseId = `${runId}:p${stepCounter}`;
        const stoppedMessage: StoppedMessage = {
            kind: 'stopped',
            reason,
            frame: stack[0] ?? null,
            stack,
            scopes,
            step: stepCounter,
            runId,
            pauseId,
            callId: currentCallId,
            external: !currentCallId,
            dbMode: st?.dbMode ?? 'real',
            memory,
            exception,
        };
        st?.pauseHistory.push(stoppedMessage);
        postToWebview(stoppedMessage);

        // If the panel is CLOSED, postToWebview is a no-op — the pause would be
        // captured to disk but the user watching Postman would see nothing. For
        // an EXTERNAL pause (Postman/curl/browser — no ▶ Run in flight) offer to
        // open the panel. Throttled so a burst of pauses shows one prompt.
        if (!panel && !currentCallId) {
            void notifyExternalPause(stack[0]);
        }

        // Persist the pause snapshot so an out-of-process agent can read it and steer.
        void pauseBridge.writePause(
            {
                reason,
                runId,
                pauseId,
                callId: currentCallId,
                frame: stack[0] ?? null,
                stack,
                stackDepth,
                scopes,
                dbMode: st?.dbMode ?? 'real',
                memory,
                exception,
            },
            threadId
        );
    } catch (err) {
        postToWebview({ kind: 'error', message: `Failed to capture debug state: ${String(err)}` });
    }
}

/** Control the exact currently-paused thread (or stop its session). */
async function controlDebugger(action: 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'stop') {
    // easy-start: control the DRIVEN session, not whatever VS Code last focused.
    const st = sessionManager.get();
    const session = st?.session ?? vscode.debug.activeDebugSession;
    if (!session) {
        postToWebview({ kind: 'info', message: 'No active debug session.' });
        return;
    }
    if (action === 'stop') {
        try {
            await vscode.debug.stopDebugging(session);
        } catch (err) {
            postToWebview({ kind: 'error', message: `Stop failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
    }

    let threadId = st?.pausedThreadId;
    if (threadId === undefined) {
        try {
            const threads = await session.customRequest('threads');
            threadId = resolveResumeThreadId(undefined, threads?.threads);
        } catch { /* fall through to the guard below */ }
    }
    if (threadId === undefined) {
        postToWebview({ kind: 'info', message: 'No paused thread to control.' });
        return;
    }
    const command = {
        continue: 'continue', stepOver: 'next', stepIn: 'stepIn', stepOut: 'stepOut',
    }[action];
    try {
        await pauseBridge.markResumed();
        await session.customRequest(command, { threadId });
        if (st) st.pausedThreadId = undefined;
        postToWebview({ kind: 'debugStatus', status: 'running' });
    } catch (err) {
        postToWebview({ kind: 'error', message: `${action} failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}

/** Prompt the user to open the panel when an external (Postman/curl) breakpoint
 * hits and the panel is closed — otherwise the pause is invisible in the UI.
 * Throttled to at most one prompt per 10s, and permanently silenceable. */
async function notifyExternalPause(top: StackFrameDTO | null) {
    if (suppressExternalNotify) return;
    const now = Date.now();
    if (now - lastExternalNotifyAt < 10_000) return;
    lastExternalNotifyAt = now;

    const where = top ? `${top.name}${top.source ? ` (${top.source}:${top.line})` : ''}` : 'your code';
    const OPEN = 'Open panel';
    const NEVER = "Don't show again";
    const choice = await vscode.window.showInformationMessage(
        `API Flow Test Debugger: a breakpoint at ${where} was hit by an external request (Postman/curl/browser). Open the panel to inspect it.`,
        OPEN, NEVER
    );
    if (choice === OPEN) {
        // The webview's `ready` handler replays pauseHistory losslessly. Do NOT
        // call captureAndPublishState here: that would increment the pause,
        // write it to NDJSON again, and fabricate a loop/N+1 hit.
        await vscode.commands.executeCommand('tracegrab.start');
    } else if (choice === NEVER) {
        suppressExternalNotify = true;
    }
}

/** Set any variable whose file:line:name matches a variableOverride entry. */
async function applyMockOverrides(
    session: vscode.DebugSession,
    scopes: ScopeDTO[],
    topFrame: any
) {
    if (!activeMockSet) return;
    const file = topFrame.source?.name ?? '?';
    const line = topFrame.line;
    for (const scope of scopes) {
        for (const v of scope.variables) {
            const key = `${file}:${line}:${v.name}`;
            const override = activeMockSet.variableOverrides[key];
            if (override !== undefined) {
                try {
                    await session.customRequest('setVariable', {
                        variablesReference: scope.variablesReference,
                        name: v.name,
                        value: override,
                    });
                    v.value = override;
                    postToWebview({ kind: 'info', message: `Injected mock ${key} = ${override}` });
                } catch {
                    /* not settable at this stop */
                }
            }
        }
    }
}

async function expandVariable(session: vscode.DebugSession, variablesReference: number) {
    try {
        const varResp = await session.customRequest('variables', { variablesReference });
        postToWebview({
            kind: 'variables',
            variablesReference,
            variables: mapVariables(varResp?.variables ?? []),
        });
    } catch (err) {
        postToWebview({ kind: 'error', message: `Failed to expand ${variablesReference}: ${String(err)}` });
    }
}

/** Live edit: DAP setVariable. This is the "modify data like a debugger" feature. */
async function setVariable(
    session: vscode.DebugSession,
    variablesReference: number,
    name: string,
    value: string
) {
    try {
        const resp = await session.customRequest('setVariable', {
            variablesReference,
            name,
            value,
        });
        postToWebview({ kind: 'variableSet', ok: true, name, value: resp?.value ?? value });
    } catch (err) {
        postToWebview({
            kind: 'variableSet',
            ok: false,
            name,
            message: String(err instanceof Error ? err.message : err),
        });
    }
}

async function generateTestCmd() {
    if (!lastScenario || !sessionManager.get()?.lastCompletedRunId || lastResults.length === 0) {
        postToWebview({ kind: 'error', message: 'Complete a scenario run before generating a test.' });
        return;
    }
    const run: RecordedRun = { scenario: lastScenario, results: lastResults, mockSet: activeMockSet };
    const { filename, content } = generateTest(run);
    const dir = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot()), '.flow-debugger', 'generated-tests');
    const fileUri = vscode.Uri.joinPath(dir, filename);
    try {
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
        postToWebview({ kind: 'testGenerated', path: fileUri.fsPath });
        const doc = await vscode.workspace.openTextDocument(fileUri);
        void vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    } catch (err) {
        postToWebview({ kind: 'error', message: `Failed to write test: ${String(err)}` });
    }
}

function normalizeBreakpoints(raw: unknown): Breakpoint[] {
    const arr = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object' && Array.isArray((raw as any).breakpoints)
          ? (raw as any).breakpoints
          : [];
    const out: Breakpoint[] = [];
    for (const b of arr) {
        if (!b || typeof b !== 'object') continue;
        const o = b as Record<string, unknown>;
        const file = typeof o.file === 'string' ? o.file : '';
        const line = Number(o.line);
        if (!file || !Number.isInteger(line) || line < 1) continue;
        out.push({
            file,
            line,
            condition: typeof o.condition === 'string' ? o.condition : undefined,
            label: typeof o.label === 'string' ? o.label : undefined,
            enabled: o.enabled === false ? false : true,
        });
    }
    return out;
}

function normalizeScenario(raw: unknown): Scenario {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const calls = Array.isArray(o.calls)
        ? o.calls
              .filter((c) => c && typeof c === 'object')
              .map((c, i) => {
                  const cc = c as Record<string, unknown>;
                  return {
                      id: typeof cc.id === 'string' ? cc.id : `c${i + 1}`,
                      name: typeof cc.name === 'string' ? cc.name : `Call ${i + 1}`,
                      method: (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(cc.method as string)
                          ? cc.method
                          : 'GET') as Scenario['calls'][number]['method'],
                      url: typeof cc.url === 'string' ? cc.url : '',
                      headers:
                          cc.headers && typeof cc.headers === 'object'
                              ? (cc.headers as Record<string, string>)
                              : undefined,
                      body: typeof cc.body === 'string' ? cc.body : undefined,
                      extract:
                          cc.extract && typeof cc.extract === 'object'
                              ? (cc.extract as Record<string, string>)
                              : undefined,
                  };
              })
        : [];
    return {
        id: typeof o.id === 'string' ? o.id : 'agent-scenario',
        name: typeof o.name === 'string' ? o.name : 'Agent scenario',
        dbMode: o.dbMode === 'mocked' ? 'mocked' : 'real',
        mockSetName: typeof o.mockSetName === 'string' ? o.mockSetName : undefined,
        breakpoints: normalizeBreakpoints(o.breakpoints),
        calls,
    };
}

/**
 * Sample the debuggee's memory at the current frame, adapting the probe
 * expression to the debug adapter's language. DAP `evaluate` is generic; only
 * the expression differs per runtime:
 *   - Node   → process.memoryUsage()  { heapUsed, heapTotal, rss, external }
 *   - Python → resource.getrusage() peak RSS (ru_maxrss) as a heap proxy
 * Any other adapter returns undefined (graceful — the UI just hides the readout).
 */
async function sampleMemory(
    session: vscode.DebugSession,
    frameId: number | undefined,
    st: DrivenState | undefined
): Promise<import('./protocol.js').MemorySample | undefined> {
    const type = (session.type || '').toLowerCase();
    // pwa-node, node, node-terminal, chrome, etc. all run JS.
    const isNode = /node|chrome|js|pwa/.test(type);
    const isPython = /python|debugpy/.test(type);
    try {
        if (isNode) {
            const resp = await session.customRequest('evaluate', {
                expression: 'JSON.stringify(process.memoryUsage())',
                frameId,
                context: 'repl',
            });
            let raw: string = resp?.result ?? '';
            raw = raw.replace(/^['"]|['"]$/g, '').replace(/\\"/g, '"');
            const m = JSON.parse(raw) as { heapUsed: number; heapTotal: number; rss: number; external?: number };
            if (typeof m.heapUsed !== 'number') return undefined;
            return finishSample(st, m.heapUsed, m.heapTotal, m.rss, m.external);
        }
        if (isPython) {
            // ru_maxrss is KB on Linux, bytes on macOS; we report it as rss and
            // use current RSS as heapUsed proxy via psutil if present, else rusage.
            const expr =
                "__import__('json').dumps((lambda r=__import__('resource').getrusage(__import__('resource').RUSAGE_SELF): {'rss': r.ru_maxrss * (1 if __import__('sys').platform=='darwin' else 1024)})())";
            const resp = await session.customRequest('evaluate', { expression: expr, frameId, context: 'repl' });
            let raw: string = resp?.result ?? '';
            raw = raw.replace(/^['"]|['"]$/g, '').replace(/\\"/g, '"');
            const m = JSON.parse(raw) as { rss: number };
            if (typeof m.rss !== 'number') return undefined;
            // Python has no cheap heapUsed; use rss for both so the trend still shows.
            return finishSample(st, m.rss, m.rss, m.rss);
        }
        return undefined; // Go/Java/etc.: no cheap in-process probe — hidden gracefully
    } catch {
        return undefined;
    }
}

function finishSample(
    st: DrivenState | undefined,
    heapUsed: number,
    heapTotal: number,
    rss: number,
    external?: number
): import('./protocol.js').MemorySample {
    // easy-start: the baseline is per-session, held on the DrivenState (finding #9).
    const prev = st?.prevHeapUsed;
    const heapDelta = prev === undefined ? 0 : heapUsed - prev;
    if (st) st.prevHeapUsed = heapUsed;
    return { order: 0, heapUsed, heapTotal, rss, external, heapDelta };
}

/** Capture the thrown exception when a stop reason is an exception. */
async function captureException(
    session: vscode.DebugSession,
    threadId: number
): Promise<{ message: string; type?: string } | undefined> {
    try {
        const info = await session.customRequest('exceptionInfo', { threadId });
        return { message: info?.description ?? info?.exceptionId ?? 'Exception', type: info?.exceptionId };
    } catch {
        return undefined;
    }
}

/**
 * Push EVERY breakpoint currently set in the editor to the panel, tagged with
 * who created it. Lets the user see their own hand-set breakpoints in the same
 * list as the ones a scenario/agent applied, instead of only the scenario's.
 */
function publishAllBreakpoints() {
    const root = workspaceRoot();
    const owned = breakpointManager.ownedKeys();
    const entries: Array<{ file: string; line: number; condition?: string; enabled: boolean; source: 'scenario' | 'manual' }> = [];

    for (const bp of vscode.debug.breakpoints) {
        if (!(bp instanceof vscode.SourceBreakpoint)) continue; // skip function/data breakpoints
        const abs = bp.location.uri.fsPath;
        const line = bp.location.range.start.line + 1; // Position is 0-based
        const rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[/\\]/, '') : abs;
        entries.push({
            file: rel,
            line,
            condition: bp.condition,
            enabled: bp.enabled,
            source: owned.has(bpKey(abs, line)) ? 'scenario' : 'manual',
        });
    }
    entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    postToWebview({ kind: 'allBreakpoints', entries });
}

/**
 * Apply boundary mocks to the RUNNING debuggee so `dbMode: 'mocked'` actually
 * intercepts DB/external calls.
 *
 * Mechanism: DAP `evaluate` in the debuggee, monkey-patching the target method
 * on its prototype. This is the only DAP-generic way to stub an arbitrary
 * internal call — DAP has no "force return" and cannot skip a call site.
 *
 * Mock `match` syntax (explicit form REQUIRED for injection):
 *   "<module>#<method>"          e.g. "src/db/OrderRepository#findById"
 *   "<module>#<Class>.<method>"  e.g. "src/db/OrderRepository#OrderRepositoryImpl.findById"
 * A bare substring (legacy "db.query") cannot be resolved to a real symbol
 * and is reported as unsupported rather than silently ignored.
 *
 * Node/CommonJS only: it relies on `require` being in scope in the evaluated
 * frame. Reported per-mock so the caller knows exactly what was stubbed.
 */
async function applyBoundaryMocks(scenario: Scenario): Promise<MockInjectionReport> {
    const session = sessionManager.get()?.session ?? vscode.debug.activeDebugSession;
    const set = activeMockSet;
    const mocks = set?.boundaryMocks ?? [];
    const results: MockInjectionResult[] = [];

    if (!session) {
        return { at: new Date().toISOString(), mockSetName: set?.name, results, note: 'No active debug session — nothing could be injected.' };
    }
    for (const bm of mocks) {
        const m = /^(.+?)#(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)$/.exec(bm.match.trim());
        if (!m) {
            results.push({
                match: bm.match,
                status: 'unsupported',
                message:
                    'Cannot resolve this target. Use "<module>#<method>" or "<module>#<Class>.<method>" ' +
                    '(e.g. "src/db/OrderRepository#findById").',
            });
            continue;
        }
        const [, modulePath, className, method] = m;
        const json = JSON.stringify(bm.returns ?? null);
        // Patch on the prototype (or the module object for a plain function
        // export), keeping the original under __flowOrig_<method> so it can be
        // restored. Always resolve to a Promise: these are async boundaries.
        const expr =
            `(() => { try {` +
            ` const M = require(${JSON.stringify(modulePath)});` +
            ` const C = ${className ? `M[${JSON.stringify(className)}]` : `(M.default || M)`};` +
            ` if (!C) return 'ERR:export not found';` +
            ` const t = C.prototype && typeof C.prototype[${JSON.stringify(method)}] === 'function' ? C.prototype : C;` +
            ` if (typeof t[${JSON.stringify(method)}] !== 'function') return 'ERR:' + ${JSON.stringify(method)} + ' is not a function';` +
            ` if (!t[${JSON.stringify('__flowOrig_' + method)}]) t[${JSON.stringify('__flowOrig_' + method)}] = t[${JSON.stringify(method)}];` +
            ` t[${JSON.stringify(method)}] = function () { return Promise.resolve(${json}); };` +
            ` return 'OK';` +
            ` } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); } })()`;

        try {
            const resp = await session.customRequest('evaluate', { expression: expr, context: 'repl' });
            const raw = String(resp?.result ?? '').replace(/^['"]|['"]$/g, '');
            if (raw === 'OK') {
                results.push({ match: bm.match, status: 'ok', message: `Stubbed ${className ? className + '.' : ''}${method}` });
            } else {
                results.push({ match: bm.match, status: 'failed', message: raw || 'evaluate returned no result' });
            }
        } catch (err) {
            results.push({
                match: bm.match,
                status: 'failed',
                message: `evaluate failed: ${err instanceof Error ? err.message : String(err)}. ` +
                    'Injection needs a Node/CommonJS debuggee where require() is in scope; pause inside the app first.',
            });
        }
    }
    return { at: new Date().toISOString(), mockSetName: set?.name, results };
}

/**
 * Build a test report from the recorded run. Reuses the zero-dep
 * mcp/callmap.mjs (same tree/diagnosis/report logic the MCP server uses) so the
 * panel and an agent produce identical reports.
 */
async function generateReportCmd(format: 'markdown' | 'html') {
    try {
        const root = workspaceRoot();
        const logPath = vscode.Uri.file(`${root}/.flow-debugger/captures/log.ndjson`);
        let raw = '';
        try {
            raw = Buffer.from(await vscode.workspace.fs.readFile(logPath)).toString('utf8');
        } catch {
            postToWebview({ kind: 'error', message: 'No run recorded yet — run a scenario (or hit the endpoint) first.' });
            return;
        }
        const pauses = raw.split('\n').filter(Boolean).map((l) => {
            try {
                const r = JSON.parse(l);
                return { order: r.seq, frame: r.frame, stackDepth: r.stackDepth ?? 1, vars: r.vars ?? [], dbMode: r.dbMode, heapUsed: r.heapUsed, exception: r.exception };
            } catch { return null; }
        }).filter(Boolean);
        if (!pauses.length) {
            postToWebview({ kind: 'error', message: 'No debugger pauses recorded — add breakpoints and run again.' });
            return;
        }
        // Reuse the zero-dep implementation (ESM) from the extension bundle.
        // esmImport keeps a native dynamic import() so the ESM .mjs loads under
        // module:commonjs (a plain import() would be downleveled to require()).
        const mod = await esmImport<{
            buildCallTree: (p: unknown[]) => unknown[];
            inferState: (p: unknown[], r: unknown[]) => { verdict: string; findings: unknown[] };
            buildFlowTrace: (i: unknown) => { id: string; verdict: string };
            reportMarkdown: (t: unknown) => string;
            reportHtml: (t: unknown) => string;
        }>(vscode.Uri.joinPath(extensionUri!, 'mcp', 'callmap.mjs').toString());
        const roots = mod.buildCallTree(pauses as unknown[]);
        const diagnosis = mod.inferState(pauses as unknown[], roots);
        // audit trail, if any
        let audit: unknown;
        try {
            const a = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/.flow-debugger/audit.ndjson`))).toString('utf8');
            audit = a.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { /* none */ }

        const trace = mod.buildFlowTrace({
            pauses, roots, diagnosis,
            scenario: { name: lastScenario?.name ?? 'recorded run', dbMode: sessionManager.get()?.dbMode ?? 'real' },
            mockInjection: mockInjectionReport,
            audit,
        });
        const content = format === 'html' ? mod.reportHtml(trace) : mod.reportMarkdown(trace);

        // Save alongside the traces so it's shareable.
        const dir = vscode.Uri.file(`${root}/.flow-debugger/reports`);
        await vscode.workspace.fs.createDirectory(dir);
        const ext = format === 'html' ? 'html' : 'md';
        const file = vscode.Uri.joinPath(dir, `${trace.id}.${ext}`);
        await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));

        postToWebview({ kind: 'reportReady', format, content, savedTo: file.fsPath, verdict: trace.verdict });
    } catch (err) {
        postToWebview({ kind: 'error', message: `Report generation failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}


// ---- Phase 4: prove-a-change (baseline compare + behavior contracts) ----
// All heavy logic reuses the SAME zero-dep mcp/callmap.mjs the MCP server and
// CLI use, so the panel, an agent, and CI produce identical verdicts.

type ProveModule = {
    buildCallTree: (p: unknown[]) => unknown[];
    inferState: (p: unknown[], r: unknown[]) => { verdict: string; findings: unknown[] };
    buildFlowTrace: (i: unknown) => Record<string, unknown> & { id: string; verdict: string };
    diffTraces: (baseline: unknown, candidate: unknown) => { outcome: string; entries: Array<{ severity: string; title: string; where?: string }> };
    diffMarkdown: (diff: unknown) => string;
    createContract: (trace: unknown, opts?: { scenario?: string }) => unknown;
    verifyContract: (contract: unknown, trace: unknown) => { pass: boolean; violations: Array<{ rule: string; expected: string; actual: string; where?: string }> };
    contractToYaml: (contract: unknown) => string;
    parseContract: (text: string) => unknown;
    explainResult: (result: unknown) => string;
};

async function loadProveModule(): Promise<ProveModule> {
    // esmImport keeps a native dynamic import() so the ESM .mjs loads under
    // module:commonjs (a plain import() would be downleveled to require()).
    return await esmImport<ProveModule>(
        vscode.Uri.joinPath(extensionUri!, 'mcp', 'callmap.mjs').toString()
    );
}

/** Build a FlowTrace from the CURRENT recorded pause log, or undefined if none. */
async function buildCurrentTrace(mod: ProveModule): Promise<(Record<string, unknown> & { id: string; verdict: string }) | undefined> {
    const root = workspaceRoot();
    let raw = '';
    try {
        raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/.flow-debugger/captures/log.ndjson`))).toString('utf8');
    } catch { return undefined; }
    const pauses = raw.split('\n').filter(Boolean).map((l) => {
        try { const r = JSON.parse(l); return { order: r.seq, frame: r.frame, stackDepth: r.stackDepth ?? 1, vars: r.vars ?? [], dbMode: r.dbMode, heapUsed: r.heapUsed, exception: r.exception }; }
        catch { return null; }
    }).filter(Boolean) as unknown[];
    if (!pauses.length) return undefined;
    const roots = mod.buildCallTree(pauses);
    return mod.buildFlowTrace({
        pauses, roots, diagnosis: mod.inferState(pauses, roots),
        scenario: { name: lastScenario?.name ?? 'recorded run', dbMode: sessionManager.get()?.dbMode ?? 'real' },
        mockInjection: mockInjectionReport,
    });
}

function proveDir(...segments: string[]): vscode.Uri {
    return vscode.Uri.file([workspaceRoot(), '.flow-debugger', ...segments].join('/'));
}
const safeName = (name: string) => name.trim().replace(/[^\w.-]/g, '_') || 'baseline';

async function listBaselinesCmd() {
    const read = async (dir: string, suffix: string) => {
        try {
            const entries = await vscode.workspace.fs.readDirectory(proveDir(dir));
            return entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith(suffix)).map(([n]) => n.slice(0, -suffix.length));
        } catch { return []; }
    };
    postToWebview({ kind: 'baselines', names: await read('traces', '.flowtrace.json'), contracts: await read('contracts', '.yaml') });
}

async function saveBaselineCmd(name: string) {
    try {
        const mod = await loadProveModule();
        const trace = await buildCurrentTrace(mod);
        if (!trace) { postToWebview({ kind: 'error', message: 'No run recorded yet — capture a run before saving a baseline.' }); return; }
        const dir = proveDir('traces');
        await vscode.workspace.fs.createDirectory(dir);
        const clean = safeName(name);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${clean}.flowtrace.json`), Buffer.from(JSON.stringify(trace, null, 2), 'utf8'));
        postToWebview({ kind: 'baselineSaved', name: clean });
        await listBaselinesCmd();
    } catch (err) {
        postToWebview({ kind: 'error', message: `Save baseline failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}

async function compareBaselineCmd(name: string) {
    try {
        const mod = await loadProveModule();
        const candidate = await buildCurrentTrace(mod);
        if (!candidate) { postToWebview({ kind: 'error', message: 'No current run to compare — capture a run first.' }); return; }
        let baselineRaw: string;
        try {
            baselineRaw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(proveDir('traces'), `${safeName(name)}.flowtrace.json`))).toString('utf8');
        } catch { postToWebview({ kind: 'error', message: `Baseline "${name}" not found.` }); return; }
        const diff = mod.diffTraces(JSON.parse(baselineRaw), candidate);
        postToWebview({ kind: 'comparisonReady', baseline: name, outcome: diff.outcome, markdown: mod.diffMarkdown(diff), entries: diff.entries ?? [] });
    } catch (err) {
        postToWebview({ kind: 'error', message: `Compare failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}

async function saveContractCmd(name: string) {
    try {
        const mod = await loadProveModule();
        const trace = await buildCurrentTrace(mod);
        if (!trace) { postToWebview({ kind: 'error', message: 'No run recorded yet — capture a run before generating a contract.' }); return; }
        const clean = safeName(name);
        const contract = mod.createContract(trace, { scenario: clean });
        const yaml = mod.contractToYaml(contract);
        const dir = proveDir('contracts');
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${clean}.yaml`), Buffer.from(yaml, 'utf8'));
        postToWebview({ kind: 'contractSaved', name: clean, yaml });
        await listBaselinesCmd();
    } catch (err) {
        postToWebview({ kind: 'error', message: `Save contract failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}

async function verifyContractCmd(name: string) {
    try {
        const mod = await loadProveModule();
        const trace = await buildCurrentTrace(mod);
        if (!trace) { postToWebview({ kind: 'error', message: 'No current run to verify — capture a run first.' }); return; }
        let yaml: string;
        try {
            yaml = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(proveDir('contracts'), `${safeName(name)}.yaml`))).toString('utf8');
        } catch { postToWebview({ kind: 'error', message: `Contract "${name}" not found.` }); return; }
        const result = mod.verifyContract(mod.parseContract(yaml), trace);
        postToWebview({ kind: 'contractVerified', name, pass: result.pass, explanation: mod.explainResult(result), violations: result.violations ?? [] });
    } catch (err) {
        postToWebview({ kind: 'error', message: `Verify contract failed: ${err instanceof Error ? err.message : String(err)}` });
    }
}

/** Open a source file at a line in the editor (Call Map click-to-source). */async function openSource(file: string, line: number) {
    try {
        const root = workspaceRoot();
        let uri: vscode.Uri | undefined;
        if (file.startsWith('/') || /^[A-Za-z]:\\/.test(file)) {
            uri = vscode.Uri.file(file);
        } else if (file.includes('/')) {
            uri = vscode.Uri.file(`${root}/${file}`);
        } else {
            const hits = await vscode.workspace.findFiles(`**/${file}`, '**/node_modules/**', 1);
            uri = hits[0];
        }
        if (!uri) {
            postToWebview({ kind: 'info', message: `Could not locate ${file}` });
            return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(pos, pos),
        });
    } catch (err) {
        postToWebview({ kind: 'info', message: `Open source failed: ${String(err)}` });
    }
}

function mapVariables(raw: any[]): VariableDTO[] {
    const noRedact = process.env.FLOW_NO_REDACT === '1';
    return raw.map((v) => {
        const r = noRedact ? { value: v.value, redacted: false } : redactValue(v.name, String(v.value));
        return {
            name: v.name,
            value: r.value,
            type: v.type,
            // A redacted value must not be expandable (its children could leak it).
            variablesReference: r.redacted ? 0 : (v.variablesReference ?? 0),
            evaluateName: v.evaluateName,
        };
    });
}

function postToWebview(message: ToWebview) {
    panel?.webview.postMessage(message);
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist', 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist', 'assets', 'index.css')
    );
    const nonce = getNonce();
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`,
        `connect-src http: https:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API Flow Test Debugger</title>
    <link rel="stylesheet" type="text/css" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}

export function deactivate() {
    // easy-start: write the terminal "not live" status and stop the heartbeat so
    // the agent never reads a leftover live:true after the extension unloads.
    void sessionManager?.shutdown();
}
