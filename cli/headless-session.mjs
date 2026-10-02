#!/usr/bin/env node
/**
 * Long-lived HEADLESS interactive debug session runner (interactive headless
 * debugging, FEAT-002) — the headless analog of src/sessionManager.ts +
 * src/pauseBridge.ts.
 *
 * It is a detached process that owns the live debug adapter (via
 * collectInteractive from cli/collector.mjs, FEAT-001) and plays the role the
 * VS Code extension plays for IDE sessions, so the EXISTING MCP tools
 * (get_pause_state, debug_*, evaluate_expression, get_debug_status,
 * get_capabilities, the call-map tools) drive it with NO change:
 *
 *   - mints a synthetic driven id `headless:<pid>:<startTs>`;
 *   - writes + heartbeats `.flow-debugger/captures/session.json` ONLY via the
 *     zero-dep `projectSessionStatus` / `HEARTBEAT_MS` from mcp/callmap.mjs
 *     (single-sourced with the extension — never re-implemented here);
 *   - on each pause writes `.flow-debugger/captures/latest.json` in the same
 *     PauseSnapshot shape the extension writes (so get_pause_state works
 *     verbatim) and sets session.json's pausedThreadId;
 *   - services the SAME `.flow-debugger/agent-command.json` /
 *     `agent-ack.json` channel the extension services (deduped by id);
 *   - stamps every `log.ndjson` line with the synthetic sessionId so the
 *     existing filterLogBySession keeps the call-map tools on this trace;
 *   - on terminate / SIGTERM writes session.json live:false and latest.json
 *     sessionEnded:true, exactly as the extension's shutdown / markSessionEnded.
 *
 * All disk writes are atomic (tmp + rename). Zero new runtime deps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInteractive } from './collector.mjs';
import { projectSessionStatus, HEARTBEAT_MS } from '../mcp/callmap.mjs';

/** Atomic write (tmp + rename), mirroring writeScenario / SessionManager.writeAtomic. */
function writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
}

function capturePaths(workspace) {
    const dir = path.join(workspace, '.flow-debugger');
    const captures = path.join(dir, 'captures');
    return {
        dir,
        captures,
        sessionJson: path.join(captures, 'session.json'),
        latestJson: path.join(captures, 'latest.json'),
        logNdjson: path.join(captures, 'log.ndjson'),
        startJson: path.join(captures, 'headless-start.json'),
        command: path.join(dir, 'agent-command.json'),
        ack: path.join(dir, 'agent-ack.json'),
    };
}

/**
 * Run a headless interactive session. Resolves when the debuggee terminates,
 * maxPauses is hit, totalMs elapses, or SIGTERM/stop flips the terminate flag.
 *
 * @param {object} opts
 * @param {'node'|'python'} opts.language
 * @param {string} opts.program            entry file, relative to workspace/cwd
 * @param {string[]} [opts.args]
 * @param {Array<{file:string,line:number,condition?:string}>} opts.breakpoints
 * @param {string} [opts.pythonPath]
 * @param {string} opts.workspace          where the capture surface is written
 * @param {string} [opts.cwd]              defaults to workspace
 * @param {number} [opts.totalMs]          max session window (default 3600000)
 */
