/**
 * Standalone tests for the pure host logic (no VS Code needed).
 * Run: npm run compile && node verify/host-logic.test.mjs
 * Imports the compiled CommonJS from out/.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const flow = require(path.join(root, 'out', 'flowRunner.js'));
const mock = require(path.join(root, 'out', 'mockStore.js'));
const gen = require(path.join(root, 'out', 'testGenerator.js'));
const bp = require(path.join(root, 'out', 'breakpointPath.js'));

let pass = 0, fail = 0;
const assert = (c, m) => (c ? (pass++, console.log(`\u2713 ${m}`)) : (fail++, console.error(`\u2717 FAIL: ${m}`)));

// ---- flowRunner.interpolate ----
assert(flow.interpolate('a/${id}/b', { id: '42' }) === 'a/42/b', 'interpolate replaces ${id}');
assert(flow.interpolate('x/${missing}', {}) === 'x/${missing}', 'interpolate leaves unknown vars intact');

// ---- flowRunner.extractPath ----
const sample = { data: { id: 'C1', items: [{ sku: 'S9' }] } };
assert(flow.extractPath(sample, '$.data.id') === 'C1', 'extractPath $.data.id');
assert(flow.extractPath(sample, '$.data.items[0].sku') === 'S9', 'extractPath array index');
assert(flow.extractPath(sample, '$.nope') === undefined, 'extractPath missing -> undefined');

// ---- flowRunner.runScenario (chaining + failure capture) ----
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, method: init.method });
  if (url.endsWith('/items')) {
    return { status: 201, ok: true, text: async () => JSON.stringify({ id: 'ITEM-7' }) };
  }
  if (url.endsWith('/items/ITEM-7')) {
    return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'ITEM-7', name: 'widget' }) };
  }
  throw new Error('connection refused');
};
const scenario = {
  id: 's1', name: 'chain', dbMode: 'real',
  calls: [
    { id: 'c1', name: 'create', method: 'POST', url: 'http://h/items', body: '{}', extract: { itemId: '$.id' } },
    { id: 'c2', name: 'fetch', method: 'GET', url: 'http://h/items/${itemId}' },
    { id: 'c3', name: 'boom', method: 'GET', url: 'http://h/down' },
  ],
};
const results = await flow.runScenario(scenario, fakeFetch, {});
assert(results.length === 3, 'runScenario returns one result per call');
assert(results[0].status === 201 && results[0].ok, 'first call ok 201');
assert(calls[1].url === 'http://h/items/ITEM-7', 'extracted itemId chained into 2nd call URL');
assert(results[1].status === 200, 'second call resolved chained URL');
assert(results[2].ok === false && /refused/.test(results[2].error), 'failing call captured, not thrown');

// ---- per-call selection: enabled:false is skipped ----
{
  const seen = [];
  const ff = async (url, init) => { seen.push(url); return { status: 200, ok: true, text: async () => '{}' }; };
  const scn = { id: 's2', name: 'sel', dbMode: 'real', calls: [
    { id: 'a', name: 'a', method: 'GET', url: 'http://h/a' },
    { id: 'b', name: 'b', method: 'GET', url: 'http://h/b', enabled: false },
    { id: 'c', name: 'c', method: 'GET', url: 'http://h/c', enabled: true },
  ] };
  const r = await flow.runScenario(scn, ff, {});
  assert(r.length === 2, 'disabled call is skipped (2 results, not 3)');
  assert(seen.length === 2 && !seen.includes('http://h/b'), 'disabled call never fired');
  assert(r.some((x) => x.callId === 'a') && r.some((x) => x.callId === 'c'), 'enabled calls a and c ran');
}

// ---- mockStore.normalizeMockSet + sanitizeName ----
const ms = mock.normalizeMockSet({ name: 'my set!!', variableOverrides: { 'a.ts:1:x': 5 }, boundaryMocks: [{ match: 'db.get', returns: { ok: 1 } }, { bad: true }] }, 'fallback');
assert(ms.name === 'my-set--', 'sanitizeName replaces unsafe chars');
assert(ms.variableOverrides['a.ts:1:x'] === '5', 'override value coerced to string');
assert(ms.boundaryMocks.length === 1, 'invalid boundary mock dropped');

// ---- run lifecycle attribution hooks + timeout/cancellation ----
{
  const events = [];
  const scn = { id: 'hooks', name: 'hooks', dbMode: 'real', calls: [
    { id: 'h1', name: 'one', method: 'GET', url: 'http://h/one' },
  ] };
  const r = await flow.runScenario(scn,
    async () => ({ status: 200, ok: true, text: async () => '{}' }), {
      onCallStart: (call, index) => events.push(`start:${call.id}:${index}`),
      onCallResult: (result) => events.push(`result:${result.callId}:${result.pauseCount}`),
      onCallEnd: (result, index) => events.push(`end:${result.callId}:${index}`),
      pauseCountFor: () => 4,
    });
  assert(r[0].pauseCount === 4, 'runScenario records the attributed pause count');
  assert(events.join('|') === 'start:h1:0|result:h1:4|end:h1:0', 'call lifecycle hooks fire start -> result -> end in order');
}

{
  const scn = { id: 'timeout', name: 'timeout', dbMode: 'real', calls: [
    { id: 'slow', name: 'slow', method: 'GET', url: 'http://h/slow' },
  ] };
  const r = await flow.runScenario(scn, () => new Promise(() => {}), { timeoutMs: 10 });
  assert(r.length === 1 && /Timed out after 10ms/.test(r[0].error), 'per-call timeout records a precise failure instead of hanging');
}

{
  const controller = new AbortController();
  const starts = [];
  const scn = { id: 'cancel', name: 'cancel', dbMode: 'real', calls: [
    { id: 'first', name: 'first', method: 'GET', url: 'http://h/first' },
    { id: 'never', name: 'never', method: 'GET', url: 'http://h/never' },
  ] };
  setTimeout(() => controller.abort(), 10);
  const r = await flow.runScenario(scn, () => new Promise(() => {}), {
    signal: controller.signal,
    onCallStart: (call) => starts.push(call.id),
  });
  assert(r.length === 1 && r[0].error === 'Run cancelled', 'cancellation records the in-flight call as cancelled');
  assert(starts.join(',') === 'first', 'cancellation prevents later scenario calls from starting');
}
assert(ms.language === 'node', 'default language node');

// ---- mockStore load/save round trip ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowdbg-'));
const store = new mock.MockStore(tmp);
store.save({ name: 'rt', language: 'node', variableOverrides: { 'f.ts:2:y': '9' }, boundaryMocks: [] });
assert(store.list().includes('rt'), 'saved mock set appears in list()');
const loaded = store.load('rt');
assert(loaded && loaded.variableOverrides['f.ts:2:y'] === '9', 'load() round-trips the override');
fs.rmSync(tmp, { recursive: true, force: true });

// ---- testGenerator ----
const test = gen.generateTest({ scenario, results, mockSet: ms });
assert(test.filename.endsWith('.flow.test.ts'), 'generated test filename ends .flow.test.ts');
assert(/describe\('chain'/.test(test.content), 'test describes the scenario');
assert(/expect\(res\.status\)\.toBe\(201\)/.test(test.content), 'test asserts recorded status');
assert(/http:\/\/h\/items/.test(test.content), 'test replays the request URL');

// ---- breakpointPath ----
assert(bp.resolveBreakpointPath('src/handler.ts', '/ws') === '/ws/src/handler.ts', 'resolveBreakpointPath joins relative against workspace root');
assert(bp.resolveBreakpointPath('/abs/handler.ts', '/ws') === '/abs/handler.ts', 'resolveBreakpointPath passes absolute paths through');
assert(bp.resolveBreakpointPath('./a/../b.ts', '/ws') === '/ws/b.ts', 'resolveBreakpointPath normalizes ..');
assert(bp.bpKey('/ws/f.ts', 42) === '/ws/f.ts:42', 'bpKey builds file:line');

// ---- breakpointPath.resolveResumeThreadId (continue targets the paused thread, not 0) ----
assert(bp.resolveResumeThreadId(7, [{ id: 1 }, { id: 7 }]) === 7, 'resume prefers the tracked paused thread');
assert(bp.resolveResumeThreadId(7, undefined) === 7, 'resume uses tracked thread even with no thread list');
assert(bp.resolveResumeThreadId(undefined, [{ id: 3 }, { id: 4 }]) === 3, 'resume falls back to first reported thread');
assert(bp.resolveResumeThreadId(undefined, []) === undefined, 'resume returns undefined when nothing is known (never guesses 0)');
assert(bp.resolveResumeThreadId(0, [{ id: 5 }]) === 0, 'resume honours a legitimately-tracked thread id of 0');

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
process.exitCode = fail ? 1 : 0;
