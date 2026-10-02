/**
 * Tests for the async-resilient call-tree builder.
 * Run: node verify/call-tree.test.mjs   (compiles webview-ui/src/callTree.ts first)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'webview-ui', 'src', 'callTree.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calltree-'));
execSync(
    `npx --yes tsc "${src}" --outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
    { stdio: 'pipe' }
);
const { buildCallTree, inferLayer, diffVars, toMermaidSequence } = await import(path.join(outDir, 'callTree.js'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));

const F = (name, source, line) => ({ name, source, line });
const P = (order, frame, stackDepth, vars = [], extra = {}) => ({ order, frame, stackDepth, vars, ...extra });

// ---- layer inference ----
assert(inferLayer('getDocuments', 'x.controller.ts') === 'controller', 'controller layer inferred');
assert(inferLayer('getApplicantDocuments', 'x.service.ts') === 'service', 'service layer inferred');
assert(inferLayer('fetchIndexedRecords', 'DynamoUtils.ts') === 'db', 'db layer inferred');

// ---- 1. linear controller -> service -> db -> return ----
{
  const roots = buildCallTree([
    P(1, F('getDocuments', 'ctrl.ts', 250), 1, [{ name: 'userId', value: 'U7' }]),
    P(2, F('getApplicantDocuments', 'svc.ts', 88), 2, [{ name: 'filter', value: '{a:1}' }]),
    P(3, F('fetchIndexedRecords', 'DynamoUtils.ts', 120), 3, [{ name: 'key', value: 'A1' }]),
    P(4, F('getApplicantDocuments', 'svc.ts', 95), 2, [{ name: 'rows', value: 'Array(3)' }]), // returned to service
    P(5, F('getDocuments', 'ctrl.ts', 266), 1, [{ name: 'result', value: 'DFGResponse' }]),   // returned to controller
  ]);
  assert(roots.length === 1, 'single root (controller)');
  const ctrl = roots[0];
  assert(ctrl.fn === 'getDocuments' && ctrl.layer === 'controller', 'root is controller');
  assert(ctrl.children.length === 1 && ctrl.children[0].fn === 'getApplicantDocuments', 'controller -> service child');
  const svc = ctrl.children[0];
  assert(svc.children.length === 1 && svc.children[0].layer === 'db', 'service -> db child');
  assert(svc.children[0].dataIn === 'key=A1', 'db node dataIn inferred from entry locals');
  assert(ctrl.steps.some((s) => s.line === 266), 'controller has the post-return line step');
}

// ---- 2. async gap: stack depth jumps (truncated), tree still correct via key/return ----
{
  const roots = buildCallTree([
    P(1, F('handler', 'h.ts', 10), 1, []),
    P(2, F('svcA', 'a.svc.ts', 5), 2, [], { asyncGap: true }),
    // async gap makes stack look shallow (1) but it's still inside svcA line 7 -> same method
    P(3, F('svcA', 'a.svc.ts', 7), 1, [{ name: 'x', value: '1' }], { asyncGap: true }),
    P(4, F('handler', 'h.ts', 14), 1, []), // back in handler
  ]);
  const h = roots[0];
  assert(h.fn === 'handler' && h.children.length === 1, 'async: handler has one child svcA despite depth jump');
  assert(h.children[0].steps.length === 2, 'async: both svcA line-steps grouped into the one svcA node');
  assert(h.children[0].asyncBoundary === true, 'async boundary flagged on the node');
}

// ---- 3. fan-out: controller -> 2 services, second has 2 db calls ----
{
  const roots = buildCallTree([
    P(1, F('getDashboard', 'd.ctrl.ts', 20), 1, [{ name: 'userId', value: 'U7' }]),
    P(2, F('getProfile', 'p.svc.ts', 9), 2, []),
    P(3, F('findUser', 'users.repo.ts', 14), 3, []),
    P(4, F('getProfile', 'p.svc.ts', 12), 2, []),      // return to getProfile
    P(5, F('getDashboard', 'd.ctrl.ts', 28), 1, []),   // return to controller
    P(6, F('getOrders', 'o.svc.ts', 11), 2, []),       // second service (sibling)
    P(7, F('findOrders', 'orders.repo.ts', 8), 3, []),
    P(8, F('getOrders', 'o.svc.ts', 15), 2, []),
    P(9, F('findItems', 'items.repo.ts', 8), 3, []),
    P(10, F('getOrders', 'o.svc.ts', 19), 2, []),
    P(11, F('getDashboard', 'd.ctrl.ts', 34), 1, []),
  ]);
  const ctrl = roots[0];
  assert(ctrl.children.length === 2, 'fan-out: controller has 2 service children (branch)');
  assert(ctrl.children[0].fn === 'getProfile' && ctrl.children[1].fn === 'getOrders', 'fan-out: both services in call order');
  assert(ctrl.children[1].children.length === 2, 'fan-out: getOrders has 2 db children');
  assert(ctrl.children[1].dbCalls === 2, 'fan-out: getOrders dbCalls counted = 2');
}

// ---- 4. N+1: a loop in service calls a db method repeatedly ----
{
  const seq = [P(1, F('svc', 's.svc.ts', 30), 1, [])];
  let o = 2;
  for (let i = 0; i < 4; i++) {
    seq.push(P(o++, F('svc', 's.svc.ts', 32), 1, [{ name: 'i', value: String(i) }])); // loop line
    seq.push(P(o++, F('findOne', 'x.repo.ts', 5), 2, [{ name: 'id', value: `r${i}` }])); // db call in loop
    seq.push(P(o++, F('svc', 's.svc.ts', 33), 1, [])); // return to svc
  }
  const roots = buildCallTree(seq);
  const svc = roots[0];
  const dbChild = svc.children.find((c) => c.fn === 'findOne');
  assert(!!dbChild, 'N+1: db child present');
  assert(dbChild.n1 === true, 'N+1: db child flagged as N+1 (entered 4x in a loop)');
  assert(dbChild.enteredCount >= 3, 'N+1: entered count tracked');
  const loopStep = svc.steps.find((s) => s.line === 32);
  assert(loopStep && loopStep.hit === 4, 'N+1: loop line step hit 4x');
}

// ---- 5. mutation diff: a var changing between steps in the same method ----
{
  assert(diffVars([{ name: 'status', value: 'VALIDATED' }], [{ name: 'status', value: 'VERIFIED' }]).length === 1,
    'diffVars detects a changed value');
  assert(diffVars([{ name: 'status', value: 'X' }], [{ name: 'status', value: 'X' }]).length === 0,
    'diffVars ignores unchanged value');
  const roots = buildCallTree([
    P(1, F('resolve', 'r.svc.ts', 10), 1, [{ name: 'status', value: 'VALIDATED' }]),
    P(2, F('resolve', 'r.svc.ts', 14), 1, [{ name: 'status', value: 'VERIFIED' }]),
  ]);
  const step = roots[0].steps.find((s) => s.line === 14);
  assert(step.mutations && step.mutations[0].from === 'VALIDATED' && step.mutations[0].to === 'VERIFIED',
    'mutation captured on the step: status VALIDATED -> VERIFIED');
}

// ---- 6. error/throw flagged on the node + step ----
{
  const roots = buildCallTree([
    P(1, F('handler', 'h.ts', 10), 1, []),
    P(2, F('risky', 'r.svc.ts', 5), 2, [], { exception: { message: 'boom', type: 'TypeError' } }),
  ]);
  const risky = roots[0].children[0];
  assert(risky.error && risky.error.type === 'TypeError', 'error rolled up to the method node');
  assert(risky.steps[0].error && risky.steps[0].error.message === 'boom', 'error flagged on the step');
}

// ---- 7. heap delta across a method ----
{
  const roots = buildCallTree([
    P(1, F('load', 'l.svc.ts', 3), 1, [], { heapUsed: 1_000_000 }),
    P(2, F('load', 'l.svc.ts', 9), 1, [], { heapUsed: 1_500_000 }),
  ]);
  assert(roots[0].heapDelta === 500_000, 'heap delta computed (last - first) = +500KB');
}

// ---- 8. mermaid sequence export ----
{
  const roots = buildCallTree([
    P(1, F('getDashboard', 'd.ctrl.ts', 20), 1, [{ name: 'userId', value: 'U7' }]),
    P(2, F('getProfile', 'p.svc.ts', 9), 2, []),
    P(3, F('getDashboard', 'd.ctrl.ts', 28), 1, []),
  ]);
  const mm = toMermaidSequence(roots);
  assert(mm.startsWith('sequenceDiagram'), 'mermaid: starts with sequenceDiagram');
  assert(/participant .* as getDashboard/.test(mm), 'mermaid: declares getDashboard participant');
  assert(mm.includes('->>') && mm.includes('-->>'), 'mermaid: has call (->>) and return (-->>) arrows');
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
