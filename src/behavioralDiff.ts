/**
 * Behavioral diff: baseline vs candidate.
 *
 * Compares two FlowTraces and reports what CHANGED about how the code behaves,
 * not just whether the response was 200: call-path changes, DB-call count deltas,
 * new N+1, new exceptions, state newly cleared, response-schema changes, and
 * memory-behaviour changes.
 *
 * MUST normalize noise (timestamps, UUIDs, request ids, unordered arrays) so it
 * does not treat every difference as a bug. Pure + dependency-free.
 */

import type { FlowTrace, TraceMethod, TraceMutation } from './flowTrace.js';

export type DiffSeverity = 'regression' | 'warning' | 'info';

export interface DiffEntry {
    severity: DiffSeverity;
    kind:
        | 'method-added' | 'method-removed'
        | 'db-calls-changed' | 'new-n-plus-one'
        | 'new-exception' | 'exception-resolved'
        | 'state-cleared' | 'mutation-changed'
        | 'response-status' | 'response-schema'
        | 'memory-behaviour' | 'verdict';
    title: string;
    detail?: string;
    where?: string;
    baseline?: string;
    candidate?: string;
}

export interface BehavioralDiff {
    /** REGRESSION / CHANGED / EQUIVALENT — the headline. */
    outcome: 'REGRESSION' | 'CHANGED' | 'EQUIVALENT';
    summary: string;
    baseline: { id: string; verdict: string; sha?: string };
    candidate: { id: string; verdict: string; sha?: string };
    entries: DiffEntry[];
    /** Differences deliberately ignored as noise, for transparency. */
    normalized: string[];
}

/* ---------------- noise normalization ---------------- */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const EPOCH_RE = /\b1[6-9]\d{11}\b/g; // ms epoch
const TRACE_RE = /\b[A-Za-z-]*(?:TraceId|RequestId|requestID)@?[A-Za-z0-9-]{6,}\b/g;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;

/** Replace values that legitimately differ run-to-run with stable placeholders. */
export function normalizeValue(v: string): string {
    return String(v)
        .replace(UUID_RE, '<uuid>')
        .replace(ISO_RE, '<timestamp>')
        .replace(EPOCH_RE, '<epoch>')
        .replace(TRACE_RE, '<traceid>')
        .replace(HEX_RE, '<hex>')
        .trim();
}

/** True when two values differ only by noise. */
export function isNoiseOnlyChange(a?: string, b?: string): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    return normalizeValue(a) === normalizeValue(b);
}

/* ---------------- helpers ---------------- */

function flatten(methods: TraceMethod[], out: TraceMethod[] = []): TraceMethod[] {
    for (const m of methods) { out.push(m); flatten(m.children, out); }
    return out;
}

/** Shape of a JSON-ish object: keys → type names, recursively (order-insensitive). */
export function shapeOf(v: unknown, depth = 0): unknown {
    if (depth > 6) return '…';
    if (v === null) return 'null';
    if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
    if (typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(v as object).sort()) o[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
        return o;
    }
    return typeof v;
}

function shapeDiff(base: unknown, cand: unknown, pathPrefix = ''): Array<{ path: string; from?: string; to?: string }> {
    const out: Array<{ path: string; from?: string; to?: string }> = [];
    const bo = base && typeof base === 'object' && !Array.isArray(base) ? base as Record<string, unknown> : undefined;
    const co = cand && typeof cand === 'object' && !Array.isArray(cand) ? cand as Record<string, unknown> : undefined;
    if (bo && co) {
        for (const k of new Set([...Object.keys(bo), ...Object.keys(co)])) {
            const p = pathPrefix ? `${pathPrefix}.${k}` : k;
            if (!(k in co)) out.push({ path: p, from: JSON.stringify(bo[k]) });
            else if (!(k in bo)) out.push({ path: p, to: JSON.stringify(co[k]) });
            else out.push(...shapeDiff(bo[k], co[k], p));
        }
        return out;
    }
    if (JSON.stringify(base) !== JSON.stringify(cand)) {
        out.push({ path: pathPrefix || '(root)', from: JSON.stringify(base), to: JSON.stringify(cand) });
    }
    return out;
}

function mutKey(m: TraceMutation): string {
    return `${m.name}@${m.line}`;
}
const EMPTYISH = /^(''|""|null|undefined|\[\]|\{\}|0|None)$/;

/* ---------------- the diff ---------------- */

