import * as vscode from 'vscode';
import type { ToWebview } from './protocol.js';

/**
 * easy-start: the SessionManager owns the one FIRST-CLASS notion the extension
 * previously lacked — "the debug session this tool is DRIVING" — and the durable
 * status surface the agent reads (design §2, §4).
 *
 * Before this, session/pause state lived in ~12 module globals in
 * src/extension.ts and the bridge drove whatever `vscode.debug.activeDebugSession`
 * happened to be (focus-following). With two sessions that silently stole the
 * driver, and the agent had no way to tell what was live. The manager fixes all
 * three by:
 *   - binding to EXACTLY ONE driven session at a time, keyed by the immutable
 *     `vscode.DebugSession.id` (the single id source — design §4.1);
 *   - holding per-session state in a Map so a second session cannot wipe the
 *     first's recorded trace;
 *   - projecting the driven state to `.flow-debugger/captures/session.json`
 *     continuously (on start/pause/resume/switch/terminate + a 5s heartbeat) via
 *     the pure `projectSessionStatus` helper mirrored in `mcp/callmap.mjs`, so the
 *     serialization shape is single-sourced and unit-testable.
 *
 * Every disk write is best-effort (wrapped in try/catch): status projection must
 * NEVER break the debug flow.
 */

/** The pause-history message shape the panel replays (mirrors extension.ts). */
type StoppedMessage = Extract<ToWebview, { kind: 'stopped' }>;

/**
 * All state for ONE tracked debug session. This absorbs the former module
 * globals (pausedThreadId/pausedSession, currentRunId, externalRunId,
 * lastCompletedRunId, currentCallId, pauseHistory, pauseCounts, currentDbMode,
 * stepCounter, prevHeapUsed, runAbortController) so a second session cannot
 * clobber the driven session's trace (design §2.2).
 */
export interface DrivenState {
    /** The live session object. `session.id` is the ONE id used everywhere. */
    readonly session: vscode.DebugSession;
    name: string;
    /** launch.json config name, when WE launched it (else undefined). */
    configName?: string;
    /** session.type: 'pwa-node' | 'node' | 'python' | 'debugpy' | … */
    type: string;
    startedBy: 'agent' | 'human';
    startedAt: string; // ISO

    // Pause state (replaces the single pausedThreadId/pausedSession pair).
    pausedThreadId?: number;
    lastPauseAt?: string;

    // Trace/run state (per session, so a second session cannot wipe the first's).
    currentRunId?: string;
    externalRunId?: string;
    lastCompletedRunId?: string;
    currentCallId?: string;
    pauseHistory: StoppedMessage[];
    pauseCounts: Map<string, number>;
    dbMode: 'real' | 'mocked';
    stepCounter: number;
    prevHeapUsed?: number;
    runAbortController?: AbortController;

    // Best-effort connection details, cached once per session (design §4.3).
    pid?: number;
    port?: number;
    portSource?: 'config' | 'debugPort(approx)';
    /** Guard: the port/pid evaluate is attempted at most once per session. */
    connectionProbed?: boolean;
}

/** A compact view of a non-driven live session for session.json.otherSessions. */
export interface OtherSessionInfo {
    sessionId: string;
    name: string;
    type: string;
    paused: boolean;
}

/** The projection function, imported lazily from the zero-dep mcp/callmap.mjs. */
type ProjectFn = (
    driven: unknown,
    otherSessions: OtherSessionInfo[],
    nowIso: string
) => Record<string, unknown>;

export class SessionManager {
    /** All tracked sessions (driven + non-driven), keyed by session.id. */
    private sessions = new Map<string, DrivenState>();
    /** The id of the single driven session, or undefined when none is driven. */
    private drivenId: string | undefined;
    private heartbeat: NodeJS.Timeout | undefined;
    /** Cached pure projection helper from mcp/callmap.mjs (loaded once). */
    private projectFn: ProjectFn | undefined;

