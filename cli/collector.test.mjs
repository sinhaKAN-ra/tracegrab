#!/usr/bin/env node
/**
 * Real end-to-end tests for the headless collector — these
 * actually launch a program under a debugger and assert on captured pauses.
 * No mocking: this is the thing that had a silent path-resolution bug last
 * time it shipped without a test like this.
 *
 * Python cases are SKIPPED (not failed) when debugpy is unavailable, since
 * debugpy is a target-project dependency this CLI does not install for you.
 * Set FLOW_PYTHON to a venv with debugpy installed to run them for real.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { collect, availableDrivers } from './collector.mjs';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-collector-test-'));
    fs.mkdirSync(path.join(dir, 'src'));
    return dir;
}
function readLog(dir) {
    const p = path.join(dir, '.flow-debugger', 'captures', 'log.ndjson');
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

console.log('collector.test.mjs');

await test('node: collects real pauses with real variables and layers findItem as N+1', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function findItem(id) { return { id }; }',
        'function getOrders(ids) { const out = []; for (const i of ids) out.push(findItem(i)); return out; }',
        "console.log(getOrders(['a','b','c']).length);",
    ].join('\n'));
    const res = await collect({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 1 }, { file: 'src/app.js', line: 2 }],
        totalMs: 15000,
    });
    assert.equal(res.pauses, 5, 'expected 1 hit at line 2 + 3 hits of findItem + 1 more (loop entry)');
    assert.ok(res.boundBreakpoints.every((b) => b.verified), 'both breakpoints should verify');
    const log = readLog(ws);
    const findItemHits = log.filter((r) => r.frame?.name === 'findItem');
    assert.equal(findItemHits.length, 3, 'findItem should be hit once per loop iteration');
    assert.equal(findItemHits[0].vars.find((v) => v.name === 'id')?.value, "'a'");
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('node: redacts a secret-shaped variable in captured output', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), [
        'function run() {',
        "    const token = 'abc123secretvalue';",
        '    return token;', // break here — token is assigned by this point
        '}',
        'run();',
    ].join('\n'));
    const res = await collect({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 3 }], totalMs: 15000,
    });
    assert.ok(res.pauses >= 1);
    const log = readLog(ws);
    const tokenVar = log.flatMap((r) => r.vars).find((v) => v.name === 'token');
    assert.ok(tokenVar, 'token variable should have been captured');
    assert.match(tokenVar.value, /redacted/i, 'a secret-named variable must be redacted');
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('node: breakpoint paths resolve against the workspace, not the CLI cwd', async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.js'), ['function f() { return 1; }', 'f();'].join('\n'));
    // cwd deliberately different from where this test file lives — this is
    // exactly the bug the Python driver had: paths resolved against the
    // wrong base and every breakpoint silently failed to bind.
    const res = await collect({
        language: 'node', program: 'src/app.js', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.js', line: 1 }], totalMs: 15000,
    });
    assert.equal(res.boundBreakpoints[0].verified, true);
    fs.rmSync(ws, { recursive: true, force: true });
});

const pyAvail = availableDrivers({ pythonPath: process.env.FLOW_PYTHON }).python;

await test('python: collects real pauses with real variables via debugpy', async () => {
    if (!pyAvail.ok) throw new Skip(pyAvail.reason);
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws, 'src', 'app.py'), [
        'def find_item(item_id):',
        '    return {"id": item_id}',
        '',
        'def get_orders(ids):',
        '    out = []',
        '    for i in ids:',
        '        out.append(find_item(i))',
        '    return out',
        '',
        'print(len(get_orders(["a", "b", "c"])))',
    ].join('\n'));
    const res = await collect({
        language: 'python', program: 'src/app.py', cwd: ws, workspace: ws,
        breakpoints: [{ file: 'src/app.py', line: 2 }, { file: 'src/app.py', line: 7 }],
        totalMs: 15000, pythonPath: process.env.FLOW_PYTHON,
    });
    assert.equal(res.pauses, 6);
    assert.ok(res.boundBreakpoints.every((b) => b.verified));
    const log = readLog(ws);
    const findItemHits = log.filter((r) => r.frame?.name === 'find_item');
    assert.equal(findItemHits.length, 3);
    assert.equal(findItemHits[0].vars.find((v) => v.name === 'item_id')?.value, "'a'");
    fs.rmSync(ws, { recursive: true, force: true });
});

await test('unsupported language throws a clear, actionable error', async () => {
    await assert.rejects(
        () => collect({ language: 'ruby', program: 'x.rb', cwd: '.', workspace: '.' }),
        /unsupported language "ruby"/,
    );
});

console.log(`\nRESULT: ${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} (${passed} passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