export async function runHeadlessSession(opts) {
    const {
        language = 'node',
        program,
        args = [],
        breakpoints = [],
        pythonPath,
        workspace = process.cwd(),
        cwd = workspace,
        totalMs = 3600000,
    } = opts;

    if (!program) throw new Error('program is required');

    const startTs = Date.now();
    const drivenId = `headless:${process.pid}:${startTs}`;
    const type = language === 'python' ? 'python' : 'node';
    const P = capturePaths(workspace);
    fs.mkdirSync(P.captures, { recursive: true });

    // The driven projection the runner mirrors from SessionManager.drivenProjection():
    // only pausedThreadId changes between pause and resume; everything else is fixed
    // for the life of the session.
    let pausedThreadId = null;
    const nowIso = () => new Date().toISOString();
    const drivenProjection = () => ({
        sessionId: drivenId,
        name: `headless ${type}`,
        configName: null,
        type,
        port: null,
        portSource: null,
        pid: process.pid,
        pausedThreadId, // null => paused:false in projectSessionStatus
        startedBy: 'agent',
        startedAt: new Date(startTs).toISOString(),
        lastPauseAt: pausedThreadId !== null ? nowIso() : null,
    });

    // session.json is produced ONLY via projectSessionStatus (never re-implemented).
    const writeSession = (live) => {
        const obj = live
            ? projectSessionStatus(drivenProjection(), [], nowIso())
            : projectSessionStatus(null, [], nowIso());
        writeAtomic(P.sessionJson, JSON.stringify(obj, null, 2));
    };

    // ---- lifecycle flags shared with the command channel + teardown ----
    let terminated = false;
    const flagTerminate = () => { terminated = true; };
    process.on('SIGTERM', flagTerminate);
    process.on('SIGINT', flagTerminate);

    // ---- start: write a live session.json + begin heartbeating ----
    writeSession(true);
    const heartbeat = setInterval(() => {
        if (terminated) return;
        try { writeSession(true); } catch { /* best-effort */ }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    // ---- command channel over the SAME files the extension services ----
    // read(): return the latest command object or null; collectInteractive
    // dedupes by id. ack(obj): write agent-ack.json atomically.
    const command = {
        read() {
            try {
                const raw = fs.readFileSync(P.command, 'utf8');
                const cmd = JSON.parse(raw);
                return cmd && typeof cmd === 'object' && cmd.id ? cmd : null;
            } catch {
                return null; // not written yet / mid-write
            }
        },
        ack(obj) {
            try { writeAtomic(P.ack, JSON.stringify(obj, null, 2)); } catch { /* best-effort */ }
        },
    };

    // ---- onPaused: write latest.json + mark session.json paused ----
    // Built lazily from the live driver so get_pause_state sees a full snapshot.
    const onPaused = async (record, driver) => {
        pausedThreadId = record.seq || 1; // headless has no real thread id; a stable non-null marker
        let scopes = [];
        let frameId;
        try {
            const frames = await driver.stackTrace();
            frameId = frames?.[0]?.id;
            if (frameId !== undefined) {
                const { scopes: scopeList = [] } = await driver.scopes({ frameId });
                for (const sc of scopeList) {
                    let variables = [];
                    try {
                        variables = (await driver.variables({ variablesReference: sc.variablesReference }))
                            .map((v) => ({
                                name: v.name,
                                value: v.value,
                                type: v.type,
                                variablesReference: v.variablesReference ?? 0,
                                evaluateName: v.evaluateName ?? v.name,
                            }));
                    } catch { /* scope not expandable */ }
                    scopes.push({ name: sc.name, variablesReference: sc.variablesReference, variables });
                }
            }
        } catch { /* driver may not expose read passthroughs for this pause */ }

        const snap = {
            seq: record.seq,
            at: record.at,
            reason: record.reason,
            frame: record.frame,
            stack: record.frame ? [record.frame] : [],
            scopes,
            waiting: true,
            sessionId: drivenId,
            sessionEnded: false,
            ...(typeof record.heapUsed === 'number' ? { memory: { order: record.seq, heapUsed: record.heapUsed } } : {}),
            ...(record.exception ? { exception: record.exception } : {}),
        };
        writeAtomic(P.latestJson, JSON.stringify(snap, null, 2));
        writeSession(true); // pausedThreadId now set
    };

    // Wrap the command channel so that when an ADVANCING command (continue/step)
    // is acked, we clear pausedThreadId in session.json and flip latest.json to
    // waiting:false — the headless analog of PauseBridge.markResumed().
    const ADVANCING = new Set(['continue', 'stepOver', 'stepIn', 'stepOut']);
    const seenActions = new Map(); // commandId -> action, remembered at read()
    const wrappedCommand = {
        read: () => {
            if (terminated) return null;
            const cmd = command.read();
            if (cmd && cmd.id) seenActions.set(cmd.id, cmd.action ?? cmd.type);
            return cmd;
        },
        ack: (obj) => {
            command.ack(obj);
            const action = seenActions.get(obj.id);
            seenActions.delete(obj.id);
            if (obj.ok && ADVANCING.has(action)) {
                // Resume: clear pausedThreadId and flip latest.json to not-waiting,
                // the headless analog of PauseBridge.markResumed(). onPaused re-sets
                // these when the next pause lands.
                pausedThreadId = null;
                try { writeSession(true); } catch { /* best-effort */ }
                try {
                    const cur = JSON.parse(fs.readFileSync(P.latestJson, 'utf8'));
                    cur.waiting = false;
                    writeAtomic(P.latestJson, JSON.stringify(cur, null, 2));
                } catch { /* best-effort */ }
            }
        },
    };

    // ---- record a bound-breakpoint start artifact so the MCP tool can confirm
    //      'first breakpoint bound' vs surface an actionable error ----
    const writeStartArtifact = (payload) => {
        try { writeAtomic(P.startJson, JSON.stringify({ sessionId: drivenId, pid: process.pid, ...payload }, null, 2)); }
        catch { /* best-effort */ }
    };

    let result;
    let runError;
    // Observe the first bound breakpoint as soon as collectInteractive reports it.
    // collectInteractive resolves its boundBreakpoints at teardown, but it also
    // parks at the first pause — so we treat the first onPaused as proof the
    // adapter attached and at least one breakpoint can be hit. The MCP tool polls
    // headless-start.json AND session.json live:true, so write a progressive
    // artifact: 'launching' now, then update to 'bound' on the first pause.
    writeStartArtifact({ status: 'launching', breakpoints });
    let firstPauseSeen = false;
    const onPausedTracked = async (record, driver) => {
        if (!firstPauseSeen) {
            firstPauseSeen = true;
            writeStartArtifact({ status: 'bound', bound: true, firstPause: { reason: record.reason, frame: record.frame } });
        }
        await onPaused(record, driver);
    };

    try {
        result = await collectInteractive({
            language,
            program,
            args,
            cwd,
            workspace,
            breakpoints,
            pythonPath,
            totalMs,
            onPaused: onPausedTracked,
            command: wrappedCommand,
            shouldStop: () => terminated,
        });
        // If we never paused, still record the bound-breakpoint verdict so the MCP
        // tool can distinguish 'bound but not hit' from a launch failure.
        if (!firstPauseSeen) {
            const bound = (result.boundBreakpoints ?? []).filter((b) => b.verified);
            writeStartArtifact({
                status: bound.length ? 'bound' : 'no-breakpoint-bound',
                bound: bound.length > 0,
                boundBreakpoints: result.boundBreakpoints ?? [],
                adapterErrors: result.adapterErrors ?? [],
            });
        }
    } catch (e) {
        runError = e;
        writeStartArtifact({ status: 'error', error: e.message });
    } finally {
        clearInterval(heartbeat);
        // ---- teardown: honest NOT-RUNNING + historical latest.json ----
        try { writeSession(false); } catch { /* best-effort */ }
        try {
            let cur = {};
            try { cur = JSON.parse(fs.readFileSync(P.latestJson, 'utf8')); } catch { /* none */ }
            cur.sessionId = cur.sessionId ?? drivenId;
            cur.waiting = false;
            cur.sessionEnded = true;
            writeAtomic(P.latestJson, JSON.stringify(cur, null, 2));
        } catch { /* best-effort */ }
        // Stamp every log.ndjson line with the synthetic sessionId so
        // filterLogBySession keeps the call-map tools on this trace. collect-
        // Interactive owns the log file (truncates + appends unstamped records);
        // we rewrite it in place, adding sessionId, atomically.
        stampLog(P.logNdjson, drivenId);
    }

    if (runError) throw runError;
    return { sessionId: drivenId, ...result };
}

/** Rewrite log.ndjson adding sessionId to every line (atomic). Idempotent. */
function stampLog(logPath, sessionId) {
    let raw;
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return; }
    const lines = raw.split('\n').filter(Boolean);
    if (!lines.length) return;
    const stamped = lines.map((l) => {
        try {
            const obj = JSON.parse(l);
            if (obj && typeof obj === 'object' && obj.sessionId === undefined) obj.sessionId = sessionId;
            return JSON.stringify(obj);
        } catch {
            return l; // leave an unparsable line untouched
        }
    });
    try { writeAtomic(logPath, stamped.join('\n') + '\n'); } catch { /* best-effort */ }
}

/** Read the runner config from argv: `--config <path-to-json | inline-json>`. */
function readConfigFromArgv(argv) {
    const i = argv.indexOf('--config');
    if (i === -1 || i + 1 >= argv.length) throw new Error('headless-session: --config <path|json> is required');
    const spec = argv[i + 1];
    const trimmed = spec.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    return JSON.parse(fs.readFileSync(spec, 'utf8'));
}

// ---- CLI entry: run detached from the MCP tool (stdio ignored) ----
const isMain = (() => {
    try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); }
    catch { return false; }
})();

if (isMain) {
    (async () => {
        try {
            const cfg = readConfigFromArgv(process.argv.slice(2));
            await runHeadlessSession(cfg);
            process.exit(0);
        } catch (e) {
            // Best-effort: surface the failure to the start artifact if we have a workspace.
            try {
                const cfg = readConfigFromArgv(process.argv.slice(2));
                const P = capturePaths(cfg.workspace || process.cwd());
                fs.mkdirSync(P.captures, { recursive: true });
                writeAtomic(P.startJson, JSON.stringify({ status: 'error', error: e.message }, null, 2));
            } catch { /* nothing we can do */ }
            process.stderr.write(`headless-session failed: ${e.message}\n`);
            process.exit(1);
        }
    })();
}