    constructor(
        private workspaceRoot: string,
        /** Resolves the extension's own mcp/callmap.mjs URI for the lazy import. */
        private callmapUri: () => vscode.Uri
    ) {}

    // ---- membership / driven pointer ----

    /**
     * Register a session and MAKE IT DRIVEN. Returns the fresh DrivenState with
     * reset per-session trace fields. Callers (the adopt→driven path) perform the
     * capture-surface side-effects (newSession/resetLog/touch/posts) themselves.
     */
    adopt(session: vscode.DebugSession, opts: { startedBy: 'agent' | 'human'; configName?: string }): DrivenState {
        const st = this.track(session, opts);
        this.drivenId = session.id;
        return st;
    }

    /**
     * Register a session WITHOUT making it driven (a second, unrelated session).
     * No capture file is touched by this (design §2.3). Returns the state.
     */
    track(session: vscode.DebugSession, opts: { startedBy: 'agent' | 'human'; configName?: string }): DrivenState {
        const existing = this.sessions.get(session.id);
        if (existing) return existing;
        const st: DrivenState = {
            session,
            name: session.name,
            configName: opts.configName,
            type: session.type,
            startedBy: opts.startedBy,
            startedAt: new Date().toISOString(),
            pauseHistory: [],
            pauseCounts: new Map(),
            dbMode: 'real',
            stepCounter: 0,
        };
        this.sessions.set(session.id, st);
        return st;
    }

    /** The driven state, or undefined when nothing is driven. */
    get(): DrivenState | undefined {
        return this.drivenId ? this.sessions.get(this.drivenId) : undefined;
    }

    /** State for a specific session id (the DAP tracker uses this). */
    getById(id: string): DrivenState | undefined {
        return this.sessions.get(id);
    }

    /** Is this session the one we are driving? */
    isDriven(session: vscode.DebugSession | undefined): boolean {
        return !!session && session.id === this.drivenId;
    }

    /** The driven session's id (for callers that need to compare). */
    drivenSessionId(): string | undefined {
        return this.drivenId;
    }

    /**
     * Switch the driven pointer to an existing live session. Returns false if the
     * id is not a tracked live session (so the caller acks "no longer live").
     * Does NOT reset any trace — each session keeps its own DrivenState. The
     * caller runs the capture-surface reconciliation (newSession + re-emit/neutral
     * latest.json + touch) so identity stays consistent (design §2.3).
     */
    drive(id: string): boolean {
        if (!this.sessions.has(id)) return false;
        this.drivenId = id;
        return true;
    }

    /**
     * Remove a terminated session. If it was the driven one, promote the
     * most-recently-started remaining session (or clear the pointer). Returns the
     * promoted DrivenState (so the caller reconciles its capture surface), or
     * undefined if nothing remains to drive.
     */
    remove(id: string): DrivenState | undefined {
        const wasDriven = this.drivenId === id;
        this.sessions.delete(id);
        if (!wasDriven) return undefined;
        this.drivenId = undefined;
        if (this.sessions.size === 0) return undefined;
        // Promote the most-recently-started remaining session.
        let promoted: DrivenState | undefined;
        for (const st of this.sessions.values()) {
            if (!promoted || st.startedAt > promoted.startedAt) promoted = st;
        }
        if (promoted) this.drivenId = promoted.session.id;
        return promoted;
    }

    /** Live-but-not-driven sessions, as compact info for session.json (capped by projector). */
    others(): OtherSessionInfo[] {
        const out: OtherSessionInfo[] = [];
        for (const [id, st] of this.sessions) {
            if (id === this.drivenId) continue;
            out.push({
                sessionId: id,
                name: st.name,
                type: st.type,
                paused: st.pausedThreadId !== undefined,
            });
        }
        return out;
    }

    /** Full list including the driven flag (for the useSession QuickPick). */
    list(): Array<{ id: string; name: string; type: string; driven: boolean; paused: boolean }> {
        const out: Array<{ id: string; name: string; type: string; driven: boolean; paused: boolean }> = [];
        for (const [id, st] of this.sessions) {
            out.push({ id, name: st.name, type: st.type, driven: id === this.drivenId, paused: st.pausedThreadId !== undefined });
        }
        return out;
    }

