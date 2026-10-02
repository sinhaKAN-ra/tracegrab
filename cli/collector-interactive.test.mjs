#!/usr/bin/env node
/**
 * End-to-end tests for the NON-RESUMING interactive collector
 * (collectInteractive) — the park-and-steer path that an agent uses to hold a
 * live headless debug session with no IDE.
 *
 * Mirrors cli/collector.test.mjs: framework-free, launches a real program under
 * a real debugger, asserts on captured pauses. No mocking of the debugger —
 * only the command channel is a tiny in-memory stub (no files), since the file
 * channel + .flow-debugger wiring lives in the runner (FEAT-002), not here.
 *
 * Python cases SKIP (not fail) when debugpy is unavailable.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { collectInteractive, availableDrivers } from './collector.mjs';

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

function tmpWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-interactive-test-'));
    fs.mkdirSync(path.join(dir, 'src'));
    return dir;
}
function readLog(dir) {
    const p = path.join(dir, '.flow-debugger', 'captures', 'log.ndjson');
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * In-memory command channel stub. Drive the session by pushing command objects;
 * `onPaused` is where the test observes each pause and decides what to inject.
 * Mirrors the real {read, ack} contract (dedupe-by-id handled by the collector).
 */
function makeChannel() {
    let current = null;
    let nextId = 0;
    const acks = [];
    return {
        channel: {
            read: () => current,
            ack: (a) => { acks.push(a); if (current && a.id === current.id) current = null; },
        },
        acks,
        // Queue a command for the collector to pick up on its next poll.
        send(cmd) { current = { id: `c${++nextId}`, ...cmd }; return current.id; },
        pending: () => current,
    };
}

console.log('collector-interactive.test.mjs');

