/**
 * Python driver for the standalone collector — speaks DAP to a debugpy
 * adapter subprocess (`python -m debugpy.adapter`).
 *
 * Implements the shared Driver contract used by collector.mjs — see
 * cli/collectors/driver.md for the contract every language driver must meet.
 *
 * Availability: unlike Node's built-in inspector, debugpy is a THIRD-PARTY
 * package that must be installed in the SAME Python environment as the
 * target program (it is a normal project dependency, like pytest — the
 * collector's own environment is irrelevant). isAvailable() checks the
 * resolved interpreter before we ever spawn anything, so a missing debugpy
 * fails with one clear message instead of a silent timeout.
 *
 * DAP sequencing note (the non-obvious part): the adapter does not resolve
 * `launch` until AFTER it receives `setBreakpoints` + `configurationDone`.
 * Those must be sent in reaction to the `initialized` event, concurrently
 * with — not after awaiting — the `launch` request, or the session deadlocks.
 * Verified against a live debugpy 1.8.21 adapter before shipping this.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { DapClient } from '../dapClient.mjs';

/** Resolve which python3 to use: explicit opt-in, then PATH. */
function resolveInterpreter(pythonPath) {
    return pythonPath || process.env.FLOW_PYTHON || 'python3';
}

export class PythonDapDriver extends EventEmitter {
    /**
     * Checks debugpy is importable in the TARGET interpreter — not the one
     * running this CLI. Synchronous and fast (single `-c` import check).
     */
    static isAvailable(opts = {}) {
        const python = resolveInterpreter(opts.pythonPath);
        const r = spawnSync(python, ['-c', 'import debugpy; import sys; sys.stdout.write(debugpy.__version__)'], { encoding: 'utf8' });
        if (r.error) {
            return { ok: false, reason: `could not run "${python}": ${r.error.message}. Set --python or FLOW_PYTHON to a valid interpreter.` };
        }
        if (r.status !== 0) {
            return {
                ok: false,
                reason: `debugpy is not installed in "${python}". Install it in the SAME environment as the ` +
                    `target program: ${python} -m pip install debugpy. (debugpy is a target-project dependency, ` +
                    'like pytest — it does not ship with this CLI.)',
            };
        }
        return { ok: true, version: r.stdout.trim(), python };
    }

    #dap; #python; #lastThreadId;

