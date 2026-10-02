/**
 * Runtime Behavior Contracts.
 *
 * A baseline trace is *evidence*; a contract says what is *required*. Contracts
 * assert SEMANTIC behaviour (which methods must/must not run, how many DB calls
 * are acceptable, what a value may transition to, that mocks actually injected)
 * rather than snapshotting every incidental runtime value — so they survive
 * refactors that don't change behaviour, and fail loudly when behaviour drifts.
 *
 * Pure + dependency-free (no YAML dep: a tiny serializer/parser for the subset
 * we emit, plus JSON is always accepted).
 */

import type { FlowTrace, TraceMethod } from './flowTrace.js';

export interface BehaviorContract {
    scenario: string;
    assert: {
        /** Exact HTTP status the (first) call must return. */
        'response.status'?: number;
        /** No uncaught exception anywhere on the path. */
        noUncaughtExceptions?: boolean;
        /** These methods MUST be called (id `fn@source`, or bare `fn`). */
        mustCall?: string[];
        /** These methods must NOT be called. */
        mustNotCall?: string[];
        /** Per-method ceiling on DB calls, e.g. { "Accessor.get": 1 }. */
        maxCalls?: Record<string, number>;
        /** A variable may only end up as one of these values. */
        allowedTransitions?: Record<string, Array<string | number>>;
        /** These variables must never be cleared to empty/null. */
        neverClear?: string[];
        /** Every declared boundary mock must have injected successfully. */
        mocksMustInject?: boolean;
        /** Heap must be reclaimed at least once during the run. */
        memoryMustReclaim?: boolean;
        /** Ceiling on total DB calls across the whole request. */
        maxTotalDbCalls?: number;
    };
}

export interface ContractViolation {
    rule: string;
    expected: string;
    actual: string;
    where?: string;
    hint?: string;
}

export interface ContractResult {
    pass: boolean;
    scenario: string;
    checked: number;
    violations: ContractViolation[];
    /** Rules that passed, for a readable report. */
    satisfied: string[];
}

const EMPTYISH = /^(''|""|null|undefined|\[\]|\{\}|0|None)$/;

function flatten(methods: TraceMethod[], out: TraceMethod[] = []): TraceMethod[] {
    for (const m of methods) { out.push(m); flatten(m.children, out); }
    return out;
}

/** Match a contract method reference against a trace method (id or bare fn). */
function matches(ref: string, m: TraceMethod): boolean {
    if (ref === m.id) return true;
    if (ref === m.fn) return true;
    // Allow "Class.method" style by matching the tail of fn, and "fn@file" ids.
    const tail = ref.includes('.') ? ref.split('.').pop() : undefined;
    return tail === m.fn;
}

/* ---------------- generate ---------------- */

/**
 * Derive a contract from a trace that represents *correct* behaviour. Deliberately
 * conservative: asserts the shape of behaviour (methods, ceilings, no-exceptions)
 * and leaves value-level assertions to the human to add.
 */
export function createContract(trace: FlowTrace, opts: { scenario?: string } = {}): BehaviorContract {
    const all = flatten(trace.methods);
    const maxCalls: Record<string, number> = {};
    for (const m of all) {
        if (m.dbCalls > 0) maxCalls[m.id] = m.dbCalls;
    }
    const neverClear: string[] = [];
    // Variables that were NOT cleared in the good run are candidates to protect.
    const clearedNames = new Set(trace.mutations.filter((mu) => EMPTYISH.test(mu.to.trim())).map((mu) => mu.name));
    for (const mu of trace.mutations) {
        if (!clearedNames.has(mu.name) && !neverClear.includes(mu.name)) neverClear.push(mu.name);
    }

    const contract: BehaviorContract = {
        scenario: opts.scenario ?? trace.scenario.name,
        assert: {
            noUncaughtExceptions: true,
            mustCall: all.filter((m) => m.layer === 'controller' || m.layer === 'service').map((m) => m.id),
            ...(Object.keys(maxCalls).length ? { maxCalls } : {}),
            ...(neverClear.length ? { neverClear } : {}),
            ...(trace.scenario.dbMode === 'mocked' ? { mocksMustInject: true } : {}),
            ...(trace.stats.dbCallTotal ? { maxTotalDbCalls: trace.stats.dbCallTotal } : {}),
        },
    };
    const status = trace.calls[0]?.response?.status;
    if (typeof status === 'number') contract.assert['response.status'] = status;
    if (trace.memory?.reclaimed) contract.assert.memoryMustReclaim = true;
    return contract;
}

/* ---------------- verify ---------------- */

