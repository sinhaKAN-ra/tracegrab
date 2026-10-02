#!/usr/bin/env node
/**
 * flow-verify — headless verification runner.
 *
 * Runs OUTSIDE VS Code so a PR can be gated on runtime behaviour. It does not
 * re-implement debugging: it consumes FlowTraces that a collector produced
 * (today: the VS Code extension; later: a standalone DAP collector), and owns
 * the parts that are ours — normalization, contracts, comparison, policy, and
 * the report.
 *
 * Usage:
 *   flow-verify verify   <contract.yaml> [--trace <file|dir>] [--json]
 *   flow-verify compare  <baseline.flowtrace.json> <candidate.flowtrace.json> [--json]
 *   flow-verify report   <trace.flowtrace.json> [--out report.md]
 *   flow-verify contract <trace.flowtrace.json> [--out contract.yaml]   # generate
 *
 * Common flags:
 *   --workspace <dir>   repo root (default cwd); traces resolve under
 *                       <workspace>/.flow-debugger/traces/
 *   --fail-on <list>    comma list: exception,contract-violation,new-n-plus-one,
 *                       regression,heap-growth,db-fanout   (default:
 *                       exception,contract-violation,regression)
 *   --json              machine-readable output
 *
 * Exit codes: 0 = pass, 1 = policy failure (gate the PR), 2 = usage/IO error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--') && !['--json'].includes(arr[i - 1])));

const WORKSPACE = path.resolve(flag('workspace', process.cwd()));
const JSON_OUT = has('json');
const DEFAULT_FAIL_ON = ['exception', 'contract-violation', 'regression'];
const FAIL_ON = (flag('fail-on', DEFAULT_FAIL_ON.join(','))).split(',').map((s) => s.trim()).filter(Boolean);

/* ---------------- shared logic (reuse the zero-dep modules) ---------------- */
const here = path.dirname(new URL(import.meta.url).pathname);
const { buildFlowTrace, buildCallTree, inferState, reportMarkdown, diffTraces, diffMarkdown } =
    await import(path.join(here, '..', 'mcp', 'callmap.mjs'));

function die(msg, code = 2) {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`flow-verify: ${msg}`);
    process.exit(code);
}

function readJsonFile(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { die(`cannot read ${p}: ${e.message}`); }
}

/** Resolve a trace by path, or by name under <workspace>/.flow-debugger/traces/. */
function resolveTrace(ref) {
    if (!ref) return undefined;
    const tries = [
        ref,
        path.join(WORKSPACE, ref),
        path.join(WORKSPACE, '.flow-debugger', 'traces', ref),
        path.join(WORKSPACE, '.flow-debugger', 'traces', `${ref}.flowtrace.json`),
    ];
    for (const p of tries) if (fs.existsSync(p) && fs.statSync(p).isFile()) return readJsonFile(p);
    return undefined;
}

/** Build a trace from the recorded pause log, when no trace file is given. */
function traceFromLog() {
    const logPath = path.join(WORKSPACE, '.flow-debugger', 'captures', 'log.ndjson');
    if (!fs.existsSync(logPath)) return undefined;
    const pauses = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => {
        try {
            const r = JSON.parse(l);
            return { order: r.seq, frame: r.frame, stackDepth: r.stackDepth ?? 1, vars: r.vars ?? [], dbMode: r.dbMode, heapUsed: r.heapUsed, exception: r.exception };
        } catch { return null; }
    }).filter(Boolean);
    if (!pauses.length) return undefined;
    const roots = buildCallTree(pauses);
    return buildFlowTrace({ pauses, roots, diagnosis: inferState(pauses, roots), scenario: { name: 'ci run', dbMode: 'real' } });
}

/* ---------------- contracts (inlined: keep the CLI zero-dep) ---------------- */
const EMPTYISH = /^(''|""|null|undefined|\[\]|\{\}|0|None)$/;
const flat = (ms, out = []) => { for (const m of ms ?? []) { out.push(m); flat(m.children, out); } return out; };
const matches = (ref, m) => ref === m.id || ref === m.fn || (ref.includes('.') && ref.split('.').pop() === m.fn);

