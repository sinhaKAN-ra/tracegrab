/**
 * Tests for C1 behavioral diff. Run: node verify/behavioral-diff.test.mjs
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdiff-'));
execSync(
    `npx --yes tsc "${path.join(root, 'src', 'flowTrace.ts')}" "${path.join(root, 'src', 'behavioralDiff.ts')}" ` +
    `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
    { stdio: 'pipe' }
);
const ft = await import(path.join(outDir, 'flowTrace.js'));
const bd = await import(path.join(outDir, 'behavioralDiff.js'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));
const has = (d, kind) => d.entries.some((e) => e.kind === kind);

/** Build a trace from a compact spec. */
function mk(opts = {}) {
  const db = { fn: 'findItem', source: 'items.repo.ts', layer: 'db', depth: 2, dbCalls: 0,
    enteredCount: opts.n1 ? 3 : 1, n1: !!opts.n1, error: opts.dbError, firstOrder: 3, lastOrder: 4,
    steps: [{ order: 3, line: 8, hit: 1, vars: [], heapUsed: opts.heap?.[1] }], children: [] };
  const svc = { fn: 'getOrders', source: 'o.svc.ts', layer: 'service', depth: 1,
    dbCalls: opts.dbCalls ?? 1, enteredCount: 1, firstOrder: 2, lastOrder: 5,
    steps: [{ order: 2, line: 15, hit: 1, vars: [], mutations: opts.mutations ?? [], heapUsed: opts.heap?.[0] }],
    children: opts.dropDb ? [] : [db] };
  const ctrl = { fn: 'getDashboard', source: 'd.ctrl.ts', layer: 'controller', depth: 0,
    dbCalls: 0, enteredCount: 1, firstOrder: 1, lastOrder: 6,
    steps: [{ order: 1, line: 20, hit: 1, vars: [], heapUsed: opts.heap?.[0] }],
    children: [svc, ...(opts.extraMethod ? [{ fn: 'audit', source: 'a.svc.ts', layer: 'service', depth: 1,
      dbCalls: 0, enteredCount: 1, firstOrder: 7, lastOrder: 7, steps: [], children: [] }] : [])] };
  return ft.buildFlowTrace({
    scenario: { name: 't', dbMode: 'real' },
    roots: [ctrl],
    diagnosis: { verdict: opts.verdict ?? 'LOOKS OK', findings: [] },
    calls: [{ request: { method: 'GET', url: '/x' },
              response: { status: opts.status ?? 200, bodyShape: opts.shape }, pauseCount: 3 }],
    heapSeries: opts.heapSeries,
    git: { sha: opts.sha ?? 'aaa' },
  });
}

// ---- noise normalization ----
assert(bd.normalizeValue('id=550e8400-e29b-41d4-a716-446655440000') === 'id=<uuid>', 'uuid normalized');
assert(bd.normalizeValue('at 2026-01-01T10:00:00.000Z') === 'at <timestamp>', 'timestamp normalized');
assert(bd.isNoiseOnlyChange("'abc-550e8400-e29b-41d4-a716-446655440000'", "'abc-660e8400-e29b-41d4-a716-446655440111'"),
  'two different uuids = noise only');
assert(!bd.isNoiseOnlyChange("'VERIFIED'", "'REJECTED'"), 'real value change is NOT noise');

// ---- identical traces ----
{
  const d = bd.diffTraces(mk(), mk());
  assert(d.outcome === 'EQUIVALENT', 'identical traces → EQUIVALENT');
  assert(d.entries.length === 0, 'no entries for identical traces');
}

// ---- new N+1 is a regression ----
{
  const d = bd.diffTraces(mk(), mk({ n1: true }));
  assert(d.outcome === 'REGRESSION', 'new N+1 → REGRESSION');
  assert(has(d, 'new-n-plus-one'), 'new-n-plus-one entry present');
}

// ---- DB call count increase ----
{
  const d = bd.diffTraces(mk({ dbCalls: 1 }), mk({ dbCalls: 14 }));
  assert(has(d, 'db-calls-changed'), 'db-calls-changed detected');
  assert(d.entries.find((e) => e.kind === 'db-calls-changed').severity === 'regression', 'more DB calls = regression');
}
{
  const d = bd.diffTraces(mk({ dbCalls: 14 }), mk({ dbCalls: 1 }));
  assert(d.entries.find((e) => e.kind === 'db-calls-changed').severity === 'info', 'fewer DB calls = info, not regression');
}