export function diffTraces(baseline: FlowTrace, candidate: FlowTrace): BehavioralDiff {
    const entries: DiffEntry[] = [];
    const normalized: string[] = [];

    const bMethods = flatten(baseline.methods);
    const cMethods = flatten(candidate.methods);
    const bById = new Map(bMethods.map((m) => [m.id, m]));
    const cById = new Map(cMethods.map((m) => [m.id, m]));

    // 1. call path: added / removed methods
    for (const m of cMethods) {
        if (!bById.has(m.id)) {
            entries.push({
                severity: 'warning', kind: 'method-added',
                title: `New method on this path: ${m.fn}`,
                where: m.source, candidate: m.id,
                detail: `${m.layer} layer; ${m.dbCalls} DB call(s).`,
            });
        }
    }
    for (const m of bMethods) {
        if (!cById.has(m.id)) {
            entries.push({
                severity: 'warning', kind: 'method-removed',
                title: `Method no longer called: ${m.fn}`,
                where: m.source, baseline: m.id,
            });
        }
    }

    // 2. DB-call counts + N+1 + exceptions per shared method
    for (const [id, c] of cById) {
        const b = bById.get(id);
        if (!b) continue;
        if (b.dbCalls !== c.dbCalls) {
            const worse = c.dbCalls > b.dbCalls;
            entries.push({
                severity: worse ? 'regression' : 'info', kind: 'db-calls-changed',
                title: `${c.fn} makes ${c.dbCalls} DB call(s) (was ${b.dbCalls})`,
                where: c.source, baseline: String(b.dbCalls), candidate: String(c.dbCalls),
                detail: worse ? 'More database round-trips than the baseline.' : 'Fewer round-trips than the baseline.',
            });
        }
        if (c.n1 && !b.n1) {
            entries.push({
                severity: 'regression', kind: 'new-n-plus-one',
                title: `New N+1: ${c.fn} called ${c.enteredCount}× in a loop`,
                where: c.source, candidate: `×${c.enteredCount}`,
                detail: 'This method was not an N+1 suspect in the baseline.',
            });
        }
        if (c.error && !b.error) {
            entries.push({
                severity: 'regression', kind: 'new-exception',
                title: `New exception in ${c.fn}: ${c.error.type ?? 'Error'}`,
                detail: c.error.message, where: c.source, candidate: c.error.message,
            });
        }
        if (b.error && !c.error) {
            entries.push({
                severity: 'info', kind: 'exception-resolved',
                title: `Exception no longer thrown in ${c.fn}`,
                where: c.source, baseline: b.error.message,
            });
        }
    }

    // 3. mutations: newly-cleared values and changed transitions
    const bMut = new Map(baseline.mutations.map((m) => [mutKey(m), m]));
    const cMut = new Map(candidate.mutations.map((m) => [mutKey(m), m]));
    for (const [k, c] of cMut) {
        const b = bMut.get(k);
        if (!b) {
            if (EMPTYISH.test(c.to.trim()) && !EMPTYISH.test(c.from.trim())) {
                entries.push({
                    severity: 'regression', kind: 'state-cleared',
                    title: `${c.name} is now cleared (${c.from} → ${c.to})`,
                    where: `line ${c.line}`, candidate: c.to,
                    detail: 'A populated value becomes empty here, and did not in the baseline.',
                });
            }
            continue;
        }
        if (isNoiseOnlyChange(b.to, c.to) && isNoiseOnlyChange(b.from, c.from)) {
            if (b.to !== c.to) normalized.push(`${c.name}@${c.line}: value differs only by noise`);
            continue;
        }
        entries.push({
            severity: 'warning', kind: 'mutation-changed',
            title: `${c.name} now transitions ${c.from} → ${c.to}`,
            where: `line ${c.line}`, baseline: `${b.from} → ${b.to}`, candidate: `${c.from} → ${c.to}`,
        });
    }

    // 4. response status + schema per call (positional)
    const n = Math.max(baseline.calls.length, candidate.calls.length);
    for (let i = 0; i < n; i++) {
        const b = baseline.calls[i], c = candidate.calls[i];
        if (!b || !c) continue;
        if (b.response.status !== c.response.status) {
            entries.push({
                severity: (c.response.status ?? 500) >= 400 && (b.response.status ?? 0) < 400 ? 'regression' : 'warning',
                kind: 'response-status',
                title: `${c.request.method} response status ${c.response.status} (was ${b.response.status})`,
                where: c.request.url,
                baseline: String(b.response.status), candidate: String(c.response.status),
            });
        }
        if (b.response.bodyShape !== undefined || c.response.bodyShape !== undefined) {
            for (const d of shapeDiff(b.response.bodyShape, c.response.bodyShape)) {
                entries.push({
                    severity: d.to === undefined ? 'regression' : 'warning', kind: 'response-schema',
                    title: d.to === undefined
                        ? `Response field removed: ${d.path}`
                        : d.from === undefined ? `Response field added: ${d.path}` : `Response field type changed: ${d.path}`,
                    where: c.request.url, baseline: d.from, candidate: d.to,
                });
            }
        }
    }

    // 5. memory behaviour (direction/reclaim, not exact bytes — those are noisy)
    if (baseline.memory && candidate.memory) {
        const bGrew = (baseline.memory.netDelta ?? 0) > 0;
        const cGrew = (candidate.memory.netDelta ?? 0) > 0;
        if (!bGrew && cGrew) {
            entries.push({
                severity: 'warning', kind: 'memory-behaviour',
                title: 'Heap now grows across the run (baseline did not)',
                baseline: String(baseline.memory.netDelta), candidate: String(candidate.memory.netDelta),
            });
        }
        if (baseline.memory.reclaimed && !candidate.memory.reclaimed) {
            entries.push({
                severity: 'warning', kind: 'memory-behaviour',
                title: 'Heap is no longer reclaimed during the run',
                detail: 'The baseline showed GC/free; this run never decreased.',
            });
        }
        normalized.push('exact heap byte counts (run-to-run variance)');
    }

    // 6. verdict move
    if (baseline.verdict !== candidate.verdict) {
        const worse = /FAILING|PROBLEM/.test(candidate.verdict) && !/FAILING|PROBLEM/.test(baseline.verdict);
        entries.push({
            severity: worse ? 'regression' : 'info', kind: 'verdict',
            title: `Verdict changed`, baseline: baseline.verdict, candidate: candidate.verdict,
        });
    }

    const regressions = entries.filter((e) => e.severity === 'regression');
    const warnings = entries.filter((e) => e.severity === 'warning');
    const outcome: BehavioralDiff['outcome'] =
        regressions.length ? 'REGRESSION' : (warnings.length ? 'CHANGED' : 'EQUIVALENT');
    const summary =
        outcome === 'REGRESSION'
            ? `${regressions.length} regression(s) and ${warnings.length} change(s) in runtime behaviour.`
            : outcome === 'CHANGED'
              ? `${warnings.length} behavioural change(s), no regressions detected.`
              : 'Runtime behaviour is equivalent (differences were noise only).';

    // Stable ordering: regressions first, then warnings, then info.
    const rank = { regression: 0, warning: 1, info: 2 };
    entries.sort((a, b) => rank[a.severity] - rank[b.severity]);

    return {
        outcome, summary,
        baseline: { id: baseline.id, verdict: baseline.verdict, sha: baseline.git?.sha },
        candidate: { id: candidate.id, verdict: candidate.verdict, sha: candidate.git?.sha },
        entries,
        normalized: [...new Set(normalized)],
    };
}