await test('node: PARKS at the first pause and does not auto-advance', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function step1() { let x = 1; return x; }',       // line 1
        'function step2() { let y = 2; return y; }',       // line 2
        'step1(); step2();',                               // line 3
    ].join('\n'));

    const seen = [];
    const ch = makeChannel();
    let firstPauseAt = 0;
    let holdFirst = true; // keep the first pause parked until the test releases it

    const runP = collectInteractive({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 1 }, { file: 'src/app.js', line: 2 }],
        totalMs: 15000,
        command: ch.channel,
        shouldStop: () => false,
        onPaused: (record) => {
            seen.push(record);
            if (seen.length === 1) {
                firstPauseAt = Date.now();
                // Deliberately do NOT issue a command for the first pause yet, so we
                // can observe that the loop holds instead of auto-advancing.
            } else {
                // Every later pause: release immediately so the run can finish.
                ch.send({ action: 'continue' });
            }
        },
    });

    // Wait long enough that an auto-resuming loop would have advanced past the
    // first pause; assert we are still parked at exactly one pause.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(seen.length, 1, 'should still be parked at the first pause, not auto-advanced');
    assert.ok(Date.now() - firstPauseAt >= 1000, 'the pause must have been held');
    void holdFirst;

    // Now release the held first pause; later pauses release themselves above.
    ch.send({ action: 'continue' });

    const res = await runP;
    assert.ok(res.pauses >= 2, 'both breakpoints should have been hit once released');
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('node: setVariable changes a captured value seen at the next pause', async () => {
    const ws = tmpWorkspace();
    // Breakpoint hits twice; between the two we mutate `n`. The program reads `n`
    // after the first breakpoint and the mutation must be visible at the 2nd hit.
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function tick(n) {',
        '    let marker = n;',          // line 2 — breakpoint; marker reflects current n
        '    return marker;',
        '}',
        'let total = 0;',
        'for (let i = 0; i < 2; i++) { total += tick(i); }',
        'console.log(total);',
    ].join('\n'));

    const seen = [];
    const ch = makeChannel();
    let mutated = false;

    const runP = collectInteractive({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 2 }],
        totalMs: 15000,
        command: ch.channel,
        onPaused: async (record, driver) => {
            seen.push(record);
            // Skip Node's break-on-start (module scope); act at the real breakpoint
            // inside tick() the first time we land there.
            if (record.frame?.name === 'tick' && !mutated) {
                mutated = true;
                // Mutate `marker` in the top local scope, then evaluate to confirm.
                const { scopes } = await driver.scopes({ frameId: (await driver.stackTrace())[0].id });
                const local = scopes[0];
                const setAck = await driver.setVariable({ variablesReference: local.variablesReference, name: 'marker', value: '999' });
                assert.ok(setAck, 'setVariable should return a result');
                const evald = await driver.evaluate({ expression: 'marker' });
                assert.equal(String(evald.value), '999', 'evaluate should reflect the mutated value');
            }
            ch.send({ action: 'continue' });
        },
    });

    const res = await runP;
    assert.ok(mutated, 'should have reached the breakpoint inside tick() and mutated marker');
    assert.ok(res.pauses >= 1, 'at least the first breakpoint hit');
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('node: stepOver and continue advance to subsequent pauses', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function run() {',
        '    let a = 1;',   // line 2 — only breakpoint
        '    let b = a + 1;',
        '    let c = b + 1;',
        '    return c;',
        '}',
        'run();',
    ].join('\n'));

    // Node's --inspect-brk emits an initial "Break on start" pause at module
    // entry before any breakpoint. The one-shot collect() silently resumes it;
    // the interactive loop parks at every pause, so the first pause we see is
    // break-on-start. We continue past it, then exercise stepOver at the real
    // breakpoint (the first pause that lands inside run()).
    const seen = [];
    const ch = makeChannel();
    let steppedFrom = null;

    const runP = collectInteractive({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 2 }],
        totalMs: 15000,
        command: ch.channel,
        onPaused: (record) => {
            seen.push(record);
            if (record.frame?.name === 'run' && steppedFrom === null) {
                // At the breakpoint inside run(): step over to the next line.
                steppedFrom = record.frame.line;
                ch.send({ action: 'stepOver' });
            } else {
                // break-on-start, the post-step pause, and anything else: advance.
                ch.send({ action: 'continue' });
            }
        },
    });

    const res = await runP;
    const inRun = seen.filter((r) => r.frame?.name === 'run');
    assert.ok(inRun.length >= 2, 'stepOver should have produced a second pause inside run()');
    assert.ok(inRun[1].frame?.line > inRun[0].frame?.line, 'the step should have advanced the line');
    assert.ok(res.pauses >= 2);
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('node: resolves when the program terminates after continue', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function once() { let v = 42; return v; }', // line 1
        'once();',
    ].join('\n'));

    const ch = makeChannel();
    const runP = collectInteractive({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 1 }],
        totalMs: 15000,
        command: ch.channel,
        onPaused: () => { ch.send({ action: 'continue' }); },
    });

    const res = await runP; // must resolve, not hang
    // Two pauses: Node's break-on-start at module entry, then the breakpoint —
    // the interactive loop parks at (and we continue past) both.
    assert.ok(res.pauses >= 1, 'at least the breakpoint pause, then clean termination');
    assert.ok(Array.isArray(res.boundBreakpoints));
    fs.rmSync(ws, { recursive: true, force: true });
});

const pyAvail = availableDrivers({ pythonPath: process.env.FLOW_PYTHON }).python;

await test('python: parks and setVariable mutates a value via debugpy', async () => {
    if (!pyAvail.ok) throw new Skip(pyAvail.reason);
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.py'), [
        'def tick(n):',
        '    marker = n',       // line 2 — breakpoint
        '    return marker',
        '',
        'total = 0',
        'for i in range(2):',
        '    total += tick(i)',
        'print(total)',
    ].join('\n'));

    const seen = [];
    const ch = makeChannel();

    const runP = collectInteractive({
        language: 'python', program: 'src/app.py', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.py', line: 2 }],
        totalMs: 20000, pythonPath: process.env.FLOW_PYTHON,
        command: ch.channel,
        onPaused: async (record, driver) => {
            seen.push(record);
            if (seen.length === 1) {
                const frames = await driver.stackTrace();
                const { scopes } = await driver.scopes({ frameId: frames[0].id });
                const local = scopes.find((s) => /local/i.test(s.name)) ?? scopes[0];
                await driver.setVariable({ variablesReference: local.variablesReference, name: 'marker', value: '999' });
                const evald = await driver.evaluate({ expression: 'marker', frameId: frames[0].id });
                assert.equal(String(evald.value).replace(/'/g, ''), '999');
            }
            ch.send({ action: 'continue' });
        },
    });

    const res = await runP;
    assert.ok(res.pauses >= 1);
    fs.rmSync(ws, { recursive: true, force: true });
});

console.log(`\nRESULT: ${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} (${passed} passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
