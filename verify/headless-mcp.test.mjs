#!/usr/bin/env node
/**
 * End-to-end test of the HEADLESS interactive session over the MCP server
 * (FEAT-002) — proves start_headless_session / stop_headless_session and the
 * single-owner guard work over the real stdio transport, and that the EXISTING
 * steering tools (get_pause_state, debug_set_variable, debug_continue) drive the
 * headless pause with NO change, and that get_capabilities' headlessSessionLive
 * toggles false -> true -> false.
 *
 * Framework-free (plain assert counter), matching the other verify/ tests. It
 * spawns mcp/flow-mcp.mjs as a child over newline-delimited JSON (the server's
 * framing) in a temp workspace. CI-safe: uses Node only (always available).
 */
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ok - ${name}`); }
    else { failed++; console.error(`  FAIL - ${name}${detail ? `\n    ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverPath = fileURLToPath(new URL('../mcp/flow-mcp.mjs', import.meta.url));

/** A tiny newline-delimited JSON-RPC client over the server's stdio. */
function startServer(workspace) {
    const child = spawn(process.execPath, [serverPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, FLOW_WORKSPACE: workspace },
    });
    let buf = '';
    const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
            } catch { /* ignore noise */ }
        }
    });
    let nextId = 1;
    function rpc(method, params, timeoutMs = 30000) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc ${method} timed out`)); }, timeoutMs);
            pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    /** Call a tool and parse the JSON text payload (tools return text content). */
    async function callTool(name, args = {}, timeoutMs = 30000) {
        const msg = await rpc('tools/call', { name, arguments: args }, timeoutMs);
        const txt = msg?.result?.content?.[0]?.text ?? '';
        try { return { raw: txt, json: JSON.parse(txt) }; } catch { return { raw: txt, json: null }; }
    }
    return { child, rpc, callTool, close: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

function tmpWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-headless-mcp-'));
    fs.mkdirSync(path.join(dir, 'src'));
    return dir;
}

async function main() {
    console.log('headless-mcp.test.mjs');
    const ws = tmpWorkspace();
    // A loop so the breakpoint hits more than once (lets us steer across pauses).
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function findItem(n) {',
        '    let marker = n;',          // line 2 — breakpoint
        '    return marker;',
        '}',
        'let total = 0;',
        'for (let i = 0; i < 3; i++) { total += findItem(i); }',
        'console.log(total);',
    ].join('\n'));

    const srv = startServer(ws);
    try {
        await srv.rpc('initialize', {});

        // 1. headlessSessionLive is false before anything starts.
        const cap0 = await srv.callTool('get_capabilities', { workspace: ws });
        check('get_capabilities starts with headlessSessionLive:false',
            cap0.json?.debugSession?.headlessSessionLive === false, cap0.raw);

        // 2. start_headless_session with a tiny Node program + a breakpoint succeeds.
        const start = await srv.callTool('start_headless_session', {
            workspace: ws, language: 'node', program: 'src/app.js',
            breakpoints: [{ file: 'src/app.js', line: 2 }],
        });
        check('start_headless_session succeeds', start.json?.ok === true, start.raw);
        check('start returns a headless:* sessionId',
            typeof start.json?.sessionId === 'string' && start.json.sessionId.startsWith('headless:'), start.raw);

        // 3. get_capabilities then shows headlessSessionLive:true.
        const cap1 = await srv.callTool('get_capabilities', { workspace: ws });
        check('get_capabilities now shows headlessSessionLive:true',
            cap1.json?.debugSession?.headlessSessionLive === true, cap1.raw);

        // 4. get_pause_state reports a live pause. Drive past Node's break-on-start
        //    until we are parked inside findItem() where `marker` is in scope.
        let pause = null;
        for (let i = 0; i < 10; i++) {
            const ps = await srv.callTool('get_pause_state', { workspace: ws });
            const snap = ps.json?.pause;
            if (ps.json?.live && snap?.waiting && snap?.frame?.name === 'findItem') { pause = snap; break; }
            await srv.callTool('debug_continue', { workspace: ws });
            await sleep(400);
        }
        check('get_pause_state reports a live pause inside findItem', pause !== null,
            pause ? '' : 'never parked inside findItem');

        // 5. debug_set_variable drives the headless pause (existing tool, unchanged).
        let svOk = false;
        if (pause) {
            const local = (pause.scopes || []).find((s) => /local/i.test(s.name)) ?? pause.scopes?.[0];
            const sv = await srv.callTool('debug_set_variable', {
                workspace: ws, variablesReference: local.variablesReference, name: 'marker', value: '999', confirm: true,
            });
            svOk = sv.json && sv.json.ok !== false;
        }
        check('debug_set_variable drives the headless pause', svOk);

        // debug_continue advances the session.
        const cont = await srv.callTool('debug_continue', { workspace: ws });
        check('debug_continue drives the headless pause', /continue/i.test(cont.raw), cont.raw);

        // 6. a SECOND start while one is live is refused by the single-owner guard.
        const start2 = await srv.callTool('start_headless_session', {
            workspace: ws, language: 'node', program: 'src/app.js',
            breakpoints: [{ file: 'src/app.js', line: 2 }],
        });
        check('second start_headless_session is refused (single-owner guard)',
            start2.json?.ok === false && /already live|unsupported/i.test(start2.json?.error || ''), start2.raw);

        // 7. stop_headless_session tears it down.
        const stop = await srv.callTool('stop_headless_session', { workspace: ws });
        check('stop_headless_session succeeds', stop.json?.ok === true, stop.raw);

        // get_capabilities returns to headlessSessionLive:false.
        let backToFalse = false;
        for (let i = 0; i < 20; i++) {
            const cap = await srv.callTool('get_capabilities', { workspace: ws });
            if (cap.json?.debugSession?.headlessSessionLive === false) { backToFalse = true; break; }
            await sleep(200);
        }
        check('get_capabilities returns to headlessSessionLive:false after stop', backToFalse);
    } finally {
        srv.close();
        // Best-effort: kill any surviving detached runner by reading its pid.
        try {
            const sess = JSON.parse(fs.readFileSync(path.join(ws, '.flow-debugger', 'captures', 'session.json'), 'utf8'));
            if (sess && typeof sess.pid === 'number') { try { process.kill(sess.pid, 'SIGKILL'); } catch { /* gone */ } }
        } catch { /* none */ }
        fs.rmSync(ws, { recursive: true, force: true });
    }

    console.log(`\nRESULT: ${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} (${passed} passed, ${failed} failed)`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