    // ---- per-session mutators used by the DAP tracker ----

    /** Record that a specific session paused on a thread. */
    recordStopped(id: string, threadId: number | undefined, at: string): void {
        const st = this.sessions.get(id);
        if (!st) return;
        st.pausedThreadId = threadId;
        st.lastPauseAt = at;
    }

    /** Record that a specific session resumed (no longer paused). */
    recordResumed(id: string): void {
        const st = this.sessions.get(id);
        if (!st) return;
        st.pausedThreadId = undefined;
    }

    // ---- status-file projection ----

    /** The directory/file uri for a path under .flow-debugger/. */
    private dir(...p: string[]): vscode.Uri {
        return vscode.Uri.file([this.workspaceRoot, '.flow-debugger', ...p].join('/'));
    }

    /** Lazily load the pure projectSessionStatus helper from mcp/callmap.mjs. */
    private async project(): Promise<ProjectFn> {
        if (this.projectFn) return this.projectFn;
        const mod = (await import(/* webpackIgnore: true */ this.callmapUri().toString())) as {
            projectSessionStatus: ProjectFn;
        };
        this.projectFn = mod.projectSessionStatus;
        return this.projectFn;
    }

    /**
     * The SOLE writer of session.json (design §2.3 finding #5). Serializes the
     * current driven state (+ otherSessions + a fresh heartbeat) via the pure
     * projector and writes it atomically (tmp + rename). Best-effort.
     */
    async touch(): Promise<void> {
        try {
            const projectSessionStatus = await this.project();
            const driven = this.drivenProjection();
            const obj = projectSessionStatus(driven, this.others(), new Date().toISOString());
            await this.writeAtomic(this.dir('captures', 'session.json'), JSON.stringify(obj, null, 2));
        } catch {
            /* best-effort; status projection must never break the debug flow */
        }
    }

    /** Write session.json live:false explicitly (deactivate / host-reload stamp). */
    async writeNotLive(note?: string): Promise<void> {
        try {
            const projectSessionStatus = await this.project();
            const obj = projectSessionStatus(null, this.others(), new Date().toISOString());
            if (note) (obj as Record<string, unknown>).note = note;
            await this.writeAtomic(this.dir('captures', 'session.json'), JSON.stringify(obj, null, 2));
        } catch {
            /* best-effort */
        }
    }

    /** A plain projection of the driven DrivenState for the pure projector. */
    private drivenProjection(): Record<string, unknown> | null {
        const st = this.get();
        if (!st) return null;
        return {
            sessionId: st.session.id,
            name: st.name,
            configName: st.configName ?? null,
            type: st.type,
            port: st.port ?? null,
            portSource: st.portSource ?? null,
            pid: st.pid ?? null,
            pausedThreadId: st.pausedThreadId ?? null,
            startedBy: st.startedBy,
            startedAt: st.startedAt,
            lastPauseAt: st.lastPauseAt ?? null,
        };
    }

    private async writeAtomic(uri: vscode.Uri, content: string): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.dir('captures'));
        const tmp = uri.with({ path: uri.path + '.tmp' });
        await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
        await vscode.workspace.fs.rename(tmp, uri, { overwrite: true });
    }

    // ---- lifecycle ----

    /** Start the periodic heartbeat so staleness is detectable after a crash. */
    startHeartbeat(intervalMs: number): void {
        this.stopHeartbeat();
        this.heartbeat = setInterval(() => {
            // Only heartbeat while a session is live, to avoid rewriting a
            // live:false file forever.
            if (this.drivenId) void this.touch();
        }, intervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    }

    /** deactivate(): write the terminal "not live" state and stop the heartbeat. */
    async shutdown(): Promise<void> {
        this.stopHeartbeat();
        this.drivenId = undefined;
        this.sessions.clear();
        await this.writeNotLive('extension deactivated');
    }
}