/** Render the diff as markdown for a PR comment / report. */
export function diffMarkdown(d: BehavioralDiff): string {
    const ICON = { regression: '🔴', warning: '🟡', info: '🔵' };
    const L: string[] = [];
    L.push(`## Behavioral diff — ${d.outcome}`, '', d.summary, '');
    L.push(`| | Baseline | Candidate |`, `|---|---|---|`);
    L.push(`| Trace | \`${d.baseline.id}\` | \`${d.candidate.id}\` |`);
    if (d.baseline.sha || d.candidate.sha) L.push(`| Commit | \`${d.baseline.sha ?? '—'}\` | \`${d.candidate.sha ?? '—'}\` |`);
    L.push(`| Verdict | ${d.baseline.verdict} | ${d.candidate.verdict} |`, '');
    if (!d.entries.length) {
        L.push('_No behavioural differences._');
    } else {
        for (const e of d.entries) {
            L.push(`- ${ICON[e.severity]} **${e.title}**`);
            if (e.detail) L.push(`  - ${e.detail}`);
            if (e.where) L.push(`  - where: \`${e.where}\``);
            if (e.baseline !== undefined || e.candidate !== undefined) {
                L.push(`  - baseline: \`${e.baseline ?? '—'}\` → candidate: \`${e.candidate ?? '—'}\``);
            }
        }
    }
    if (d.normalized.length) {
        L.push('', '<details><summary>Ignored as noise</summary>', '');
        for (const nz of d.normalized) L.push(`- ${nz}`);
        L.push('', '</details>');
    }
    return L.join('\n');
}
