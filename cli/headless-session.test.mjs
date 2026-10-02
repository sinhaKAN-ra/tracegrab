#!/usr/bin/env node
/**
 * End-to-end tests for the HEADLESS interactive session runner
 * (cli/headless-session.mjs, FEAT-002) — the long-lived process that holds a
 * live debug session with no IDE and services the agent-command/agent-ack file
 * channel the extension already uses.
 *
 * Framework-free, mirrors cli/collector(-interactive).test.mjs: it drives the
 * runner the way the MCP tool does — by writing .flow-debugger/agent-command.json
 * and reading .flow-debugger/agent-ack.json — against a tiny real Node program,
 * and asserts the FEAT-002 spec checklist on the shared capture surface
 * (session.json / latest.json / log.ndjson) via the SAME zero-dep helpers the
 * MCP server uses (evaluateDebugStatus, filterLogBySession, buildCallTree).
 *
 * Python cases SKIP (not fail) when debugpy is unavailable.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { runHeadlessSession } from './headless-session.mjs';
import { availableDrivers } from './collector.mjs';
import { evaluateDebugStatus, filterLogBySession } from '../mcp/callmap.mjs';
import { buildCallTree } from '../mcp/callmap.mjs';

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok - ${name}`);
    } catch (e) {
        if (e?.skip) { skipped++; console.log(`  skip - ${name} (${e.message})`); return; }
        failed++;
        console.error(`  FAIL - ${name}\n    ${e.stack?.split('\n').join('\n    ')}`);
    }
}
class Skip extends Error { skip = true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-headless-test-'));
    fs.mkdirSync(path.join(dir, 'src'));
    return dir;
}

function paths(ws) {
    const dir = path.join(ws, '.flow-debugger');
    const captures = path.join(dir, 'captures');
    return {
        session: path.join(captures, 'session.json'),
        latest: path.join(captures, 'latest.json'),
        log: path.join(captures, 'log.ndjson'),
        command: path.join(dir, 'agent-command.json'),
        ack: path.join(dir, 'agent-ack.json'),
    };
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readStatus = (ws) => evaluateDebugStatus(readJson(paths(ws).session), Date.now());

/** Drive the runner over the file channel exactly like the MCP server does. */
function makeDriver(ws) {
    const P = paths(ws);
    let n = 0;
    return {
        /** Write agent-command.json atomically (unique id, like writeCommand). */
        send(cmd) {
            const id = `t${++n}-${Date.now()}`;
            const tmp = `${P.command}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ id, ...cmd }, null, 2), 'utf8');
            fs.renameSync(tmp, P.command);
            return id;
        },
        /** Poll agent-ack.json for a specific command id. */
        async waitForAck(id, timeoutMs = 8000) {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                const ack = readJson(P.ack);
                if (ack && ack.id === id) return ack;
                await sleep(60);
            }
            return { id, ok: false, message: 'timeout' };
        },
    };
}

/** Wait until the runner's status surface satisfies `pred`, or time out. */
async function waitFor(fn, pred, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const v = fn();
        if (pred(v)) return v;
        await sleep(60);
    }
    return fn();
}

console.log('headless-session.test.mjs');

await test('node: full interactive lifecycle over the file channel', async () => {
    const ws = tmpWorkspace();
    // Breakpoint on line 2 hits twice (loop); between hits we mutate `marker` and
    // continue. The function returns `marker`, so the mutation is observable.
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function findItem(n) {',
        '    let marker = n;',          // line 2 — breakpoint
        '    return marker;',
        '}',
        'let total = 0;',
        'for (let i = 0; i < 2; i++) { total += findItem(i); }',
        'console.log(total);',
    ].join('\n'));

    const drv = makeDriver(ws);
    const P = paths(ws);

    // Launch the runner (resolves only when the program terminates).
    const runP = runHeadlessSession({
        language: 'node', program: 'src/app.js', workspace: ws, cwd: ws,
        breakpoints: [{ file: 'src/app.js', line: 2 }],
        totalMs: 15000,
    });

    // 1. session.json reports live + startedBy:'agent' + a headless:* id, and
    //    evaluateDebugStatus goes RUNNING -> PAUSED.
    const liveStatus = await waitFor(() => readStatus(ws), (s) => s.live === true);
    assert.equal(liveStatus.live, true, 'session.json should report live:true');
    assert.equal(liveStatus.startedBy, 'agent', "startedBy should be 'agent'");
    assert.ok(typeof liveStatus.sessionId === 'string' && liveStatus.sessionId.startsWith('headless:'),
        `sessionId should be a headless:* id (got ${liveStatus.sessionId})`);

    const paused = await waitFor(() => readStatus(ws), (s) => s.paused === true);
    assert.equal(paused.paused, true, 'get_debug_status-equivalent should report PAUSED');
    assert.ok(/PAUSED/.test(paused.verdict), `verdict should say PAUSED (got ${paused.verdict})`);
    const drivenId = paused.sessionId;

    // Node's --inspect-brk emits a break-on-start pause at module entry before any
    // breakpoint. The interactive runner parks at it like any pause; drive past it
    // until we land inside findItem() where `marker` is in scope.
    const atBreakpoint = async () => {
        for (let i = 0; i < 10; i++) {
            const snap = await waitFor(() => readJson(P.latest), (s) => s && s.waiting === true, 8000);
            if (snap && snap.frame && snap.frame.name === 'findItem') return snap;
            const cid = drv.send({ action: 'continue' });
            await drv.waitForAck(cid);
            // wait for the next (different-seq) pause before re-checking
            await waitFor(() => readJson(P.latest), (s) => s && s.waiting === true && s.seq > (snap?.seq ?? 0), 8000);
        }
        throw new Error('never reached a pause inside findItem()');
    };

    // 2. latest.json reports a LIVE pause (waiting:true, matching sessionId).
    const snap = await atBreakpoint();
    assert.equal(snap.waiting, true, 'latest.json should report waiting:true');
    assert.equal(snap.sessionEnded, false, 'latest.json should not be ended while paused');
    assert.equal(snap.sessionId, drivenId, 'latest.json sessionId should match session.json');
    assert.ok(Array.isArray(snap.scopes) && snap.scopes.length >= 1, 'pause snapshot should carry scopes');

    // Find the local scope + its `marker` variablesReference for the setVariable.
    const localScope = snap.scopes.find((sc) => /local/i.test(sc.name)) ?? snap.scopes[0];
    assert.ok(localScope && typeof localScope.variablesReference === 'number', 'need a local scope ref');

    // 3. setVariable changes the value (ack result and the next pause's vars).
    const svId = drv.send({ action: 'setVariable', variablesReference: localScope.variablesReference, name: 'marker', value: '999' });
    const svAck = await drv.waitForAck(svId);
    assert.equal(svAck.ok, true, 'setVariable should ack ok');

    // Confirm via evaluate against the live frame.
    const evId = drv.send({ action: 'evaluate', expression: 'marker' });
    const evAck = await drv.waitForAck(evId);
    assert.equal(evAck.ok, true, 'evaluate should ack ok');
    assert.equal(String(evAck.result.value), '999', 'evaluate should reflect the mutated value');

    // 4. continue advances to the next pause and session.json clears pausedThreadId.
    //    Observe the resume by watching for either the paused flag clearing OR
    //    latest.json flipping to waiting:false (the runner's markResumed analog),
    //    then confirm a later pause (higher seq) proves execution advanced.
    const firstSeq = snap.seq;
    let sawResume = false;
    const contId = drv.send({ action: 'continue' });
    // Poll tightly for the resume transition before the next pause re-sets it.
    const resumeStart = Date.now();
    while (Date.now() - resumeStart < 8000) {
        const s = readStatus(ws);
        const l = readJson(P.latest);
        if (s.paused === false || !s.live || (l && l.waiting === false) || (l && l.seq > firstSeq)) { sawResume = true; break; }
        await sleep(15);
    }
    const contAck = await drv.waitForAck(contId);
    assert.equal(contAck.ok, true, 'continue should ack ok');
    assert.ok(sawResume, 'continue should clear pausedThreadId / flip latest.json to not-waiting');

    // Advance to the next pause (new seq) — proves continue moved execution on.
    const nextSnap = await waitFor(() => readJson(P.latest), (s) => s && s.waiting === true && s.seq > firstSeq, 8000);
    assert.ok(nextSnap && nextSnap.seq > firstSeq, 'continue should advance to a later pause');

    // Drain any remaining pauses so the program can terminate.
    for (let i = 0; i < 8; i++) {
        const s = readStatus(ws);
        if (!s.live) break;
        if (s.paused) drv.send({ action: 'continue' });
        await sleep(150);
    }

    const res = await runP; // resolves on program termination
    assert.equal(res.sessionId, drivenId, 'runner should report the driven id');

    // 5. On terminate: session.json flips live:false and latest.json sessionEnded:true.
    const ended = readStatus(ws);
    assert.equal(ended.live, false, 'session.json should flip to NOT RUNNING on terminate');
    const finalSnap = readJson(P.latest);
    assert.equal(finalSnap.sessionEnded, true, 'latest.json should be marked sessionEnded on terminate');
    assert.equal(finalSnap.waiting, false, 'latest.json should not be waiting after terminate');

    // 6. sessionId stamping: build the tree from the stamped log via the call-map path.
    const logLines = fs.readFileSync(P.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const { pauses, belongsToDriven } = filterLogBySession(logLines, drivenId);
    assert.equal(belongsToDriven, true, 'the stamped log must belong to the driven session');
    assert.ok(logLines.every((l) => l.sessionId === drivenId), 'every log line should be stamped with the driven id');
    const roots = buildCallTree(pauses);
    const names = JSON.stringify(roots);
    assert.ok(names.includes('findItem'), "the run's method (findItem) should appear in the call tree");

    fs.rmSync(ws, { recursive: true, force: true });
});

const pyAvail = availableDrivers({ pythonPath: process.env.FLOW_PYTHON }).python;

await test('python: headless session parks, mutates, and tears down via debugpy', async () => {
    if (!pyAvail.ok) throw new Skip(pyAvail.reason);
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.py'), [
        'def find_item(n):',
        '    marker = n',       // line 2 — breakpoint
        '    return marker',
        '',
        'total = 0',
        'for i in range(2):',
        '    total += find_item(i)',
        'print(total)',
    ].join('\n'));

    const drv = makeDriver(ws);
    const P = paths(ws);
    const runP = runHeadlessSession({
        language: 'python', program: 'src/app.py', workspace: ws, cwd: ws,
        breakpoints: [{ file: 'src/app.py', line: 2 }],
        totalMs: 20000, pythonPath: process.env.FLOW_PYTHON,
    });

    const live = await waitFor(() => readStatus(ws), (s) => s.live === true, 15000);
    assert.ok(live.sessionId.startsWith('headless:'), 'python headless id');
    const snap = await waitFor(() => readJson(P.latest), (s) => s && s.waiting === true, 15000);
    const drivenId = snap.sessionId;
    const local = snap.scopes.find((sc) => /local/i.test(sc.name)) ?? snap.scopes[0];
    const svId = drv.send({ action: 'setVariable', variablesReference: local.variablesReference, name: 'marker', value: '999' });
    const svAck = await drv.waitForAck(svId);
    assert.equal(svAck.ok, true, 'python setVariable should ack ok');

    for (let i = 0; i < 8; i++) {
        const s = readStatus(ws);
        if (!s.live) break;
        if (s.paused) drv.send({ action: 'continue' });
        await sleep(200);
    }
    await runP;
    const ended = readStatus(ws);
    assert.equal(ended.live, false, 'python session should tear down to NOT RUNNING');
    const logLines = fs.readFileSync(P.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const { belongsToDriven } = filterLogBySession(logLines, drivenId);
    assert.equal(belongsToDriven, true);
    fs.rmSync(ws, { recursive: true, force: true });
});

console.log(`\nRESULT: ${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} (${passed} passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
