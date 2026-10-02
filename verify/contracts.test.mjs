/**
 * Tests for C2 runtime behavior contracts. Run: node verify/contracts.test.mjs
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-'));
execSync(
    `npx --yes tsc "${path.join(root, 'src', 'flowTrace.ts')}" "${path.join(root, 'src', 'contracts.ts')}" ` +
    `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
    { stdio: 'pipe' }
);
const ft = await import(path.join(outDir, 'flowTrace.js'));
const ct = await import(path.join(outDir, 'contracts.js'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));
const hasRule = (r, rule) => r.violations.some((v) => v.rule === rule);

function mk(o = {}) {
  const db = { fn: 'findItem', source: 'items.repo.ts', layer: 'db', depth: 2, dbCalls: 0,
    enteredCount: o.n1 ? 5 : 1, n1: !!o.n1, error: o.dbError, firstOrder: 3, lastOrder: 4,
    steps: [{ order: 3, line: 8, hit: 1, vars: [] }], children: [] };
  const svc = { fn: 'validateLevel', source: 'a.svc.ts', layer: 'service', depth: 1,
    dbCalls: o.dbCalls ?? 1, enteredCount: 1, firstOrder: 2, lastOrder: 5,
    steps: [{ order: 2, line: 15, hit: 1, vars: [], mutations: o.mutations ?? [] }],
    children: o.dropDb ? [] : [db] };
  const ctrl = { fn: 'allocateTask', source: 'a.ctrl.ts', layer: 'controller', depth: 0,
    dbCalls: 0, enteredCount: 1, firstOrder: 1, lastOrder: 6,
    steps: [{ order: 1, line: 20, hit: 1, vars: [] }],
    children: o.dropSvc ? [] : [svc] };
  return ft.buildFlowTrace({
    scenario: { name: 'allocate', dbMode: o.dbMode ?? 'real' },
    roots: [ctrl],
    diagnosis: { verdict: 'LOOKS OK', findings: [] },
    calls: [{ request: { method: 'PUT', url: '/allocate' }, response: { status: o.status ?? 400 }, pauseCount: 3 }],
    heapSeries: o.heapSeries,
    mockInjection: o.mockInjection,
  });
}

// ---- generate ----
const good = mk({ mutations: [{ name: 'requestID', from: 'r1', to: 'r2' }] });
const contract = ct.createContract(good, { scenario: 'allocate-invalid-user' });
assert(contract.scenario === 'allocate-invalid-user', 'contract takes the given scenario name');
assert(contract.assert.noUncaughtExceptions === true, 'generated contract forbids exceptions');
assert(contract.assert['response.status'] === 400, 'generated contract pins the observed status');
assert(contract.assert.mustCall.some((r) => r.includes('allocateTask')), 'generated contract requires the controller');
assert(contract.assert.maxTotalDbCalls === good.stats.dbCallTotal, 'generated contract caps total DB calls');
assert(contract.assert.neverClear.includes('requestID'), 'a non-cleared variable becomes a neverClear rule');

// ---- verify: the trace it came from must pass ----
{
  const r = ct.verifyContract(contract, good);
  assert(r.pass === true, 'contract passes against the trace it was generated from');
  assert(r.checked > 0 && r.satisfied.length > 0, 'result reports what was checked/satisfied');
  assert(ct.explainResult(r).startsWith('✅'), 'explainResult renders a pass');
}

// ---- violations ----
{
  const r = ct.verifyContract(contract, mk({ status: 500, mutations: [{ name: 'requestID', from: 'r1', to: 'r2' }] }));
  assert(hasRule(r, 'response.status') && !r.pass, 'wrong status violates the contract');
}
{
  const r = ct.verifyContract(contract, mk({ dbError: { message: 'timeout', type: 'DBTimeout' }, mutations: [{ name: 'requestID', from: 'r1', to: 'r2' }] }));
  assert(hasRule(r, 'noUncaughtExceptions'), 'a thrown exception violates noUncaughtExceptions');
  const ex = ct.explainResult(r);
  assert(ex.startsWith('❌') && ex.includes('DBTimeout'), 'explainResult names the actual exception');
}
{
  const r = ct.verifyContract(contract, mk({ dropSvc: true, mutations: [{ name: 'requestID', from: 'r1', to: 'r2' }] }));
  assert(hasRule(r, 'mustCall'), 'a method no longer called violates mustCall');
}
{
  const c2 = { scenario: 's', assert: { mustNotCall: ['findItem'] } };
  assert(hasRule(ct.verifyContract(c2, mk()), 'mustNotCall'), 'mustNotCall catches a forbidden method');
  assert(ct.verifyContract(c2, mk({ dropDb: true })).pass, 'mustNotCall passes when absent');
}
{
  const c3 = { scenario: 's', assert: { maxCalls: { 'findItem': 1 } } };
  assert(hasRule(ct.verifyContract(c3, mk({ n1: true })), 'maxCalls'), 'maxCalls catches an N+1 (5 > 1)');
}
{
  const c4 = { scenario: 's', assert: { neverClear: ['token'] } };
  const r = ct.verifyContract(c4, mk({ mutations: [{ name: 'token', from: 'abc', to: "''" }] }));
  assert(hasRule(r, 'neverClear'), 'neverClear catches a cleared value');
}
{
  const c5 = { scenario: 's', assert: { allowedTransitions: { 'userLevel': [1, 2, 3] } } };
  assert(hasRule(ct.verifyContract(c5, mk({ mutations: [{ name: 'userLevel', from: '1', to: '9' }] })), 'allowedTransitions'),
    'allowedTransitions catches a disallowed value');
  assert(ct.verifyContract(c5, mk({ mutations: [{ name: 'userLevel', from: '1', to: '2' }] })).pass,
    'allowedTransitions passes an allowed value');
}
{
  const c6 = { scenario: 's', assert: { mocksMustInject: true } };
  assert(hasRule(ct.verifyContract(c6, mk({ dbMode: 'mocked' })), 'mocksMustInject'), 'mocksMustInject fails when no mocks declared');
  const failed = { results: [{ match: 'db.get', status: 'unsupported' }] };
  assert(hasRule(ct.verifyContract(c6, mk({ dbMode: 'mocked', mockInjection: failed })), 'mocksMustInject'),
    'mocksMustInject fails when a mock did not inject');
  const okInj = { results: [{ match: 'db.get', status: 'ok' }] };
  assert(ct.verifyContract(c6, mk({ dbMode: 'mocked', mockInjection: okInj })).pass, 'mocksMustInject passes when all injected');
}
{
  const c7 = { scenario: 's', assert: { memoryMustReclaim: true } };
  const grew = mk({ heapSeries: [{ order: 1, heapUsed: 100 }, { order: 2, heapUsed: 300 }] });
  assert(hasRule(ct.verifyContract(c7, grew), 'memoryMustReclaim'), 'memoryMustReclaim fails when heap only grows');
}
{
  const c8 = { scenario: 's', assert: { maxTotalDbCalls: 1 } };
  assert(hasRule(ct.verifyContract(c8, mk({ dbCalls: 9 })), 'maxTotalDbCalls'), 'maxTotalDbCalls catches DB fan-out');
}

// ---- YAML round-trip (hand-rolled parser — the risky part) ----
{
  const yaml = ct.contractToYaml(contract);
  assert(yaml.includes('scenario: allocate-invalid-user'), 'yaml has the scenario');
  assert(yaml.includes('noUncaughtExceptions: true'), 'yaml has a scalar rule');
  assert(yaml.includes('mustCall:') && yaml.includes('    - '), 'yaml has a list rule');
  const back = ct.parseContract(yaml);
  assert(back.scenario === contract.scenario, 'round-trip keeps the scenario');
  assert(back.assert.noUncaughtExceptions === true, 'round-trip keeps booleans as booleans');
  assert(back.assert['response.status'] === 400, 'round-trip keeps numbers as numbers');
  assert(Array.isArray(back.assert.mustCall) && back.assert.mustCall.length === contract.assert.mustCall.length,
    'round-trip keeps the list length');
  // and it must still verify identically
  const r1 = ct.verifyContract(contract, good), r2 = ct.verifyContract(back, good);
  assert(r1.pass === r2.pass && r1.checked === r2.checked, 'parsed contract verifies identically to the original');
}
{
  const withMaps = { scenario: 's', assert: { maxCalls: { 'a.svc.ts#get': 2 }, allowedTransitions: { 'lvl': [1, 2] } } };
  const back = ct.parseContract(ct.contractToYaml(withMaps));
  assert(back.assert.maxCalls['a.svc.ts#get'] === 2, 'round-trip keeps a maxCalls map entry');
  assert(Array.isArray(back.assert.allowedTransitions.lvl) && back.assert.allowedTransitions.lvl[1] === 2,
    'round-trip keeps allowedTransitions arrays as numbers');
}
{
  const back = ct.parseContract(JSON.stringify(contract));
  assert(back.scenario === contract.scenario, 'JSON contracts are accepted too');
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