// ---- new exception / resolved exception ----
{
  const d = bd.diffTraces(mk(), mk({ dbError: { message: 'timeout', type: 'DBTimeout' } }));
  assert(has(d, 'new-exception') && d.outcome === 'REGRESSION', 'new exception → REGRESSION');
}
{
  const d = bd.diffTraces(mk({ dbError: { message: 'timeout', type: 'DBTimeout' } }), mk());
  assert(has(d, 'exception-resolved'), 'resolved exception reported as info');
  assert(d.outcome !== 'REGRESSION', 'fixing an exception is not a regression');
}

// ---- call path changes ----
{
  const d = bd.diffTraces(mk(), mk({ extraMethod: true }));
  assert(has(d, 'method-added'), 'method-added detected');
}
{
  const d = bd.diffTraces(mk(), mk({ dropDb: true }));
  assert(has(d, 'method-removed'), 'method-removed detected');
}

// ---- state newly cleared ----
{
  const d = bd.diffTraces(mk(), mk({ mutations: [{ name: 'token', from: 'abc', to: "''" }] }));
  assert(has(d, 'state-cleared') && d.outcome === 'REGRESSION', 'newly-cleared state → REGRESSION');
}

// ---- mutation that differs only by noise is ignored ----
{
  const a = mk({ mutations: [{ name: 'id', from: 'x', to: '550e8400-e29b-41d4-a716-446655440000' }] });
  const b = mk({ mutations: [{ name: 'id', from: 'x', to: '660e8400-e29b-41d4-a716-446655440111' }] });
  const d = bd.diffTraces(a, b);
  assert(!has(d, 'mutation-changed'), 'uuid-only mutation difference ignored');
  assert(d.normalized.length > 0, 'ignored noise is reported for transparency');
}

// ---- response status + schema ----
{
  const d = bd.diffTraces(mk({ status: 200 }), mk({ status: 500 }));
  assert(has(d, 'response-status') && d.outcome === 'REGRESSION', '200→500 is a regression');
}
{
  const a = mk({ shape: { id: 'string', applicant: { id: 'string', name: 'string' } } });
  const b = mk({ shape: { id: 'string', applicant: { name: 'string' } } });
  const d = bd.diffTraces(a, b);
  const rm = d.entries.find((e) => e.kind === 'response-schema');
  assert(rm && /applicant\.id/.test(rm.title), 'removed response field detected by path');
  assert(rm.severity === 'regression', 'removing a response field is a regression');
}

// ---- memory behaviour ----
{
  const a = mk({ heapSeries: [{ order: 1, heapUsed: 100 }, { order: 2, heapUsed: 90 }] });   // shrank, reclaimed
  const b = mk({ heapSeries: [{ order: 1, heapUsed: 100 }, { order: 2, heapUsed: 300 }] });  // grew, no reclaim
  const d = bd.diffTraces(a, b);
  assert(has(d, 'memory-behaviour'), 'memory behaviour change detected');
}

// ---- verdict move ----
{
  const d = bd.diffTraces(mk({ verdict: 'LOOKS OK' }), mk({ verdict: 'FAILING — boom' }));
  assert(has(d, 'verdict') && d.outcome === 'REGRESSION', 'verdict LOOKS OK → FAILING is a regression');
}
{
  const d = bd.diffTraces(mk({ verdict: 'FAILING — boom' }), mk({ verdict: 'LOOKS OK' }));
  assert(d.outcome !== 'REGRESSION', 'verdict FAILING → LOOKS OK is not a regression (proves a fix)');
}

// ---- markdown ----
{
  const d = bd.diffTraces(mk(), mk({ n1: true, status: 500 }));
  const md = bd.diffMarkdown(d);
  assert(md.includes('## Behavioral diff — REGRESSION'), 'markdown headline shows outcome');
  assert(md.includes('🔴'), 'markdown marks regressions');
  assert(md.includes('Baseline') && md.includes('Candidate'), 'markdown has the comparison table');
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
