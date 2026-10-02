#!/usr/bin/env node
/** Tests for the Phase 2 live outcome engine (framework-free). */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-outcome-'));
execSync(
  `npx --yes tsc "${path.join(root, 'webview-ui', 'src', 'callTree.ts')}" "${path.join(root, 'webview-ui', 'src', 'outcome.ts')}" ` +
  `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
  { stdio: 'pipe' },
);
const { deriveOutcome } = await import(path.join(outDir, 'outcome.js'));
let pass = 0, fail = 0;
const assert = (condition, message) => condition
  ? (pass++, console.log(`✓ ${message}`))
  : (fail++, console.error(`✗ FAIL: ${message}`));

const step = (order, line, extras = {}) => ({ order, line, hit: 1, vars: [], ...extras });
const node = (patch = {}) => ({
  id: 'svc@orders.svc.ts', fn: 'getOrders', source: 'orders.svc.ts', layer: 'service', depth: 0,
  steps: [step(1, 10)], children: [], dbCalls: 0, enteredCount: 1, firstOrder: 1, lastOrder: 1,
  ...patch,
});

const empty = deriveOutcome([], []);
assert(empty.verdict === 'NO EVIDENCE' && empty.tone === 'neutral', 'empty trace reports NO EVIDENCE');
assert(empty.findings.length === 0, 'empty trace invents no findings');

const clean = deriveOutcome([node()], [{ order: 1, heapUsed: 100 }, { order: 2, heapUsed: 90 }]);
assert(clean.verdict === 'LOOKS OK' && clean.memory === 'reclaimed', 'clean trace reports LOOKS OK and reclaimed memory');

const broken = deriveOutcome([node({
  dbCalls: 3,
  children: [node({
    id: 'db@items.repo.ts', fn: 'findItem', source: 'items.repo.ts', layer: 'db', depth: 1,
    n1: true, enteredCount: 3, firstOrder: 2, lastOrder: 4, dbCalls: 0,
    error: { type: 'DBTimeout', message: 'query timed out' },
    steps: [step(2, 8, { error: { type: 'DBTimeout', message: 'query timed out' } })], children: [],
  })],
  steps: [step(1, 10), step(5, 15, { mutations: [{ name: 'token', from: "'abc'", to: "''" }] })],
})], [{ order: 1, heapUsed: 100 }, { order: 2, heapUsed: 120 }, { order: 3, heapUsed: 140 }]);

assert(broken.verdict === 'FAILING' && broken.tone === 'bad', 'exception makes the live outcome FAILING');
assert(broken.exceptions === 1, 'exception count is derived without duplicate rollups');
assert(broken.n1 === 1, 'N+1 count is derived');
assert(broken.dbCalls === 3, 'DB-call count is derived across the tree');
assert(broken.memory === 'not reclaimed', 'monotonic growth reports not reclaimed');
assert(broken.findings.some((finding) => finding.title.includes('DBTimeout')), 'exception finding names its type');
assert(broken.findings.some((finding) => finding.id.startsWith('n1:')), 'N+1 finding is present');
assert(broken.findings.some((finding) => finding.id.startsWith('clear:')), 'newly-cleared state finding is present');
assert(broken.findings.some((finding) => finding.id === 'memory:not-reclaimed'), 'memory retention finding is present');
assert(broken.findings[0].severity === 'critical', 'findings are severity-ranked');
assert(broken.findings.find((finding) => finding.id.startsWith('clear:'))?.pauseOrder === 5, 'finding links to the exact pause order');

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
