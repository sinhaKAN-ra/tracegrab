import * as vscode from 'vscode';
import type { StackFrameDTO, ScopeDTO, MemorySample } from './protocol.js';

/** A full pause snapshot, written to disk so an out-of-process agent can read it. */
export interface PauseSnapshot {
    seq: number;
    at: string; // ISO timestamp
    reason: string;
    /** Stable capture-run and exact-pause identity (shared with the panel). */
    runId?: string;
    pauseId?: string;
    callId?: string;
    frame: StackFrameDTO | null;
    stack: StackFrameDTO[];
    /**
     * The REAL call-stack frame count at this pause. The `stack` array is
     * capped (levels:20) for the panel, so its length saturates and defeats
     * recursion detection; the caller computes the true depth from DAP
     * `totalFrames` (or a full-stack re-request) and passes it here. When a
     * caller omits it we fall back to `stack.length` to preserve old behavior.
     */
    stackDepth?: number;
    scopes: ScopeDTO[];
    /** true while the debugger is paused here and waiting for a command. */
    waiting: boolean;
    /**
     * Identity of the debug session that produced this pause. A NEW session
     * gets a new id, so an agent can tell a fresh capture from a leftover one
     * instead of re-reading a dead session's last pause as if it were live.
     */
    sessionId?: string;
    /** set once the debug session has ended — this capture is historical. */
    sessionEnded?: boolean;
    dbMode?: 'real' | 'mocked';
    memory?: MemorySample;
    exception?: { message: string; type?: string };
}

/** A command an agent writes to drive the paused session. */
export interface AgentCommand {
    /** monotonic id so we only act on each command once. */
    id: string;
    action:
        | 'continue'
        | 'stepOver'
        | 'stepIn'
        | 'stepOut'
        | 'setVariable'
        | 'pauseInfo'
        /**
         * Autonomy: when enabled, every pause is recorded and then resumed
         * automatically, so an agent gets a COMPLETE trace from one request
         * instead of round-tripping continue/get_pause_state per pause.
         */
        | 'setAutoContinue'
        /** Evaluate an expression in the paused frame — read AND write live state. */
        | 'evaluate'
        /** Launch a debug session by launch.json name, so the agent need not ask for F5. */
        | 'startSession'
        /**
         * easy-start: the ONE-STEP start superset of startSession. configName is
         * OPTIONAL — the extension detects/synthesizes a config, launches it, opens
         * the panel, and binds it as the DRIVEN session, so the agent need not know
         * a launch.json name (design §3.3). startSession is kept as-is.
         */
        | 'startDebugging'
        /**
         * easy-start: switch the DRIVEN session to an existing live session by id
         * (design §2.3/§3.3). The agent reads the id from
         * get_debug_status.otherSessions; this re-binds the bridge + reconciles the
         * capture surface so later continue/step/capture act on the right session.
         */
        | 'useSession'
        /** Stop the active debug session. */
        | 'stopSession'
        /** Restart: stop, then start the same config again. */
        | 'restartSession';
    // setVariable args:
    variablesReference?: number;
    name?: string;
    value?: string;
    // setAutoContinue args:
    enabled?: boolean;
    /** pause before auto-resuming, so slow adapters settle (default 40ms). */
    delayMs?: number;
    // evaluate args:
    expression?: string;
    /** DAP evaluate context: 'repl' (default) | 'watch' | 'hover'. */
    context?: string;
    // startSession / startDebugging args:
    /** Name of a configuration in the target repo's .vscode/launch.json. */
    configName?: string;
    // useSession args:
    /** vscode.DebugSession.id of the live session to switch the driven pointer to. */
    sessionId?: string;
    // A1 propose-then-confirm:
    /** Skip the preview step and mutate immediately (trusted/autonomous flows). */
    confirm?: boolean;
    /** Apply a previously-previewed mutation by its token. */
    confirmToken?: string;
}