function parseContract(text) {
    const t = text.trim();
    if (t.startsWith('{')) return JSON.parse(t);
    const c = { scenario: 'unnamed', assert: {} }, a = c.assert;
    let listKey = null, mapKey = null;
    const num = (s) => (/^-?\d+$/.test(s) ? Number(s) : s);
    for (const raw of t.split(/\r?\n/)) {
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length, line = raw.trim();
        if (indent === 0) { listKey = mapKey = null; const m = /^scenario:\s*(.+)$/.exec(line); if (m) c.scenario = m[1].trim(); continue; }
        if (line.startsWith('- ')) { if (listKey) a[listKey].push(line.slice(2).trim()); continue; }
        const kv = /^([^:]+):\s*(.*)$/.exec(line); if (!kv) continue;
        const key = kv[1].trim().replace(/^"|"$/g, ''), val = kv[2].trim();
        if (indent >= 4 && mapKey) {
            a[mapKey][key] = val.startsWith('[')
                ? val.slice(1, -1).split(',').map((s) => num(s.trim().replace(/^['"]|['"]$/g, '')))
                : num(val);
            continue;
        }
        if (val === '') {
            if (key === 'maxCalls' || key === 'allowedTransitions') { a[key] = {}; mapKey = key; listKey = null; }
            else { a[key] = []; listKey = key; mapKey = null; }
            continue;
        }
        listKey = mapKey = null;
        a[key] = val === 'true' ? true : val === 'false' ? false : num(val);
    }
    return c;
}

function verifyContract(contract, trace) {
    const v = [], ok = [], all = flat(trace.methods), a = contract.assert || {};
    let checked = 0;
    if (typeof a['response.status'] === 'number') {
        checked++; const actual = trace.calls?.[0]?.response?.status ?? null;
        if (actual !== a['response.status']) v.push({ rule: 'response.status', expected: String(a['response.status']), actual: String(actual) });
        else ok.push(`response.status = ${actual}`);
    }
    if (a.noUncaughtExceptions) {
        checked++; const thrown = all.filter((m) => m.error);
        if (thrown.length) for (const m of thrown) v.push({ rule: 'noUncaughtExceptions', expected: 'no exception', actual: `${m.error.type ?? 'Error'}: ${m.error.message}`, where: m.source });
        else ok.push('no uncaught exceptions');
    }
    for (const ref of a.mustCall ?? []) { checked++; if (!all.some((m) => matches(ref, m))) v.push({ rule: 'mustCall', expected: `${ref} is called`, actual: 'not called' }); else ok.push(`mustCall ${ref}`); }
    for (const ref of a.mustNotCall ?? []) { checked++; const hit = all.find((m) => matches(ref, m)); if (hit) v.push({ rule: 'mustNotCall', expected: `${ref} NOT called`, actual: 'was called', where: hit.source }); else ok.push(`mustNotCall ${ref}`); }
    for (const [ref, limit] of Object.entries(a.maxCalls ?? {})) {
        checked++; const hits = all.filter((m) => matches(ref, m));
        const count = hits.reduce((n, m) => n + Math.max(m.dbCalls, m.enteredCount > 1 ? m.enteredCount : 0), 0);
        if (count > limit) v.push({ rule: 'maxCalls', expected: `${ref} <= ${limit}`, actual: String(count), where: hits[0]?.source }); else ok.push(`maxCalls ${ref}`);
    }
    for (const [name, allowed] of Object.entries(a.allowedTransitions ?? {})) {
        checked++; const bad = (trace.mutations ?? []).filter((m) => m.name === name && !allowed.map(String).includes(String(m.to).replace(/^['"]|['"]$/g, '')));
        if (bad.length) v.push({ rule: 'allowedTransitions', expected: `${name} in [${allowed.join(', ')}]`, actual: bad.map((b) => b.to).join(', '), where: `line ${bad[0].line}` }); else ok.push(`allowedTransitions ${name}`);
    }
    for (const name of a.neverClear ?? []) {
        checked++; const cleared = (trace.mutations ?? []).find((m) => m.name === name && EMPTYISH.test(String(m.to).trim()) && !EMPTYISH.test(String(m.from).trim()));
        if (cleared) v.push({ rule: 'neverClear', expected: `${name} never cleared`, actual: `${cleared.from} -> ${cleared.to}`, where: `line ${cleared.line}` }); else ok.push(`neverClear ${name}`);
    }
    if (a.mocksMustInject) {
        checked++; const res = trace.mockInjection?.results ?? [], failed = res.filter((r) => r.status !== 'ok');
        if (!res.length) v.push({ rule: 'mocksMustInject', expected: 'mocks injected', actual: 'none declared' });
        else if (failed.length) v.push({ rule: 'mocksMustInject', expected: 'all injected', actual: `${failed.length} failed` });
        else ok.push('mocksMustInject');
    }
    if (a.memoryMustReclaim) {
        checked++; if (trace.memory && trace.memory.reclaimed === false) v.push({ rule: 'memoryMustReclaim', expected: 'heap reclaimed', actual: 'never decreased' }); else ok.push('memoryMustReclaim');
    }
    if (typeof a.maxTotalDbCalls === 'number') {
        checked++; if ((trace.stats?.dbCallTotal ?? 0) > a.maxTotalDbCalls) v.push({ rule: 'maxTotalDbCalls', expected: `<= ${a.maxTotalDbCalls}`, actual: String(trace.stats.dbCallTotal) }); else ok.push('maxTotalDbCalls');
    }
    return { pass: v.length === 0, scenario: contract.scenario, checked, violations: v, satisfied: ok };
}

/* ---------------- policy ---------------- */
function applyPolicy({ contractResult, diff, trace }) {
    const reasons = [];
    const want = (k) => FAIL_ON.includes(k);
    if (contractResult && !contractResult.pass && want('contract-violation')) {
        reasons.push(`${contractResult.violations.length} contract violation(s)`);
    }
    if (trace && want('exception')) {
        const ex = flat(trace.methods).filter((m) => m.error);
        if (ex.length) reasons.push(`${ex.length} uncaught exception(s)`);
    }
    if (trace && want('new-n-plus-one')) {
        const n1 = flat(trace.methods).filter((m) => m.n1);
        if (n1.length) reasons.push(`${n1.length} N+1 suspect(s)`);
    }
    if (trace && want('heap-growth') && trace.memory && (trace.memory.netDelta ?? 0) > 0 && !trace.memory.reclaimed) {
        reasons.push('heap grew without reclaim');
    }
    if (trace && want('db-fanout')) {
        const fan = flat(trace.methods).filter((m) => m.dbCalls >= 4);
        if (fan.length) reasons.push(`${fan.length} method(s) with DB fan-out`);
    }
    if (diff && diff.outcome === 'REGRESSION' && want('regression')) {
        reasons.push(`behavioral regression (${diff.entries.filter((e) => e.severity === 'regression').length})`);
    }
    return { fail: reasons.length > 0, reasons };
}

function out(obj, human) {
    if (JSON_OUT) console.log(JSON.stringify(obj, null, 2));
    else console.log(human);
}

/* ---------------- commands ---------------- */
if (!cmd || has('help') || cmd === 'help') {
    console.log(`flow-verify — headless runtime behavioral verification

  check                                            which languages are ready to collect right now
  collect  <program> --bp <file:line,...>          RECORD a trace with NO IDE
                        [--lang node|python]        (Node: built-in inspector, nothing to install;
                        [--python <path>]            Python: needs debugpy in the TARGET env — see "check")
  verify   <contract.yaml> [--trace <file|name>]   verify a contract against a trace
  compare  <baseline> <candidate>                  behavioral diff of two traces
  report   <trace>                [--out file.md]  render a test report
  contract <trace>                [--out file.yaml] generate a contract from a trace

  --workspace <dir>  repo root (default cwd)
  --fail-on <list>   ${DEFAULT_FAIL_ON.join(',')}  (also: new-n-plus-one,heap-growth,db-fanout)
  --json             machine-readable output

exit 0 = pass · 1 = policy failure · 2 = usage/IO error`);
    process.exit(0);
}

if (cmd === 'check') {
    const { availableDrivers } = await import(path.join(here, 'collector.mjs'));
    const avail = availableDrivers({ pythonPath: flag('python') });
    const human = Object.entries(avail).map(([lang, a]) => `  ${a.ok ? '✓' : '✗'} ${lang}${a.ok ? '' : ` — ${a.reason}`}`).join('\n');
    out({ ok: true, drivers: avail }, `Headless collector availability:\n${human}`);
    process.exit(0);
}

if (cmd === 'collect') {
    const program = positional[0] || flag('program');
    if (!program) die('usage: flow-verify collect <program> [--bp file:line,...] [--lang node|python] [--python <path>]');
    const language = flag('lang', 'node');
    const bpSpec = flag('bp', '');
    const breakpoints = bpSpec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const i = s.lastIndexOf(':');
        if (i < 0) die(`bad --bp entry "${s}" (expected file:line)`);
        return { file: s.slice(0, i), line: Number(s.slice(i + 1)) };
    });
    const { collect } = await import(path.join(here, 'collector.mjs'));
    try {
        const res = await collect({
            language, program, cwd: WORKSPACE, workspace: WORKSPACE, breakpoints,
            args: (flag('args', '') || '').split(' ').filter(Boolean),
            totalMs: Number(flag('timeout', '60000')),
            pythonPath: flag('python'),
        });
        const unbound = (res.boundBreakpoints || []).filter((b) => !b.verified);
        const human = [
            `Collected ${res.pauses} pause(s) → ${res.logPath}`,
            ...(res.boundBreakpoints || []).map((b) => `  ${b.verified ? '✓' : '✗'} ${b.file}:${b.line}`),
            ...(unbound.length ? [`\n${unbound.length} breakpoint(s) did NOT bind — check paths/lines.`] : []),
            ...(res.pauses === 0 ? ['\nNo pauses recorded. Likely: breakpoints never hit, or the program exited first.'] : []),
            ...(res.adapterErrors.length ? [`\nAdapter output:\n  ${res.adapterErrors.slice(0, 5).join('\n  ')}`] : []),
        ].join('\n');
        out({ ok: res.pauses > 0, ...res }, human);
        process.exit(res.pauses > 0 ? 0 : 1);
    } catch (e) {
        die(`collect failed: ${e.message}`);
    }
}

if (cmd === 'verify') {
    const contractPath = positional[0];
    if (!contractPath) die('usage: flow-verify verify <contract.yaml> [--trace <file|name>]');
    if (!fs.existsSync(contractPath)) die(`contract not found: ${contractPath}`);
    const contract = parseContract(fs.readFileSync(contractPath, 'utf8'));
    const trace = resolveTrace(flag('trace')) ?? traceFromLog();
    if (!trace) die('no trace: pass --trace <file|name>, or record a run first');
    const result = verifyContract(contract, trace);
    const policy = applyPolicy({ contractResult: result, trace });
    const human = [
        result.pass ? `PASS  contract "${result.scenario}" — ${result.checked} rule(s) satisfied.`
                    : `FAIL  contract "${result.scenario}" — ${result.violations.length}/${result.checked} rule(s) violated.`,
        ...result.violations.map((v) => `  - ${v.rule}: expected ${v.expected}, got ${v.actual}${v.where ? ` (${v.where})` : ''}`),
        policy.fail ? `\nGATE: FAIL — ${policy.reasons.join('; ')}` : '\nGATE: PASS',
    ].join('\n');
    out({ ok: !policy.fail, contract: result, policy, failOn: FAIL_ON }, human);
    process.exit(policy.fail ? 1 : 0);
}

if (cmd === 'compare') {
    const [b, c] = positional;
    if (!b || !c) die('usage: flow-verify compare <baseline> <candidate>');
    const baseline = resolveTrace(b), candidate = resolveTrace(c);
    if (!baseline) die(`baseline trace not found: ${b}`);
    if (!candidate) die(`candidate trace not found: ${c}`);
    const d = diffTraces(baseline, candidate);
    const policy = applyPolicy({ diff: d, trace: candidate });
    out({ ok: !policy.fail, diff: d, policy, failOn: FAIL_ON },
        `${diffMarkdown(d)}\n\nGATE: ${policy.fail ? `FAIL — ${policy.reasons.join('; ')}` : 'PASS'}`);
    process.exit(policy.fail ? 1 : 0);
}

if (cmd === 'report') {
    const t = resolveTrace(positional[0]) ?? traceFromLog();
    if (!t) die('no trace: pass a trace file/name, or record a run first');
    const md = reportMarkdown(t);
    const dest = flag('out');
    if (dest) { fs.writeFileSync(dest, md, 'utf8'); out({ ok: true, savedTo: dest, verdict: t.verdict }, `Report written: ${dest}`); }
    else out({ ok: true, verdict: t.verdict, markdown: md }, md);
    process.exit(0);
}

if (cmd === 'contract') {
    const t = resolveTrace(positional[0]) ?? traceFromLog();
    if (!t) die('no trace: pass a trace file/name, or record a run first');
    // Generate conservatively (mirrors src/contracts.ts createContract).
    const all = flat(t.methods);
    const maxCalls = {};
    for (const m of all) if (m.dbCalls > 0) maxCalls[m.id] = m.dbCalls;
    const cleared = new Set((t.mutations ?? []).filter((m) => EMPTYISH.test(String(m.to).trim())).map((m) => m.name));
    const neverClear = [...new Set((t.mutations ?? []).map((m) => m.name).filter((n) => !cleared.has(n)))];
    const a = { noUncaughtExceptions: true, mustCall: all.filter((m) => m.layer === 'controller' || m.layer === 'service').map((m) => m.id) };
    if (Object.keys(maxCalls).length) a.maxCalls = maxCalls;
    if (neverClear.length) a.neverClear = neverClear;
    if (t.scenario?.dbMode === 'mocked') a.mocksMustInject = true;
    if (t.stats?.dbCallTotal) a.maxTotalDbCalls = t.stats.dbCallTotal;
    if (typeof t.calls?.[0]?.response?.status === 'number') a['response.status'] = t.calls[0].response.status;
    if (t.memory?.reclaimed) a.memoryMustReclaim = true;

    const L = [`scenario: ${t.scenario?.name ?? 'unnamed'}`, 'assert:'];
    for (const k of ['response.status', 'noUncaughtExceptions', 'mocksMustInject', 'memoryMustReclaim', 'maxTotalDbCalls'])
        if (a[k] !== undefined) L.push(`  ${k}: ${a[k]}`);
    for (const k of ['mustCall', 'mustNotCall', 'neverClear'])
        if (a[k]?.length) { L.push(`  ${k}:`); for (const x of a[k]) L.push(`    - ${x}`); }
    if (a.maxCalls) { L.push('  maxCalls:'); for (const [k, n] of Object.entries(a.maxCalls)) L.push(`    ${JSON.stringify(k)}: ${n}`); }
    const yaml = L.join('\n') + '\n';

    const dest = flag('out');
    if (dest) { fs.writeFileSync(dest, yaml, 'utf8'); out({ ok: true, savedTo: dest }, `Contract written: ${dest}`); }
    else out({ ok: true, yaml }, yaml);
    process.exit(0);
}

die(`unknown command "${cmd}" — run: flow-verify help`);
