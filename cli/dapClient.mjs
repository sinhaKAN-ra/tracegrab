/**
 * Minimal DAP (Debug Adapter Protocol) client over stdio — zero dependencies.
 *
 * This is what removes the IDE dependency: instead of relying on
 * vscode.debug, we spawn a real debug adapter (js-debug for Node, debugpy for
 * Python) and speak DAP to it directly. Everything downstream — the call-tree
 * builder, diagnosis, FlowTrace, contracts — is unchanged, because they all
 * consume the same recorded pause log.
 *
 * Wire format: Content-Length headers + JSON bodies (same as LSP).
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class DapClient extends EventEmitter {
    #proc;
    #seq = 1;
    #pending = new Map(); // seq -> {resolve, reject}
    #buf = Buffer.alloc(0);
    #closed = false;

    /**
     * @param {string} command adapter executable (e.g. 'node')
     * @param {string[]} args  adapter args (e.g. [jsDebugPath])
     * @param {object}   opts  { cwd, env }
     */
    constructor(command, args, opts = {}) {
        super();
        this.#proc = spawn(command, args, {
            cwd: opts.cwd || process.cwd(),
            env: { ...process.env, ...(opts.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.#proc.stdout.on('data', (d) => this.#onData(d));
        this.#proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
        this.#proc.on('exit', (code) => { this.#closed = true; this.emit('exit', code); });
        this.#proc.on('error', (e) => this.emit('error', e));
    }

    get closed() { return this.#closed; }

    #onData(chunk) {
        this.#buf = Buffer.concat([this.#buf, chunk]);
        for (;;) {
            const headerEnd = this.#buf.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = this.#buf.subarray(0, headerEnd).toString('utf8');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) { this.#buf = this.#buf.subarray(headerEnd + 4); continue; }
            const len = Number(m[1]);
            const start = headerEnd + 4;
            if (this.#buf.length < start + len) return; // wait for the rest
            const body = this.#buf.subarray(start, start + len).toString('utf8');
            this.#buf = this.#buf.subarray(start + len);
            let msg;
            try { msg = JSON.parse(body); } catch { continue; }
            this.#dispatch(msg);
        }
    }

    #dispatch(msg) {
        if (msg.type === 'response') {
            const p = this.#pending.get(msg.request_seq);
            if (p) {
                this.#pending.delete(msg.request_seq);
                msg.success ? p.resolve(msg.body ?? {}) : p.reject(new Error(msg.message || `DAP ${msg.command} failed`));
            }
            return;
        }
        if (msg.type === 'event') {
            this.emit('event', msg);
            this.emit(`event:${msg.event}`, msg.body ?? {});
            return;
        }
        if (msg.type === 'request') this.emit('reverseRequest', msg); // e.g. runInTerminal
    }

    /** Send a DAP request and await its response. */
    request(command, args = {}, timeoutMs = 15000) {
        if (this.#closed) return Promise.reject(new Error('adapter closed'));
        const seq = this.#seq++;
        const payload = JSON.stringify({ seq, type: 'request', command, arguments: args });
        const out = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(seq);
                reject(new Error(`DAP ${command} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.#pending.set(seq, {
                resolve: (b) => { clearTimeout(timer); resolve(b); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            try { this.#proc.stdin.write(out); } catch (e) { clearTimeout(timer); this.#pending.delete(seq); reject(e); }
        });
    }

    /** Respond to a reverse request (adapters block until answered). */
    respond(req, body = {}, success = true) {
        const payload = JSON.stringify({
            seq: this.#seq++, type: 'response', request_seq: req.seq,
            command: req.command, success, body,
        });
        try { this.#proc.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`); } catch { /* closed */ }
    }

    /** Wait for a named event once (with timeout). */
    waitFor(event, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off(`event:${event}`, onEvt);
                reject(new Error(`timed out waiting for DAP event "${event}"`));
            }, timeoutMs);
            const onEvt = (body) => { clearTimeout(timer); resolve(body); };
            this.once(`event:${event}`, onEvt);
        });
    }

    kill() {
        this.#closed = true;
        try { this.#proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
}