/**
 * Bridges the live debug session to an out-of-process agent via files under
 * <workspace>/.flow-debugger/:
 *   captures/latest.json   – the current pause snapshot (agent reads this)
 *   captures/log.ndjson    – append-only history of every pause
 *   agent-command.json     – the agent writes {id, action, …}; we run it once
 *   agent-ack.json         – we write {id, ok, message} after running a command
 *
 * Mirrors the trigger-file pattern already used for scenario.json, so any agent
 * that can read/write files (or the MCP server) can close the debug loop.
 */
export class PauseBridge {
    private seq = 0;
    private lastCommandId: string | undefined;
    private threadId: number | undefined;
    /** Autonomy mode: record each pause then resume it automatically. */
    private autoContinue = false;
    private autoDelayMs = 40;
    /** Identity of the current debug session, so stale captures are detectable. */
    private sessionId: string | undefined;
    /** A1: previewed-but-not-applied mutations, keyed by confirm token. */
    private pending = new Map<string, () => Promise<{ ok: boolean; message?: string; result?: unknown }>>();
    /** Last launch.json config name started via the agent, for restartSession. */
    private lastConfigName: string | undefined;

    /**
     * easy-start: callbacks injected by the extension so the bridge does not
     * duplicate the one-step-start / switch logic. Wired via register() (see the
     * `handlers` arg). When unset, the new actions report they are unavailable
     * rather than throwing.
     */
    private startDebuggingCb: ((configName?: string) => Promise<{ ok: boolean; message?: string; result?: unknown }>) | undefined;
    private useSessionCb: ((sessionId: string) => Promise<{ ok: boolean; message?: string; result?: unknown }>) | undefined;

    /**
     * Called when the DRIVEN session changes (adopt/switch/promotion): adopt the
     * session's immutable id as the single id source (design §4.1), and reset the
     * per-session sequence. The human-readable name is carried separately in
     * session.json; nothing is lost by dropping the old synthetic id.
     */
    newSession(session: vscode.DebugSession) {
        this.sessionId = session.id; // the immutable VS Code session id — the ONE id source
        this.seq = 0;
        return this.sessionId;
    }

