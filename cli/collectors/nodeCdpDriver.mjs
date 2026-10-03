/**
 * Node driver for the standalone collector — speaks CDP directly to Node's
 * built-in inspector. No install required (Node 22+ ships global WebSocket).
 *
 * Implements the shared Driver contract used by collector.mjs — see
 * cli/collectors/driver.md for the contract every language driver must meet.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/** Minimal CDP client over Node's built-in WebSocket. */
class Cdp {
    #ws; #id = 0; #pending = new Map(); #handlers = new Map();
    constructor(ws) {
        this.#ws = ws;
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.id && this.#pending.has(m.id)) {
                const { resolve, reject } = this.#pending.get(m.id);
                this.#pending.delete(m.id);
                m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {});
                return;
            }
            if (m.method) (this.#handlers.get(m.method) ?? []).forEach((h) => h(m.params ?? {}));
        };
    }
    on(method, fn) {
        if (!this.#handlers.has(method)) this.#handlers.set(method, []);
        this.#handlers.get(method).push(fn);
    }
    send(method, params = {}, timeoutMs = 10000) {
        const id = ++this.#id;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
            this.#pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
            try { this.#ws.send(JSON.stringify({ id, method, params })); }
            catch (e) { clearTimeout(t); this.#pending.delete(id); reject(e); }
        });
    }
    close() { try { this.#ws.close(); } catch { /* already closed */ } }
}

/**
 * Best-effort coerce a string value (as it arrives over the command channel)
 * into a CDP CallArgument for Debugger.setVariableValue. Tries number, boolean,
 * JSON (objects/arrays), then falls back to the raw string.
 */
function coerceCdpValue(value) {
    if (typeof value !== 'string') return { value };
    const s = value.trim();
    if (s === 'true') return { value: true };
    if (s === 'false') return { value: false };
    if (s === 'null') return { value: null };
    if (s !== '' && !Number.isNaN(Number(s))) return { value: Number(s) };
    if (/^[[{]/.test(s)) {
        try { return { value: JSON.parse(s) }; } catch { /* not JSON */ }
    }
    return { value };
}

export class NodeCdpDriver extends EventEmitter {
    static isAvailable() {
        return typeof globalThis.WebSocket === 'function'
            ? { ok: true }
            : { ok: false, reason: 'this Node build has no global WebSocket (need Node 22+) to drive the inspector' };
    }

    #proc; #cdp; #scriptUrls = new Map(); #resolvedIds = new Set();
    // Interactive-mode state: the frames of the most recent pause, plus a map of
    // numeric variablesReference handles -> CDP string objectIds (re-minted per
    // pause, since CDP objectIds are only valid for the current pause).
    #lastFrames = []; #handleSeq = 0; #handles = new Map();

    async connect({ program, args = [], cwd, env = {} }) {
        this.programOutput = '';
        this.adapterErrors = [];
        this.#proc = spawn(process.execPath, ['--inspect-brk=0', path.resolve(cwd, program), ...args], {
            cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.#proc.stdout.on('data', (d) => { this.programOutput += d.toString(); });
        this.#proc.on('exit', (code) => this.emit('exit', code));

        const wsUrl = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('inspector did not report a ws:// URL')), 15000);
            this.#proc.stderr.on('data', (d) => {
                const s = d.toString();
                if (!/^Debugger listening|^For help|^Debugger attached/.test(s.trim())) this.adapterErrors.push(s.trim());
                const m = /ws:\/\/\S+/.exec(s);
                if (m) { clearTimeout(t); resolve(m[0]); }
            });
            this.#proc.on('exit', () => { clearTimeout(t); reject(new Error('program exited before the inspector was ready')); });
        });

        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = () => reject(new Error('could not connect to the Node inspector'));
        });
        this.#cdp = new Cdp(ws);
        this.#cdp.on('Debugger.scriptParsed', (p) => this.#scriptUrls.set(p.scriptId, p.url));
        this.#cdp.on('Runtime.executionContextDestroyed', () => this.emit('terminated'));
        this.#cdp.on('Debugger.breakpointResolved', (p) => { if (p.breakpointId) this.#resolvedIds.add(p.breakpointId); });
        this.#cdp.on('Debugger.paused', (p) => this.emit('paused', p));

        await this.#cdp.send('Debugger.enable');
        await this.#cdp.send('Runtime.enable');
        await this.#cdp.send('Debugger.setPauseOnExceptions', { state: 'uncaught' }).catch(() => {});
    }

    async setBreakpoints(breakpoints) {
        const bound = [];
        for (const bp of breakpoints) {
            const base = path.basename(bp.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                const r = await this.#cdp.send('Debugger.setBreakpointByUrl', {
                    lineNumber: Math.max(0, bp.line - 1), urlRegex: `${base}$`, condition: bp.condition || undefined,
                });
                if ((r.locations ?? []).length > 0) this.#resolvedIds.add(r.breakpointId);
                bound.push({ file: bp.file, line: bp.line, id: r.breakpointId });
            } catch (e) {
                bound.push({ file: bp.file, line: bp.line, error: e.message });
            }
        }
        return bound;
    }

    /** Must be called after setBreakpoints — releases the --inspect-brk pause. */
    async run() {
        await this.#cdp.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }

    isResolved(id) { return id ? this.#resolvedIds.has(id) : false; }

    /** Normalize a raw CDP Debugger.paused event into the shared pause shape. */
    async captureState(p) {
        const frames = p.callFrames ?? [];
        // Remember the pause for interactive steering, and re-mint handles: CDP
        // objectIds are only valid for the current pause, so stale handles must go.
        this.#lastFrames = frames;
        this.#handleSeq = 0;
        this.#handles = new Map();
        const top = frames[0];
        const localScope = top?.scopeChain?.find((s) => s.type === 'local') ?? top?.scopeChain?.[0];
        const vars = await this.#readScope(localScope?.object?.objectId);

        let heapUsed;
        try {
            const r = await this.#cdp.send('Debugger.evaluateOnCallFrame', {
                callFrameId: top.callFrameId, expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true,
            });
            const parsed = JSON.parse(r?.result?.value ?? '{}');
            if (typeof parsed.heapUsed === 'number') heapUsed = parsed.heapUsed;
        } catch { /* not available */ }

        let exception;
        if (p.reason === 'exception' || p.reason === 'promiseRejection') {
            const d = p.data ?? {};
            exception = { message: d.description ?? d.value ?? 'Exception', type: d.className };
        }

        const url = this.#scriptUrls.get(top?.location?.scriptId) ?? '';
        return {
            reason: p.reason === 'other' ? 'breakpoint' : p.reason,
            frame: top ? {
                name: top.functionName || '(anonymous)',
                source: url.replace(/^file:\/\//, ''),
                line: (top.location?.lineNumber ?? 0) + 1,
            } : null,
            // CDP's Debugger.paused delivers the COMPLETE call stack (p.callFrames
            // is not truncated like a DAP stackTrace levels cap), so this is the
            // true depth — no totalFrames/full re-request needed here. Do NOT
            // "make it consistent" with the DAP drivers by capping it.
            stackDepth: frames.length || 1,
            vars, heapUsed, exception,
        };
    }

    async #readScope(objectId) {
        if (!objectId) return [];
        try {
            const r = await this.#cdp.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false });
            return (r.result ?? []).map((p) => {
                const v = p.value ?? {};
                const raw = v.type === 'string' ? `'${v.value}'`
                    : v.value !== undefined ? String(v.value)
                    : v.description ?? v.type ?? 'undefined';
                return { name: p.name, value: raw, type: v.className || v.type };
            });
        } catch { return []; }
    }

    async resume() { await this.#cdp.send('Debugger.resume').catch(() => {}); }

    // --- OPTIONAL interactive steering primitives (see cli/collectors/driver.md) ---
    // CDP uses string objectIds, but the loop/MCP contract uses numeric
    // variablesReference. We mint monotonic int handles per pause and resolve them
    // back here, so callers only ever see numbers.

    #mintHandle(objectId) {
        if (!objectId) return 0;
        const id = ++this.#handleSeq;
        this.#handles.set(id, objectId);
        return id;
    }

    async step(mode) {
        const cmd = mode === 'in' ? 'Debugger.stepInto' : mode === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver';
        await this.#cdp.send(cmd).catch(() => {});
    }

    async stackTrace() {
        return (this.#lastFrames ?? []).map((f) => {
            const url = this.#scriptUrls.get(f.location?.scriptId) ?? '';
            return {
                id: f.callFrameId,
                name: f.functionName || '(anonymous)',
                source: url.replace(/^file:\/\//, ''),
                line: (f.location?.lineNumber ?? 0) + 1,
            };
        });
    }

    async scopes({ frameId }) {
        const frame = (this.#lastFrames ?? []).find((f) => f.callFrameId === frameId) ?? this.#lastFrames?.[0];
        const scopes = (frame?.scopeChain ?? []).map((s) => ({
            name: s.type,
            variablesReference: this.#mintHandle(s.object?.objectId),
            expensive: s.type === 'global',
        }));
        return { scopes };
    }

    async variables({ variablesReference }) {
        const objectId = this.#handles.get(variablesReference);
        if (!objectId) return [];
        const vars = await this.#readScope(objectId);
        // #readScope returns {name,value,type}; mint child handles so nested
        // objects can be expanded further.
        const r = await this.#cdp.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false }).catch(() => ({}));
        const childRefs = new Map();
        for (const prop of r.result ?? []) {
            if (prop.value?.objectId) childRefs.set(prop.name, this.#mintHandle(prop.value.objectId));
        }
        return vars.map((v) => ({ ...v, variablesReference: childRefs.get(v.name) ?? 0 }));
    }

    async setVariable({ variablesReference, name, value }) {
        // CDP needs a scope number (0 = innermost local). We map the handle back to
        // its scope index on the top frame; fall back to the innermost scope.
        const top = this.#lastFrames?.[0];
        const objectId = this.#handles.get(variablesReference);
        let scopeNumber = 0;
        if (top && objectId) {
            const idx = (top.scopeChain ?? []).findIndex((s) => s.object?.objectId === objectId);
            if (idx >= 0) scopeNumber = idx;
        }
        const newValue = coerceCdpValue(value);
        await this.#cdp.send('Debugger.setVariableValue', {
            scopeNumber, variableName: name, newValue, callFrameId: top?.callFrameId,
        });
        return { value: String(value), type: typeof newValue.value, variablesReference: 0 };
    }

    async evaluate({ expression, context, frameId }) {
        // Use the caller's frameId when given, else the innermost (top) frame.
        const callFrameId = frameId ?? this.#lastFrames?.[0]?.callFrameId;
        const r = await this.#cdp.send('Debugger.evaluateOnCallFrame', {
            callFrameId, expression, returnByValue: true,
        });
        const res = r?.result ?? {};
        const value = res.value !== undefined ? res.value
            : res.description ?? res.unserializableValue ?? undefined;
        return {
            value: typeof value === 'string' ? value : JSON.stringify(value),
            type: res.className || res.type,
            variablesReference: this.#mintHandle(res.objectId),
        };
    }

    get exited() { return this.#proc?.exitCode !== null && this.#proc?.exitCode !== undefined; }

    close() {
        this.#cdp?.close();
        try { this.#proc?.kill('SIGTERM'); } catch { /* already gone */ }
    }
}