    async connect({ program, args = [], cwd, env = {}, pythonPath }) {
        this.programOutput = '';
        this.adapterErrors = [];
        this.#python = resolveInterpreter(pythonPath);
        this.#dap = new DapClient(this.#python, ['-m', 'debugpy.adapter'], { cwd, env });
        this.#dap.on('stderr', (s) => this.adapterErrors.push(s.trim()));
        this.#dap.on('exit', (code) => this.emit('exit', code));
        this.#dap.on('event:output', (b) => {
            if (b.category !== 'telemetry' && typeof b.output === 'string') this.programOutput += b.output;
        });
        this.#dap.on('event:stopped', (body) => this.emit('paused', body));
        this.#dap.on('event:terminated', () => this.emit('terminated'));
        this.#dap.on('event:exited', () => this.emit('terminated'));
        // The adapter may ask to run the debuggee in a terminal — decline so it
        // launches it itself (matches how we run Node headlessly too).
        this.#dap.on('reverseRequest', (req) => this.#dap.respond(req, {}, false));

        await this.#dap.request('initialize', {
            clientID: 'flow-verify', clientName: 'API Flow Test Debugger (headless)',
            adapterID: 'debugpy', pathFormat: 'path',
            linesStartAt1: true, columnsStartAt1: true, supportsRunInTerminalRequest: true,
        });

        // Stash breakpoints/configurationDone until the adapter signals
        // `initialized` — see the file header note on DAP sequencing.
        this.#initializedPromise = new Promise((resolve) => this.#dap.once('event:initialized', resolve));

        this.#launchPromise = this.#dap.request('launch', {
            name: 'flow-verify', type: 'python', request: 'launch',
            program: path.resolve(cwd, program), args, cwd, env,
            console: 'internalConsole', internalConsoleOptions: 'neverOpen', justMyCode: false,
            python: this.#python,
        }, 30000);
    }

    #initializedPromise; #launchPromise;

    async setBreakpoints(breakpoints) {
        await this.#initializedPromise; // must wait: setBreakpoints before this fires is a protocol violation
        const byFile = new Map(); // breakpoints[].file arrives pre-normalized to absolute by collector.mjs
        for (const bp of breakpoints) {
            if (!byFile.has(bp.file)) byFile.set(bp.file, []);
            byFile.get(bp.file).push({ line: bp.line, condition: bp.condition || undefined });
        }
        const bound = [];
        for (const [file, bps] of byFile) {
            try {
                const r = await this.#dap.request('setBreakpoints', { source: { path: file }, breakpoints: bps });
                for (const b of r?.breakpoints ?? []) bound.push({ file, line: b.line, verified: !!b.verified, id: `${file}:${b.line}` });
            } catch (e) {
                for (const b of bps) bound.push({ file, line: b.line, verified: false, error: e.message });
            }
        }
        return bound;
    }

    /** Must be called after setBreakpoints — sends configurationDone, unblocking launch. */
    async run() {
        await this.#dap.request('configurationDone', {}).catch((e) => this.adapterErrors.push(`configurationDone: ${e.message}`));
        this.#launchPromise.catch((e) => this.adapterErrors.push(`launch: ${e.message}`));
    }

    isResolved(id) { return !!id; } // debugpy's setBreakpoints response is already synchronous/final

    /** Normalize a raw DAP `stopped` event body into the shared pause shape. */
    async captureState(body) {
        const threadId = body?.threadId ?? 1;
        this.#lastThreadId = threadId;
        let stack = [];
        // Capture the WHOLE response (not just .stackFrames) so `totalFrames` is
        // readable: the `levels: 20` cap TRUNCATES the frame array, so its length
        // saturates at 20 and recursion deeper than that stops increasing —
        // defeating recursion detection in the Call Map. See captureState depth
        // handling below.
        let stackResp;
        try { stackResp = await this.#dap.request('stackTrace', { threadId, startFrame: 0, levels: 20 }); stack = stackResp?.stackFrames ?? []; }
        catch { /* mid-teardown */ }
        const top = stack[0];
        let vars = [];
        if (top) {
            try {
                const sc = await this.#dap.request('scopes', { frameId: top.id });
                const local = (sc?.scopes ?? []).find((s) => /local/i.test(s.name)) ?? sc?.scopes?.[0];
                if (local && !local.expensive) {
                    const vr = await this.#dap.request('variables', { variablesReference: local.variablesReference });
                    vars = (vr?.variables ?? []).map((v) => ({ name: v.name, value: v.value, type: v.type }));
                }
            } catch { /* skip */ }
        }

        let heapUsed;
        if (top) {
            try {
                // Best-effort RSS-based proxy — Python has no single "heapUsed"
                // equivalent to Node's; resident set size is the closest signal
                // available without adding a dependency on the target side.
                const r = await this.#dap.request('evaluate', {
                    expression: '__import__("resource").getrusage(__import__("resource").RUSAGE_SELF).ru_maxrss',
                    frameId: top.id, context: 'repl',
                });
                const n = Number(String(r?.result ?? '').trim());
                // ru_maxrss is KB on Linux, bytes on macOS/BSD — normalize to bytes.
                if (Number.isFinite(n)) heapUsed = n > 1e7 ? n : n * 1024;
            } catch { /* not available on this platform */ }
        }

        let exception;
        if (body?.reason === 'exception') {
            try {
                const info = await this.#dap.request('exceptionInfo', { threadId });
                exception = { message: info?.description ?? info?.exceptionId ?? 'Exception', type: info?.exceptionId };
            } catch { /* none */ }
        }

        // Real depth: prefer DAP `totalFrames` (true total even when stackFrames
        // is truncated by `levels`). When the adapter omits it AND we hit the
        // truncation cap, pay for ONE full-stack request (no `levels`) to read
        // the real depth; otherwise fall back to the truncated length.
        const totalFrames = stackResp?.totalFrames;
        let stackDepth = (typeof totalFrames === 'number' && totalFrames >= stack.length)
            ? totalFrames
            : stack.length;
        if (!(typeof totalFrames === 'number' && totalFrames >= stack.length) && stack.length === 20) {
            try {
                const full = await this.#dap.request('stackTrace', { threadId, startFrame: 0 });
                stackDepth = full?.stackFrames?.length ?? stack.length;
            } catch { /* adapter refused — keep truncated length */ }
        }

        return {
            reason: body?.reason ?? 'breakpoint',
            frame: top ? { name: top.name, source: top.source?.path ?? top.source?.name, line: top.line } : null,
            stackDepth: stackDepth || 1,
            vars, heapUsed, exception,
        };
    }

    async resume() {
        const threadId = this.#lastThreadId ?? 1;
        await this.#dap.request('continue', { threadId }).catch(() => {});
    }

    // --- OPTIONAL interactive steering primitives (see cli/collectors/driver.md) ---
    // Thin wrappers over the existing DapClient — no new protocol code.

    async step(mode) {
        const threadId = this.#lastThreadId ?? 1;
        const cmd = mode === 'in' ? 'stepIn' : mode === 'out' ? 'stepOut' : 'next';
        await this.#dap.request(cmd, { threadId });
    }

    async stackTrace({ threadId } = {}) {
        const tid = threadId ?? this.#lastThreadId ?? 1;
        const r = await this.#dap.request('stackTrace', { threadId: tid, startFrame: 0, levels: 20 });
        return (r?.stackFrames ?? []).map((f) => ({
            id: f.id, name: f.name, source: f.source?.path ?? f.source?.name, line: f.line,
        }));
    }

    async scopes({ frameId }) {
        return this.#dap.request('scopes', { frameId });
    }

    async variables({ variablesReference }) {
        const r = await this.#dap.request('variables', { variablesReference });
        return (r?.variables ?? []).map((v) => ({
            name: v.name, value: v.value, type: v.type, variablesReference: v.variablesReference,
        }));
    }

    async setVariable({ variablesReference, name, value }) {
        // DAP takes the string value directly.
        const r = await this.#dap.request('setVariable', { variablesReference, name, value });
        return { value: r?.value, type: r?.type, variablesReference: r?.variablesReference };
    }

    async evaluate({ expression, context, frameId }) {
        const r = await this.#dap.request('evaluate', { expression, frameId, context: context || 'repl' });
        return { value: r?.result, type: r?.type, variablesReference: r?.variablesReference };
    }

    get exited() { return this.#dap?.closed ?? true; }

    close() {
        this.#dap?.request('disconnect', { terminateDebuggee: true }, 4000).catch(() => {});
        this.#dap?.kill();
    }
}