    /** Mark the capture as belonging to an ENDED session (historical, not live). */
    async markSessionEnded() {
        try {
            const uri = this.dir('captures', 'latest.json');
            const cur = await readJson(uri);
            if (cur) {
                cur.waiting = false;
                cur.sessionEnded = true;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(cur, null, 2), 'utf8'));
            }
        } catch {
            /* ignore */
        }
        this.sessionId = undefined;
    }

    /**
     * easy-start: write a NEUTRAL latest.json for a session that is now driven but
     * not currently paused (switch / terminate-promotion — design §2.3). Without
     * this, latest.json would still describe the PREVIOUS driven session and
     * get_pause_state would hand the agent a stale frame as if it were live.
     *
     * The object shape is kept in sync with `neutralPause(sessionId)` in
     * mcp/callmap.mjs (which the unit test exercises) — if you change one, change
     * both. Best-effort; same tmp+rename pattern as writePause/markSessionEnded.
     */
    async writeNeutral(sessionId: string) {
        this.sessionId = sessionId;
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            const obj = {
                sessionId,
                waiting: false,
                sessionEnded: false,
                note: 'driven session switched; no pause captured yet',
            };
            await vscode.workspace.fs.writeFile(
                this.dir('captures', 'latest.json'),
                Buffer.from(JSON.stringify(obj, null, 2), 'utf8')
            );
        } catch {
            /* best-effort */
        }
    }

    /**
     * easy-start: re-emit an EXISTING pause snapshot to latest.json for the newly
     * driven session on switch/promotion (design §2.3). Unlike writePause this does
     * NOT append to log.ndjson and does NOT advance the sequence — it only re-points
     * the pause surface's identity at the driven session, so get_pause_state returns
     * B's live pause rather than A's stale one. No new pause is fabricated.
     */
    async reemitLatest(sessionId: string, snap: {
        reason: string; runId?: string; pauseId?: string; callId?: string;
        frame: StackFrameDTO | null; stack: StackFrameDTO[]; scopes: ScopeDTO[];
        dbMode?: 'real' | 'mocked'; exception?: { message: string; type?: string };
    }, threadId?: number) {
        this.sessionId = sessionId;
        this.threadId = threadId;
        const full: PauseSnapshot = {
            ...snap,
            seq: this.seq,
            at: new Date().toISOString(),
            waiting: true,
            sessionId,
            sessionEnded: false,
        };
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            await vscode.workspace.fs.writeFile(
                this.dir('captures', 'latest.json'),
                Buffer.from(JSON.stringify(full, null, 2), 'utf8')
            );
        } catch {
            /* best-effort */
        }
    }

    /** Persist whether dbMode:'mocked' actually intercepted anything. */
    async writeMockInjection(report: unknown) {
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            await vscode.workspace.fs.writeFile(
                this.dir('captures', 'mock-injection.json'),
                Buffer.from(JSON.stringify(report, null, 2), 'utf8')
            );
        } catch {
            /* best-effort */
        }
    }

    /**
     * Append one line to the tamper-evident audit log. EVERY live mutation
     * (setVariable, evaluate-write, mock injection) must call this — it is what
     * turns "an agent can rewrite my running process" into something accountable.
     */
    async audit(entry: {
        actor: 'agent' | 'human';
        action: string;
        target?: string;
        before?: string;
        after?: string;
        ok?: boolean;
        detail?: string;
    }) {
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            const line = Buffer.from(JSON.stringify({
                at: new Date().toISOString(),
                sessionId: this.sessionId,
                ...entry,
            }) + '\n', 'utf8');
            await appendFile(this.dir('audit.ndjson'), line);
        } catch {
            /* best-effort; auditing must never break the debug flow */
        }
    }

    constructor(
        private workspaceRoot: string,
        private getSession: () => vscode.DebugSession | undefined
    ) {}

    private dir(...p: string[]): vscode.Uri {
        return vscode.Uri.file([this.workspaceRoot, '.flow-debugger', ...p].join('/'));
    }

    /** Persist a pause snapshot for the agent to read. Called on each stop. */
    async writePause(snap: Omit<PauseSnapshot, 'seq' | 'at' | 'waiting'>, threadId?: number) {
        this.threadId = threadId;
        this.seq += 1;
        const full: PauseSnapshot = {
            ...snap,
            seq: this.seq,
            at: new Date().toISOString(),
            waiting: true,
            sessionId: this.sessionId,
            sessionEnded: false,
        };
        const bytes = Buffer.from(JSON.stringify(full, null, 2), 'utf8');
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            await vscode.workspace.fs.writeFile(this.dir('captures', 'latest.json'), bytes);
            // Append a full-enough line to the history log so an out-of-process
            // agent (MCP server) can rebuild the Call Map tree from it.
            const topVars = (full.scopes?.[0]?.variables ?? []).map((v) => ({ name: v.name, value: v.value, type: v.type }));
            const line = Buffer.from(JSON.stringify({
                seq: full.seq, at: full.at, reason: full.reason,
                // easy-start: stamp the session id onto EVERY log line so the
                // trace surface is session-attributable — the MCP readLog filters
                // to the driven session by this field (design §2.3 finding #2).
                // Additive: readers that ignore it are unaffected.
                sessionId: this.sessionId,
                runId: full.runId, pauseId: full.pauseId, callId: full.callId,
                frame: full.frame, stackDepth: full.stackDepth ?? full.stack?.length ?? 1,
                vars: topVars, dbMode: full.dbMode,
                heapUsed: full.memory?.heapUsed, exception: full.exception,
            }) + '\n', 'utf8');
            await appendFile(this.dir('captures', 'log.ndjson'), line);
        } catch {
            /* best-effort; the panel still has the state */
        }

        // Autonomy: the pause is now durably recorded, so resume immediately.
        // This lets an agent obtain a COMPLETE trace from a single request.
        if (this.autoContinue) {
            const session = this.getSession();
            if (session) {
                setTimeout(() => {
                    void (async () => {
                        try {
                            await this.markResumed();
                            await session.customRequest('continue', { threadId: threadId ?? this.threadId ?? 0 });
                        } catch {
                            /* session may have ended — nothing to resume */
                        }
                    })();
                }, this.autoDelayMs);
            }
        }
    }

    /** Clear the per-session capture history so each run's Call Map is clean. */
    async resetLog() {
        this.seq = 0;
        try {
            await vscode.workspace.fs.createDirectory(this.dir('captures'));
            await vscode.workspace.fs.writeFile(this.dir('captures', 'log.ndjson'), Buffer.alloc(0));
            await vscode.workspace.fs.writeFile(this.dir('audit.ndjson'), Buffer.alloc(0));
        } catch {
            /* best-effort */
        }
    }

    /** Mark that the session resumed (no longer waiting at a pause). */
    async markResumed() {
        try {
            const uri = this.dir('captures', 'latest.json');
            const cur = await readJson(uri);
            if (cur) {
                cur.waiting = false;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(cur, null, 2), 'utf8'));
            }
        } catch {
            /* ignore */
        }
    }

    /**
     * easy-start: wire the one-step-start / switch callbacks so the bridge's new
     * `startDebugging`/`useSession` actions delegate to the extension's detection
     * and switch logic instead of duplicating it. Call this once from activate().
     */
    setHandlers(handlers: {
        startDebugging: (configName?: string) => Promise<{ ok: boolean; message?: string; result?: unknown }>;
        useSession: (sessionId: string) => Promise<{ ok: boolean; message?: string; result?: unknown }>;
    }) {
        this.startDebuggingCb = handlers.startDebugging;
        this.useSessionCb = handlers.useSession;
    }

    /** Register the agent-command watcher. Returns the disposable watcher. */
    register(context: vscode.ExtensionContext, onCommandResult: (msg: string) => void) {
        const pattern = new vscode.RelativePattern(this.workspaceRoot, '.flow-debugger/agent-command.json');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const run = async (uri: vscode.Uri) => {
            const cmd = (await readJson(uri)) as AgentCommand | undefined;
            if (!cmd || !cmd.id || cmd.id === this.lastCommandId) return; // dedupe
            this.lastCommandId = cmd.id;
            const result = await this.execute(cmd);
            await vscode.workspace.fs.writeFile(
                this.dir('agent-ack.json'),
                Buffer.from(JSON.stringify({ id: cmd.id, ...result }, null, 2), 'utf8')
            );
            onCommandResult(`agent command ${cmd.action}: ${result.ok ? 'ok' : result.message}`);
        };
        watcher.onDidCreate(run);
        watcher.onDidChange(run);
        context.subscriptions.push(watcher);
        return watcher;
    }

    private async execute(cmd: AgentCommand): Promise<{ ok: boolean; message?: string; result?: unknown }> {
        // startSession is the ONE action that runs with no session — it creates one.
        if (cmd.action === 'startSession') {
            const name = cmd.configName;
            if (!name) return { ok: false, message: 'startSession needs configName (a name from .vscode/launch.json)' };
            if (this.getSession()) {
                return { ok: false, message: `a debug session is already active (${this.getSession()?.name}); stop it first` };
            }
            try {
                const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === this.workspaceRoot)
                    ?? vscode.workspace.workspaceFolders?.[0];
                const started = await vscode.debug.startDebugging(folder, name);
                if (started) this.lastConfigName = name;
                return started
                    ? { ok: true, message: `started debug configuration "${name}"` }
                    : { ok: false, message: `VS Code refused to start "${name}" — check the name exists in .vscode/launch.json` };
            } catch (err) {
                return { ok: false, message: `startDebugging failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        if (cmd.action === 'stopSession') {
            const s = this.getSession();
            if (!s) return { ok: false, message: 'no active debug session to stop' };
            try {
                await vscode.debug.stopDebugging(s);
                return { ok: true, message: `stopped "${s.name}"` };
            } catch (err) {
                return { ok: false, message: `stopDebugging failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        if (cmd.action === 'restartSession') {
            const name = cmd.configName || this.lastConfigName;
            if (!name) return { ok: false, message: 'restartSession needs configName (none remembered from a prior start)' };
            try {
                const cur = this.getSession();
                if (cur) { await vscode.debug.stopDebugging(cur); await new Promise((r) => setTimeout(r, 400)); }
                const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === this.workspaceRoot)
                    ?? vscode.workspace.workspaceFolders?.[0];
                const started = await vscode.debug.startDebugging(folder, name);
                if (started) this.lastConfigName = name;
                return started ? { ok: true, message: `restarted "${name}"` } : { ok: false, message: `failed to restart "${name}"` };
            } catch (err) {
                return { ok: false, message: `restart failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // easy-start: one-step start — detect/synthesize a config, launch it, open
        // the panel, bind it as driven. Delegates to the extension (design §3.3).
        if (cmd.action === 'startDebugging') {
            if (!this.startDebuggingCb) {
                return { ok: false, message: 'startDebugging is not available (extension not fully initialized)' };
            }
            try {
                return await this.startDebuggingCb(cmd.configName);
            } catch (err) {
                return { ok: false, message: `startDebugging failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // easy-start: switch the DRIVEN session to an existing live one (design §2.3).
        if (cmd.action === 'useSession') {
            if (!cmd.sessionId) return { ok: false, message: 'useSession needs a sessionId (read it from get_debug_status.otherSessions)' };
            if (!this.useSessionCb) {
                return { ok: false, message: 'useSession is not available (extension not fully initialized)' };
            }
            try {
                return await this.useSessionCb(cmd.sessionId);
            } catch (err) {
                return { ok: false, message: `useSession failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }

        const session = this.getSession();
        if (!session) return { ok: false, message: 'no active debug session' };
        const threadId = this.threadId ?? 0;
        // A1: applying a previously-previewed mutation.
        if (cmd.confirmToken) {
            const apply = this.pending.get(cmd.confirmToken);
            if (!apply) return { ok: false, message: 'unknown or expired confirmToken — re-preview the mutation' };
            this.pending.delete(cmd.confirmToken);
            return apply();
        }
        try {
            switch (cmd.action) {
                case 'continue':
                    await this.markResumed();
                    await session.customRequest('continue', { threadId });
                    return { ok: true };
                case 'stepOver':
                    await this.markResumed();
                    await session.customRequest('next', { threadId });
                    return { ok: true };
                case 'stepIn':
                    await this.markResumed();
                    await session.customRequest('stepIn', { threadId });
                    return { ok: true };
                case 'stepOut':
                    await this.markResumed();
                    await session.customRequest('stepOut', { threadId });
                    return { ok: true };
                case 'setVariable': {
                    if (cmd.variablesReference == null || !cmd.name) {
                        return { ok: false, message: 'setVariable needs variablesReference + name' };
                    }
                    const vref = cmd.variablesReference, vname = cmd.name, vval = cmd.value ?? '';
                    // capture the current value for the preview / audit before-state
                    let before: string | undefined;
                    try {
                        const cur = await session.customRequest('variables', { variablesReference: vref });
                        before = cur?.variables?.find((v: { name: string; value: string }) => v.name === vname)?.value;
                    } catch { /* best-effort */ }
                    const doApply = async () => {
                        await session.customRequest('setVariable', { variablesReference: vref, name: vname, value: vval });
                        void this.audit({ actor: 'agent', action: 'setVariable', target: vname, before, after: vval, ok: true });
                        return { ok: true, result: { applied: true, name: vname, before, after: vval } };
                    };
                    if (cmd.confirm) return doApply();
                    // A1 preview: hold the mutation, return a token to confirm.
                    const token = `mut_${Math.random().toString(36).slice(2, 9)}`;
                    this.pending.set(token, doApply);
                    return { ok: true, result: {
                        willMutate: true, target: vname, currentValue: before, proposedValue: vval,
                        confirmToken: token,
                        note: 'Preview only — nothing changed. Call again with this confirmToken to apply, or pass confirm:true to skip the preview.',
                    } };
                }
                case 'pauseInfo':
                    return { ok: true }; // agent should read captures/latest.json
                case 'evaluate': {
                    if (!cmd.expression) return { ok: false, message: 'evaluate needs an expression' };
                    const expr = cmd.expression;
                    let frameId: number | undefined;
                    try {
                        const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
                        frameId = st?.stackFrames?.[0]?.id;
                    } catch { /* fall back to global evaluate */ }
                    const ctx = cmd.context || 'repl';
                    // An assignment MUTATES the process. Heuristic: a single `=` that
                    // isn't ==, ===, <=, >=, !=.
                    const isWrite = /[^=!<>]=[^=]/.test(expr);
                    const runEval = async () => {
                        const resp = await session.customRequest('evaluate', { expression: expr, frameId, context: ctx });
                        return { value: resp?.result, type: resp?.type, variablesReference: resp?.variablesReference ?? 0 };
                    };
                    if (!isWrite) {
                        // pure read — no confirmation, no audit
                        const r = await runEval();
                        return { ok: true, result: { expression: expr, ...r } };
                    }
                    // write path
                    const doApply = async () => {
                        const r = await runEval();
                        void this.audit({ actor: 'agent', action: 'evaluate:write', target: expr, after: String(r.value), ok: true });
                        return { ok: true, result: { applied: true, expression: expr, ...r } };
                    };
                    if (cmd.confirm) return doApply();
                    // preview the write: read the current LHS value if we can derive it.
                    let currentValue: string | undefined;
                    const lhs = expr.split('=')[0]?.trim();
                    if (lhs) {
                        try {
                            const cur = await session.customRequest('evaluate', { expression: lhs, frameId, context: ctx });
                            currentValue = cur?.result;
                        } catch { /* best-effort */ }
                    }
                    const token = `mut_${Math.random().toString(36).slice(2, 9)}`;
                    this.pending.set(token, doApply);
                    return { ok: true, result: {
                        willMutate: true, target: lhs, currentValue, proposedExpression: expr,
                        confirmToken: token,
                        note: 'Preview only — this assignment was NOT run. Call again with this confirmToken to apply, or pass confirm:true.',
                    } };
                }
                case 'setAutoContinue': {
                    this.autoContinue = cmd.enabled !== false;
                    if (typeof cmd.delayMs === 'number' && cmd.delayMs >= 0) this.autoDelayMs = cmd.delayMs;
                    // If we turn autonomy ON while already paused, get moving.
                    if (this.autoContinue) {
                        try {
                            await this.markResumed();
                            await session.customRequest('continue', { threadId });
                        } catch {
                            /* not paused right now — fine */
                        }
                    }
                    return { ok: true, message: `autoContinue=${this.autoContinue} delay=${this.autoDelayMs}ms` };
                }
                default:
                    return { ok: false, message: `unknown action ${cmd.action}` };
            }
        } catch (err) {
            return { ok: false, message: String(err instanceof Error ? err.message : err) };
        }
    }
}

async function readJson(uri: vscode.Uri): Promise<any | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
        return undefined;
    }
}

async function appendFile(uri: vscode.Uri, data: Buffer): Promise<void> {
    let existing = Buffer.alloc(0);
    try {
        existing = Buffer.from(await vscode.workspace.fs.readFile(uri));
    } catch {
        /* new file */
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.concat([existing, data]));
}
