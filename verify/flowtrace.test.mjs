/**
 * Tests for FlowTrace v1 (C0) and report generation (C7).
 * Run: node verify/flowtrace.test.mjs
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtrace-'));
execSync(
    `npx --yes tsc "${path.join(root, 'src', 'flowTrace.ts')}" "${path.join(root, 'src', 'report.ts')}" ` +
    `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
    { stdio: 'pipe' }
);
const ft = await import(path.join(outDir, 'flowTrace.js'));
const rep = await import(path.join(outDir, 'report.js'));
const mirror = await import(path.join(root, 'mcp', 'callmap.mjs'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));

// A small realistic tree: controller → service → db, with a mutation, N+1 and an error.
const roots = [{
  fn: 'getDashboard', source: 'd.ctrl.ts', layer: 'controller', depth: 0,
  dataIn: 'userId=U7', dbCalls: 0, enteredCount: 1, firstOrder: 1, lastOrder: 8,
  steps: [{ order: 1, line: 20, hit: 1, vars: [{ name: 'userId', value: "'U7'" }], heapUsed: 1000000 }],
  children: [{
    fn: 'getOrders', source: 'o.svc.ts', layer: 'service', depth: 1,
    dataIn: 'ids=[o1,o2]', dataOut: 'rows=Array(2)', dbCalls: 3, enteredCount: 1, firstOrder: 2, lastOrder: 7,
    heapDelta: 500000,
    steps: [{ order: 2, line: 15, hit: 2, vars: [{ name: 'token', value: "''" }],
              mutations: [{ name: 'token', from: 'abc', to: "''" }], heapUsed: 1500000 }],
    children: [{
      fn: 'findItem', source: 'items.repo.ts', layer: 'db', depth: 2,
      dataIn: 'id=o1', dbCalls: 0, enteredCount: 3, n1: true, firstOrder: 3, lastOrder: 6,
      error: { message: 'timeout querying items', type: 'DBTimeout' },
      steps: [{ order: 3, line: 8, hit: 1, vars: [{ name: 'id', value: "'o1'" }], heapUsed: 2000000,
                error: { message: 'timeout querying items', type: 'DBTimeout' } }],
      children: [],
    }],
  }],
}];

const trace = ft.buildFlowTrace({
  scenario: { name: 'dashboard flow', dbMode: 'mocked', strictMocks: true },
  roots,
  diagnosis: { verdict: 'FAILING — an exception was thrown on this path.', findings: [
    { severity: 'critical', kind: 'exception', title: 'DBTimeout thrown in findItem', detail: 'timeout querying items', where: 'items.repo.ts:8', suggestion: 'Trace the inputs on this hop.' },
    { severity: 'high', kind: 'n+1', title: 'N+1 query: findItem called 3x in a loop', where: 'items.repo.ts' },
  ] },
  calls: [{ request: { method: 'GET', url: 'http://127.0.0.1:8004/dashboard/U7' }, response: { status: 500, ok: false, durationMs: 42 }, pauseCount: 3 }],
  heapSeries: [{ order: 1, heapUsed: 1000000 }, { order: 2, heapUsed: 1500000 }, { order: 3, heapUsed: 2000000 }],
  git: { sha: 'abc123', branch: 'feature/x', dirty: false },
  runtime: { adapter: 'pwa-node', language: 'node' },
  mockInjection: { results: [{ match: 'db.findItem', status: 'unsupported', message: 'cannot resolve' }] },
  audit: [{ at: '2026-01-01T00:00:00Z', actor: 'agent', action: 'setVariable', target: 'userLevel', before: '5', after: '0' }],
});

// ---- FlowTrace ----
assert(trace.schemaVersion === ft.FLOWTRACE_SCHEMA_VERSION, 'trace carries the schema version');
assert(ft.isSupportedTrace(trace) === true, 'trace is readable by this version');
assert(ft.isSupportedTrace({ schemaVersion: 99 }) === false, 'future schema rejected');
assert(/^ft_/.test(trace.id), 'trace gets a generated id');
assert(trace.stats.methodCount === 3, 'method count counts the whole tree');
assert(trace.stats.dbCallTotal === 3, 'db calls totalled across the tree');
assert(trace.stats.pauseCount === 3, 'pause count sums steps');
assert(trace.methods[0].id === ft.methodId('getDashboard', 'd.ctrl.ts'), 'deterministic method id');
assert(trace.mutations.length === 1 && trace.mutations[0].name === 'token' && trace.mutations[0].line === 15,
  'mutations collected with their line');
assert(trace.memory.peak === 2000000 && trace.memory.netDelta === 1000000 && trace.memory.reclaimed === false,
  'memory peak/net/reclaimed derived');
assert(trace.redaction.on === true, 'redaction flagged on by default');
assert(trace.findings.length === 2 && trace.verdict.startsWith('FAILING'), 'diagnosis carried into the trace');
// round-trip
{
  const json = JSON.stringify(trace);
  const back = JSON.parse(json);
  assert(back.methods[0].children[0].children[0].n1 === true, 'trace survives JSON round-trip with nesting');
}

// ---- Report: markdown ----
const md = rep.reportMarkdown(trace);
assert(md.startsWith('# Test report — dashboard flow'), 'markdown has a titled header');
assert(md.includes('**Verdict:** FAILING'), 'markdown shows the verdict');
assert(md.includes('DBTimeout thrown in findItem'), 'markdown lists the critical finding');
assert(md.includes('N+1 query'), 'markdown lists the N+1 finding');
assert(md.includes('CONTROLLER getDashboard'), 'markdown renders the call map');
assert(md.includes('`token`') && md.includes('| abc |'), 'markdown includes the mutation table');
assert(md.includes('Peak heap') && md.includes('1.9 MB'), 'markdown includes memory stats (binary MB)');
assert(md.includes('Mock injection') && md.includes('unsupported'), 'markdown includes mock-injection status');
assert(md.includes('Live edits made during this run') && md.includes('setVariable'), 'markdown includes the audit trail');
assert(md.includes('```mermaid'), 'markdown embeds a mermaid diagram');
assert(md.includes('GET') && md.includes('/dashboard/U7'), 'markdown includes the request table');

// ---- Report: html ----
const html = rep.reportHtml(trace);
assert(html.startsWith('<!doctype html>'), 'html is a full document');
assert(html.includes('Test report — dashboard flow'), 'html has the title');
assert(html.includes('FAILING'), 'html shows the verdict');
assert(!/<script/i.test(html), 'html contains no scripts (safe to share)');
assert(html.includes('items.repo.ts'), 'html renders the call map sources');
const mirrorHtml = mirror.reportHtml(trace);
assert(mirrorHtml.startsWith('<!doctype html>') && mirrorHtml.includes('dashboard flow'), 'MCP mirror renders the HTML document used by the host');
assert(!/<script/i.test(mirrorHtml), 'MCP mirror HTML is script-free');

// ---- mermaid ----
const mm = rep.traceToMermaid(trace);
assert(mm.startsWith('sequenceDiagram'), 'mermaid starts correctly');
assert(mm.includes('->>') && mm.includes('-->>'), 'mermaid has call + return arrows');
assert(/Note over .*N\+1 x3/.test(mm), 'mermaid notes the N+1');

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
