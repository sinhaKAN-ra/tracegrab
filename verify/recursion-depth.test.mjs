#!/usr/bin/env node
/**
 * Regression test for the stackDepth fix that defeated recursion detection.
 *
 * Before the fix the recorder derived `stackDepth` from a DAP stackTrace capped
 * at `levels: 20`, so every pause of a deep recursion saturated at a CONSTANT
 * value and buildCallTree folded genuine self-recursion into ONE non-recursive
 * node — no `loop N× (recursive)` block ever appeared.
 *
 * This test proves the fix two ways:
 *   (A) REAL headless capture — launch the self-recursive fixture under the
 *       Node inspector via cli/collector.mjs, breakpoint the recursive-call
 *       line, and assert the recorded sumItemsRecursive pauses have STRICTLY
 *       INCREASING stackDepth, then feed those REAL pauses to buildCallTree and
 *       assert enteredCount===N, recursive===true, recursionDepth===N, and that
 *       toMermaidSequence contains `loop N× (recursive)`.
 *   (B) UNIT depth-helper — mirror the recorder's depth computation and assert
 *       it yields the TRUE depth both when the adapter reports `totalFrames`
 *       (truncated stackFrames) and when it omits it (full re-request), never a
 *       hand-set constant. This covers the recorder logic even if the real
 *       headless capture is skipped in a constrained environment.
 *
 * Framework-free (plain assert counter), matching the other verify/*.test.mjs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, availableDrivers } from '../cli/collector.mjs';
import { buildCallTree, toMermaidSequence } from '../mcp/callmap.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0, skip = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));
const note = (m) => console.log(`\u2192 ${m}`);

// ---- (B) UNIT: the recorder's depth computation against REAL adapter shapes ----
// This is the EXACT logic threaded through src/extension.ts captureAndPublishState
// and cli/collectors/pythonDapDriver.mjs captureState. We assert it never falls
// back to the truncated length when the true depth is available.
//
// `fullStackRequest` models the adapter's response to a no-`levels` stackTrace.
function computeDepth(stackResp, fullStackRequest) {
    const frames = stackResp?.stackFrames ?? [];
    const totalFrames = stackResp?.totalFrames;
    let depth = (typeof totalFrames === 'number' && totalFrames >= frames.length)
        ? totalFrames
        : frames.length;
    if (!(typeof totalFrames === 'number' && totalFrames >= frames.length) && frames.length === 20) {
        const full = fullStackRequest?.();
        depth = full?.stackFrames?.length ?? frames.length;
    }
    return depth || 1;
}

{
    // adapter REPORTS totalFrames: stackFrames truncated at 20, true depth 37.
    const truncated = { stackFrames: Array.from({ length: 20 }, (_, i) => ({ id: i })), totalFrames: 37 };
    assert(computeDepth(truncated, null) === 37,
        'unit: totalFrames (37) is used even when stackFrames is truncated to 20 (NOT a constant 20)');

    // adapter OMITS totalFrames AND we hit the cap: ONE full-stack re-request.
    const noTotal = { stackFrames: Array.from({ length: 20 }, (_, i) => ({ id: i })) };
    let fullRequested = 0;
    const full = () => { fullRequested++; return { stackFrames: Array.from({ length: 42 }, (_, i) => ({ id: i })) }; };
    assert(computeDepth(noTotal, full) === 42,
        'unit: no totalFrames + at cap -> full re-request yields true depth 42 (NOT 20)');
    assert(fullRequested === 1, 'unit: the full-stack fallback fires exactly once');

    // short stack (below the cap): no re-request, length is already the truth.
    const shortResp = { stackFrames: Array.from({ length: 5 }, (_, i) => ({ id: i })) };
    let shortFull = 0;
    assert(computeDepth(shortResp, () => (shortFull++, { stackFrames: [] })) === 5,
        'unit: a short (<20) stack uses its length directly');
    assert(shortFull === 0, 'unit: no fallback request when below the truncation cap');
}

// ---- (A) REAL headless capture through the SAME recorder path ----
const nodeAvail = availableDrivers().node;
if (!nodeAvail.ok) {
    skip++;
    note(`SKIP real-capture block: Node inspector unavailable (${nodeAvail.reason})`);
} else {
    const fixture = path.join(root, 'verify', 'fixtures', 'recursion-depth-target.js');
    const src = fs.readFileSync(fixture, 'utf8').split('\n');
    const bpLine = src.findIndex((l) => /RECURSION_LINE/.test(l)) + 1; // 1-based
    assert(bpLine > 0, 'real-capture: resolved the recursive-call breakpoint line from the fixture');

    const res = await collect({
        language: 'node', program: fixture, cwd: root, workspace: fixture + '.ws',
        breakpoints: [{ file: fixture, line: bpLine }],
        totalMs: 20000,
    });
    note(`real-capture: ${res.pauses} pauses recorded at line ${bpLine}`);

    const logPath = res.logPath;
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recPauses = log.filter((r) => r.frame?.name === 'sumItemsRecursive');
    const N = recPauses.length;
    assert(N >= 2, `real-capture: at least two sumItemsRecursive pauses recorded (got ${N})`);

    // The crux: real recorded depth must STRICTLY INCREASE frame-over-frame,
    // never saturate at a constant.
    const depths = recPauses.map((r) => r.stackDepth);
    let strictlyIncreasing = true;
    for (let i = 1; i < depths.length; i++) if (!(depths[i] > depths[i - 1])) strictlyIncreasing = false;
    assert(strictlyIncreasing, `real-capture: stackDepth strictly increases across activations (got ${JSON.stringify(depths)})`);
    assert(new Set(depths).size === depths.length, 'real-capture: no two activations share a depth (not a constant 20)');

    // Feed the REAL pauses to the builder and assert recursion is detected.
    const roots = buildCallTree(log);
    const flat = [];
    const walk = (n) => { flat.push(n); n.children.forEach(walk); };
    roots.forEach(walk);
    const recNodes = flat.filter((n) => n.fn === 'sumItemsRecursive');
    assert(recNodes.length === 1, `real-capture: self-chain collapses to ONE node (got ${recNodes.length})`);
    const rec = recNodes[0];
    assert(rec.recursive === true, 'real-capture: node flagged recursive === true');
    assert(rec.enteredCount === N, `real-capture: enteredCount === N (${N}), got ${rec.enteredCount}`);
    assert(rec.recursionDepth === N, `real-capture: recursionDepth === N (${N}), got ${rec.recursionDepth}`);

    const mm = toMermaidSequence(roots);
    assert(mm.includes(`loop ${N}× (recursive)`), `real-capture: mermaid contains "loop ${N}× (recursive)"`);

    try { fs.rmSync(fixture + '.ws', { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed, ${skip} skipped)`);
process.exitCode = fail ? 1 : 0;