export function verifyContract(contract: BehaviorContract, trace: FlowTrace): ContractResult {
    const v: ContractViolation[] = [];
    const ok: string[] = [];
    const all = flatten(trace.methods);
    const a = contract.assert;
    let checked = 0;

    if (typeof a['response.status'] === 'number') {
        checked++;
        const actual = trace.calls[0]?.response?.status ?? null;
        if (actual !== a['response.status']) {
            v.push({ rule: 'response.status', expected: String(a['response.status']), actual: String(actual),
                where: trace.calls[0]?.request?.url, hint: 'The endpoint returned a different status than the contract requires.' });
        } else ok.push(`response.status = ${actual}`);
    }

    if (a.noUncaughtExceptions) {
        checked++;
        const thrown = all.filter((m) => m.error);
        if (thrown.length) {
            for (const m of thrown) {
                v.push({ rule: 'noUncaughtExceptions', expected: 'no exception', actual: `${m.error!.type ?? 'Error'}: ${m.error!.message}`,
                    where: m.source, hint: 'An exception was thrown on this path.' });
            }
        } else ok.push('no uncaught exceptions');
    }

    for (const ref of a.mustCall ?? []) {
        checked++;
        if (!all.some((m) => matches(ref, m))) {
            v.push({ rule: 'mustCall', expected: `${ref} is called`, actual: 'not called',
                hint: 'Either the code path changed, or no breakpoint covers this method (coverage gap).' });
        } else ok.push(`mustCall ${ref}`);
    }

    for (const ref of a.mustNotCall ?? []) {
        checked++;
        const hit = all.find((m) => matches(ref, m));
        if (hit) {
            v.push({ rule: 'mustNotCall', expected: `${ref} is NOT called`, actual: 'was called', where: hit.source,
                hint: 'This method must not run on this path.' });
        } else ok.push(`mustNotCall ${ref}`);
    }

    for (const [ref, limit] of Object.entries(a.maxCalls ?? {})) {
        checked++;
        const hits = all.filter((m) => matches(ref, m));
        const count = hits.reduce((n, m) => n + Math.max(m.dbCalls, m.enteredCount > 1 ? m.enteredCount : 0), 0);
        if (count > limit) {
            v.push({ rule: 'maxCalls', expected: `${ref} ≤ ${limit}`, actual: String(count),
                where: hits[0]?.source, hint: 'More calls than allowed — often an N+1 introduced by a loop.' });
        } else ok.push(`maxCalls ${ref} ≤ ${limit}`);
    }

    for (const [name, allowed] of Object.entries(a.allowedTransitions ?? {})) {
        checked++;
        const seen = trace.mutations.filter((m) => m.name === name);
        const bad = seen.filter((m) => !allowed.map(String).includes(m.to.replace(/^['"]|['"]$/g, '')));
        if (bad.length) {
            v.push({ rule: 'allowedTransitions', expected: `${name} ∈ [${allowed.join(', ')}]`, actual: bad.map((b) => b.to).join(', '),
                where: `line ${bad[0].line}`, hint: 'The value moved to a state the contract does not allow.' });
        } else ok.push(`allowedTransitions ${name}`);
    }

    for (const name of a.neverClear ?? []) {
        checked++;
        const cleared = trace.mutations.find((m) => m.name === name && EMPTYISH.test(m.to.trim()) && !EMPTYISH.test(m.from.trim()));
        if (cleared) {
            v.push({ rule: 'neverClear', expected: `${name} is never cleared`, actual: `${cleared.from} → ${cleared.to}`,
                where: `line ${cleared.line}`, hint: 'A populated value became empty — a common source of silent data loss.' });
        } else ok.push(`neverClear ${name}`);
    }

    if (a.mocksMustInject) {
        checked++;
        const results = trace.mockInjection?.results ?? [];
        const failed = results.filter((r) => r.status !== 'ok');
        if (!results.length) {
            v.push({ rule: 'mocksMustInject', expected: 'boundary mocks injected', actual: 'no mocks were declared',
                hint: 'The run was not isolated — it hit the real dependency.' });
        } else if (failed.length) {
            v.push({ rule: 'mocksMustInject', expected: 'all mocks injected', actual: `${failed.length} failed: ${failed.map((f) => f.match).join(', ')}`,
                hint: 'Those calls hit the real dependency, so the run was not isolated.' });
        } else ok.push(`mocksMustInject (${results.length})`);
    }

    if (a.memoryMustReclaim) {
        checked++;
        if (trace.memory && trace.memory.reclaimed === false) {
            v.push({ rule: 'memoryMustReclaim', expected: 'heap reclaimed at least once', actual: 'never decreased',
                hint: 'Possible retention introduced on this path.' });
        } else ok.push('memoryMustReclaim');
    }

    if (typeof a.maxTotalDbCalls === 'number') {
        checked++;
        if (trace.stats.dbCallTotal > a.maxTotalDbCalls) {
            v.push({ rule: 'maxTotalDbCalls', expected: `≤ ${a.maxTotalDbCalls}`, actual: String(trace.stats.dbCallTotal),
                hint: 'The request makes more database round-trips than allowed.' });
        } else ok.push(`maxTotalDbCalls ≤ ${a.maxTotalDbCalls}`);
    }

    return { pass: v.length === 0, scenario: contract.scenario, checked, violations: v, satisfied: ok };
}

/** Human-readable explanation of a failure, for an agent or a PR comment. */
export function explainResult(r: ContractResult): string {
    if (r.pass) return `✅ Contract "${r.scenario}" PASSED — ${r.checked} rule(s) satisfied.`;
    const L = [`❌ Contract "${r.scenario}" FAILED — ${r.violations.length} of ${r.checked} rule(s) violated.`, ''];
    for (const v of r.violations) {
        L.push(`- **${v.rule}**`);
        L.push(`  - expected: ${v.expected}`);
        L.push(`  - actual:   ${v.actual}`);
        if (v.where) L.push(`  - where:    ${v.where}`);
        if (v.hint) L.push(`  - ${v.hint}`);
    }
    return L.join('\n');
}

/* ---------------- tiny YAML for the contract subset ---------------- */

/** Serialize a contract to readable YAML (the subset we emit). */
export function contractToYaml(c: BehaviorContract): string {
    const L: string[] = [`scenario: ${c.scenario}`, 'assert:'];
    const a = c.assert;
    const scalar = (k: string, val: unknown) => L.push(`  ${k}: ${val}`);
    if (typeof a['response.status'] === 'number') scalar('response.status', a['response.status']);
    if (a.noUncaughtExceptions !== undefined) scalar('noUncaughtExceptions', a.noUncaughtExceptions);
    if (a.mocksMustInject !== undefined) scalar('mocksMustInject', a.mocksMustInject);
    if (a.memoryMustReclaim !== undefined) scalar('memoryMustReclaim', a.memoryMustReclaim);
    if (a.maxTotalDbCalls !== undefined) scalar('maxTotalDbCalls', a.maxTotalDbCalls);
    for (const [key, arr] of [['mustCall', a.mustCall], ['mustNotCall', a.mustNotCall], ['neverClear', a.neverClear]] as const) {
        if (arr?.length) { L.push(`  ${key}:`); for (const x of arr) L.push(`    - ${x}`); }
    }
    if (a.maxCalls && Object.keys(a.maxCalls).length) {
        L.push('  maxCalls:');
        for (const [k, n] of Object.entries(a.maxCalls)) L.push(`    ${JSON.stringify(k)}: ${n}`);
    }
    if (a.allowedTransitions && Object.keys(a.allowedTransitions).length) {
        L.push('  allowedTransitions:');
        for (const [k, vals] of Object.entries(a.allowedTransitions)) L.push(`    ${JSON.stringify(k)}: [${vals.join(', ')}]`);
    }
    return L.join('\n') + '\n';
}

/** Parse the YAML subset produced by contractToYaml (JSON also accepted). */
export function parseContract(text: string): BehaviorContract {
    const t = text.trim();
    if (t.startsWith('{')) return JSON.parse(t) as BehaviorContract;
    const c: BehaviorContract = { scenario: 'unnamed', assert: {} };
    const a = c.assert as Record<string, unknown>;
    let listKey: string | null = null;
    let mapKey: string | null = null;
    const num = (s: string) => (/^-?\d+$/.test(s) ? Number(s) : s);
    for (const raw of t.split(/\r?\n/)) {
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length;
        const line = raw.trim();
        if (indent === 0) {
            listKey = mapKey = null;
            const m = /^scenario:\s*(.+)$/.exec(line);
            if (m) c.scenario = m[1].trim();
            continue;
        }
        if (line.startsWith('- ')) {
            if (listKey) (a[listKey] as string[]).push(line.slice(2).trim());
            continue;
        }
        const kv = /^([^:]+):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1].trim().replace(/^"|"$/g, '');
        const val = kv[2].trim();
        if (indent >= 4 && mapKey) {
            const target = a[mapKey] as Record<string, unknown>;
            target[key] = val.startsWith('[')
                ? val.slice(1, -1).split(',').map((s) => num(s.trim().replace(/^['"]|['"]$/g, '')))
                : num(val);
            continue;
        }
        if (val === '') {
            // a nested structure follows
            if (key === 'maxCalls' || key === 'allowedTransitions') { a[key] = {}; mapKey = key; listKey = null; }
            else { a[key] = []; listKey = key; mapKey = null; }
            continue;
        }
        listKey = mapKey = null;
        a[key] = val === 'true' ? true : val === 'false' ? false : num(val);
    }
    return c;
}
