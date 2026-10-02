// Zero-dependency JS port of webview-ui/src/callTree.ts, so the MCP server can
// rebuild the Call Map (method-grouped tree, N+1, mutations, mermaid) OUT OF
// PROCESS from the pause log an agent reads — no build step, no import of the
// webview bundle. Keep in sync with callTree.ts if the algorithm changes.

const methodKey = (f) => `${f.name}@${f.source ?? '?'}`;

export function inferLayer(fn, source = '') {
    const s = `${fn} ${source}`.toLowerCase();
    if (/controller|ctrl|router|route|handler/.test(s)) return 'controller';
    if (/repo|repository|accessor|dynamo|dao|\.db|dbutils|query|prisma|knex|sequelize/.test(s)) return 'db';
    if (/service|svc|usecase|manager|helper/.test(s)) return 'service';
    if (/http|fetch|axios|client|gateway|sdk|s3|sns|sqs/.test(s)) return 'external';
    return 'other';
}

const shortV = (s) => (s.length > 22 ? s.slice(0, 22) + '…' : s);

function diffVars(prev, next) {
    if (!prev || !prev.length) return [];
    const m = new Map(prev.map((v) => [v.name, v.value]));
    const out = [];
    for (const v of next) {
        const before = m.get(v.name);
        if (before !== undefined && before !== v.value) out.push({ name: v.name, from: shortV(before), to: shortV(v.value) });
    }
    return out;
}

/** Build the method tree from an ordered list of pause records (from log.ndjson). */
export function buildCallTree(pauses) {
    const roots = [];
    const stack = [];
    let idSeq = 0;
    let prevDepth = 0;
    const reentry = new Map();

    const keyOf = (n) => `${n.fn}@${n.source}`;
    const addStep = (node, frame, p) => {
        node.lastOrder = p.order;
        if (typeof p.heapUsed === 'number') node.heapPeak = Math.max(node.heapPeak ?? 0, p.heapUsed);
        if (p.exception) node.error = p.exception;
        const existing = node.steps.find((s) => s.line === frame.line);
        const prevStep = node.steps[node.steps.length - 1];
        const mutations = diffVars(prevStep?.vars, p.vars);
        if (existing) {
            existing.hit += 1; existing.vars = p.vars; existing.order = p.order; existing.heapUsed = p.heapUsed;
            if (mutations.length) existing.mutations = mutations;
            if (p.exception) existing.error = p.exception;
        } else {
            node.steps.push({ order: p.order, line: frame.line, hit: 1, vars: p.vars, heapUsed: p.heapUsed, mutations: mutations.length ? mutations : undefined, error: p.exception });
        }
        const heaps = node.steps.map((s) => s.heapUsed).filter((h) => typeof h === 'number');
        if (heaps.length >= 2) node.heapDelta = heaps[heaps.length - 1] - heaps[0];
    };

    for (const p of pauses) {
        const frame = p.frame ?? { name: 'step', line: 0 };
        const key = methodKey(frame);
        const cur = stack[stack.length - 1];
        if (cur && keyOf(cur) === key) { addStep(cur, frame, p); prevDepth = p.stackDepth; continue; }
        const deeper = p.stackDepth > prevDepth || stack.length === 0;
        const ancestorIdx = stack.findIndex((n) => keyOf(n) === key);
        if (ancestorIdx !== -1 && !deeper) {
            while (stack.length - 1 > ancestorIdx) { const popped = stack.pop(); popped.dataOut = inferOut(popped); }
            const to = stack[stack.length - 1];
            if (to) addStep(to, frame, p);
            prevDepth = p.stackDepth; continue;
        }
        let parent = cur;
        if (!deeper && stack.length > 0) { const popped = stack.pop(); popped.dataOut = inferOut(popped); parent = stack[stack.length - 1]; }
        const node = {
            id: `cn-${++idSeq}`, fn: frame.name, source: frame.source ?? '?',
            layer: inferLayer(frame.name, frame.source), depth: parent ? parent.depth + 1 : 0,
            steps: [], children: [], parentId: parent?.id, dbCalls: 0, enteredCount: 1,
            asyncBoundary: p.asyncGap, firstOrder: p.order, lastOrder: p.order,
            dataIn: inferIn(p.vars),
        };
        addStep(node, frame, p);
        if (parent) {
            parent.children.push(node);
            if (node.layer === 'db') parent.dbCalls += 1;
            const rk = `${parent.id}:${key}`;
            const count = (reentry.get(rk) ?? 0) + 1; reentry.set(rk, count);
            if (count >= 3 && node.layer === 'db') {
                const sib = parent.children.find((c) => keyOf(c) === key);
                if (sib) { sib.n1 = true; sib.enteredCount = count; }
            }
        } else roots.push(node);
        stack.push(node);
        prevDepth = p.stackDepth;
    }
    return roots;
}

function inferIn(vars) {
    if (!vars || !vars.length) return undefined;
    return vars.slice(0, 2).map((v) => `${v.name}=${shortV(v.value)}`).join(', ');
}
function inferOut(node) {
    const last = node.steps[node.steps.length - 1];
    if (!last || !last.vars.length) return undefined;
    const v = last.vars[last.vars.length - 1];
    return `${v.name}=${shortV(v.value)}`;
}

export function toMermaidSequence(roots) {
    const lines = ['sequenceDiagram'];
    const participants = new Map();
    let pSeq = 0;
    const alias = (n) => { if (!participants.has(n.id)) participants.set(n.id, `P${++pSeq}`); return participants.get(n.id); };
    const declare = [];
    const collect = (n) => { declare.push(n); n.children.forEach(collect); };
    roots.forEach(collect);
    for (const n of declare) lines.push(`    participant ${alias(n)} as ${n.fn}`);
    const emit = (n) => {
        for (const c of n.children) {
            lines.push(`    ${alias(n)}->>${alias(c)}: call${c.dataIn ? ': ' + c.dataIn : ''}`);
            if (c.n1) lines.push(`    Note over ${alias(c)}: ⚠ N+1 ×${c.enteredCount}`);
            if (c.error) lines.push(`    Note over ${alias(c)}: ✗ ${c.error.message}`);
            emit(c);
            lines.push(`    ${alias(c)}-->>${alias(n)}${c.dataOut ? ': ' + c.dataOut : ': return'}`);
        }
    };
    roots.forEach(emit);
    return lines.join('\n');
}

/** Flatten the tree into an agent-friendly summary (layers, N+1, errors, heap). */export function summarizeTree(roots) {
    const flat = [];
    const walk = (n) => {
        flat.push({
            fn: n.fn, layer: n.layer, source: n.source, order: n.firstOrder,
            dbCalls: n.dbCalls, n1: !!n.n1, entered: n.enteredCount,
            error: n.error, heapDeltaBytes: n.heapDelta,
            dataIn: n.dataIn, dataOut: n.dataOut,
            mutations: n.steps.flatMap((s) => s.mutations ?? []),
        });
        n.children.forEach(walk);
    };
    roots.forEach(walk);
    return {
        methods: flat.length,
        n1Suspects: flat.filter((m) => m.n1).map((m) => `${m.fn} (${m.source}) ×${m.entered}`),
        errors: flat.filter((m) => m.error).map((m) => `${m.fn}: ${m.error.type ?? ''} ${m.error.message}`),
        methodList: flat,
    };
}

/**
 * STATE INFERENCE — turn a recorded trace into a diagnosis an agent can act on
 * without further prompting. Returns findings with severity, evidence and a
 * plain-language verdict, so the agent reasons about conclusions rather than
 * re-deriving them from raw pause data every time.
 */
export function inferState(pauses, roots) {
    const findings = [];
    const flat = [];
    const walk = (n, depth = 0) => { flat.push({ n, depth }); n.children.forEach((c) => walk(c, depth + 1)); };
    roots.forEach((r) => walk(r));

    // 1. Exceptions — always the headline.
    for (const { n } of flat) {
        if (n.error) {
            findings.push({
                severity: 'critical', kind: 'exception',
                title: `${n.error.type || 'Exception'} thrown in ${n.fn}`,
                detail: n.error.message,
                where: `${n.source}${n.steps[0] ? ':' + n.steps[n.steps.length - 1].line : ''}`,
                suggestion: 'Trace the inputs on this hop (data-in) — the throw is the primary failure, fix it before anything else.',
            });
        }
    }

    // 2. N+1 — repeated DB call inside a loop. Highest-value performance smell.
    for (const { n } of flat) {
        if (n.n1) {
            findings.push({
                severity: 'high', kind: 'n+1',
                title: `N+1 query: ${n.fn} called ${n.enteredCount}× in a loop`,
                detail: `A DB-layer method was entered ${n.enteredCount} times under the same caller — one query per iteration.`,
                where: n.source,
                suggestion: 'Batch these into a single query (IN / batchGet / join) or hoist the lookup out of the loop.',
            });
        }
    }

    // 3. Unbatched DB fan-out — many DB calls under one method even without a loop.
    for (const { n } of flat) {
        if (!n.n1 && n.dbCalls >= 4) {
            findings.push({
                severity: 'medium', kind: 'db-fanout',
                title: `${n.fn} makes ${n.dbCalls} DB calls`,
                detail: 'A single method fans out to many DB round-trips.',
                where: n.source,
                suggestion: 'Check whether these can be combined or cached; each is a network hop.',
            });
        }
    }

    // 4. Memory — growth without reclaim is the leak signal.
    const heaps = pauses.map((p) => p.heapUsed).filter((h) => typeof h === 'number');
    if (heaps.length >= 2) {
        const first = heaps[0], last = heaps[heaps.length - 1], peak = Math.max(...heaps);
        const reclaimed = heaps.some((h, i) => i > 0 && h < heaps[i - 1]);
        const net = last - first;
        const fmt = (n) => (Math.abs(n) < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
        if (net > 0 && !reclaimed) {
            findings.push({
                severity: 'medium', kind: 'memory',
                title: `Heap grew ${fmt(net)} and was never reclaimed`,
                detail: `heapUsed rose from ${fmt(first)} to ${fmt(last)} (peak ${fmt(peak)}) across ${heaps.length} samples with no decrease.`,
                where: 'process',
                suggestion: 'Possible retention. Check for accumulating arrays/maps or unbounded result sets on this path.',
            });
        }
    }

    // 5. Suspicious mutations — a value overwritten to empty/null mid-flow is a
    //    classic source of "the field vanished" bugs.
    for (const { n } of flat) {
        for (const s of n.steps) {
            for (const m of s.mutations ?? []) {
                if (/^(undefined|null|''|""|\[\]|\{\}|0)$/.test(String(m.to).trim()) && !/^(undefined|null)$/.test(String(m.from).trim())) {
                    findings.push({
                        severity: 'high', kind: 'mutation',
                        title: `${m.name} was cleared (${m.from} → ${m.to}) in ${n.fn}`,
                        detail: 'A populated value became empty/null here — often where data is silently lost.',
                        where: `${n.source}:${s.line}`,
                        suggestion: 'Confirm this reset is intentional; if not, this is likely the defect.',
                    });
                }
            }
        }
    }

    // 6. Coverage warning — a trace too shallow to conclude anything from.
    if (flat.length <= 1) {
        findings.push({
            severity: 'info', kind: 'coverage',
            title: 'Only one method captured',
            detail: 'The trace has a single frame, so cross-layer flow cannot be assessed.',
            where: 'n/a',
            suggestion: 'Add breakpoints deeper (service + DB layer) to see the full request lifecycle.',
        });
    }

    const rank = { critical: 0, high: 1, medium: 2, info: 3 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

    const worst = findings[0]?.severity;
    const verdict =
        worst === 'critical' ? 'FAILING — an exception was thrown on this path.'
        : worst === 'high' ? 'PROBLEM FOUND — a performance or data-integrity issue is present.'
        : worst === 'medium' ? 'SUSPECT — nothing broke, but there are smells worth addressing.'
        : findings.length ? 'LOOKS OK — only informational notes.'
        : 'LOOKS OK — no anomalies detected in this trace.';

    return {
        verdict,
        pausesRecorded: pauses.length,
        methodsCaptured: flat.length,
        layersTouched: [...new Set(flat.map(({ n }) => n.layer))],
        findings,
        // A compact path so the agent can see the shape without the whole tree.
        callPath: flat.map(({ n, depth }) => `${'  '.repeat(depth)}${n.layer.toUpperCase()} ${n.fn} (${n.source})`),
    };
}

/**
 * Out-of-process: assemble a FlowTrace-shaped object and render a markdown
 * report from a recorded pause log. Mirrors src/flowTrace.ts + src/report.ts;
 * keep in sync if the schema changes.
 */
export const FLOWTRACE_SCHEMA_VERSION = 1;

const _fmtBytes = (n) => {
    if (typeof n !== 'number') return '—';
    const a = Math.abs(n);
    if (a < 1024) return `${n} B`;
    if (a < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
};
const _fmtDelta = (n) => (typeof n !== 'number' ? '—' : (n > 0 ? '+' : '') + _fmtBytes(n));

function _flatten(methods, depth = 0, out = []) {
    for (const m of methods) { out.push({ m, depth }); _flatten(m.children ?? [], depth + 1, out); }
    return out;
}

/** Build a FlowTrace from a pause log + built roots + diagnosis. */
export function buildFlowTrace({ pauses, roots, diagnosis, scenario, mockInjection, audit, git, runtime }) {
    const mutations = [];
    const conv = (n) => {
        for (const s of n.steps ?? []) for (const mu of s.mutations ?? []) mutations.push({ ...mu, line: s.line });
        return {
            id: `${n.fn}@${n.source}`, fn: n.fn, source: n.source, layer: n.layer, depth: n.depth,
            dataIn: n.dataIn, dataOut: n.dataOut, dbCalls: n.dbCalls, n1: n.n1,
            enteredCount: n.enteredCount, error: n.error, heapDelta: n.heapDelta,
            firstOrder: n.firstOrder, lastOrder: n.lastOrder,
            children: (n.children ?? []).map(conv),
        };
    };
    const methods = (roots ?? []).map(conv);
    let methodCount = 0, dbCallTotal = 0;
    for (const { m } of _flatten(methods)) { methodCount++; dbCallTotal += m.dbCalls ?? 0; }
    const series = (pauses ?? []).filter((p) => typeof p.heapUsed === 'number').map((p) => ({ order: p.order, heapUsed: p.heapUsed }));
    const used = series.map((s) => s.heapUsed);
    const memory = series.length ? {
        series, peak: Math.max(...used), netDelta: used[used.length - 1] - used[0],
        reclaimed: used.some((h, i) => i > 0 && h < used[i - 1]),
    } : undefined;
    return {
        schemaVersion: FLOWTRACE_SCHEMA_VERSION,
        id: `ft_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        git, runtime,
        scenario: scenario ?? { name: 'recorded run', dbMode: 'real' },
        mockInjection, calls: [], methods,
        findings: diagnosis?.findings ?? [], verdict: diagnosis?.verdict ?? 'UNKNOWN',
        memory, mutations, audit, redaction: { on: true },
        stats: { methodCount, pauseCount: (pauses ?? []).length, dbCallTotal },
    };
}

/** Render the markdown report (same sections as src/report.ts). */
export function reportMarkdown(t) {
    const ICON = { critical: '✗', high: '⚠', medium: '▲', info: 'ℹ' };
    const L = [];
    L.push(`# Test report — ${t.scenario.name}`, '', `**Verdict:** ${t.verdict}`, '');
    L.push('| | |', '|---|---|');
    L.push(`| Run at | ${t.createdAt} |`);
    if (t.git?.sha) L.push(`| Commit | \`${t.git.sha}\`${t.git.branch ? ` (${t.git.branch})` : ''} |`);
    L.push(`| DB mode | ${t.scenario.dbMode} |`);
    L.push(`| Methods captured | ${t.stats.methodCount} |`);
    L.push(`| Debugger pauses | ${t.stats.pauseCount} |`);
    L.push(`| DB calls | ${t.stats.dbCallTotal} |`, '');

    L.push('## Findings', '');
    if (!t.findings.length) L.push('_No anomalies detected on this path._');
    else for (const f of t.findings) {
        L.push(`### ${ICON[f.severity] ?? ''} ${String(f.severity).toUpperCase()} — ${f.title}`);
        if (f.detail) L.push(f.detail);
        if (f.where) L.push(`- **Where:** \`${f.where}\``);
        if (f.suggestion) L.push(`- **Suggestion:** ${f.suggestion}`);
        L.push('');
    }
    L.push('', '## Call map', '', '```');
    for (const { m, depth } of _flatten(t.methods)) {
        const tags = [m.dbCalls ? `${m.dbCalls} DB` : '', m.n1 ? `N+1 x${m.enteredCount}` : '',
            m.error ? `ERROR ${m.error.type ?? ''}` : '',
            typeof m.heapDelta === 'number' && m.heapDelta !== 0 ? `heap ${_fmtDelta(m.heapDelta)}` : ''].filter(Boolean).join(' · ');
        L.push(`${'  '.repeat(depth)}${String(m.layer).toUpperCase()} ${m.fn} (${m.source})${tags ? '  [' + tags + ']' : ''}`);
        if (m.dataIn) L.push(`${'  '.repeat(depth)}  in:  ${m.dataIn}`);
        if (m.dataOut) L.push(`${'  '.repeat(depth)}  out: ${m.dataOut}`);
    }
    L.push('```', '');
    L.push('## State changes observed', '');
    if (!t.mutations.length) L.push('_No variable mutations captured._');
    else { L.push('| Variable | From | To | Line |', '|---|---|---|---|');
        for (const m of t.mutations) L.push(`| \`${m.name}\` | ${m.from} | ${m.to} | ${m.line} |`); }
    L.push('', '## Memory', '');
    if (!t.memory) L.push('_No heap samples._');
    else L.push(`- **Peak heap:** ${_fmtBytes(t.memory.peak)}`,
        `- **Net change:** ${_fmtDelta(t.memory.netDelta)}`,
        `- **Reclaimed during run:** ${t.memory.reclaimed ? 'yes (GC observed)' : 'no'}`,
        `- **Samples:** ${t.memory.series.length}`);
    if (t.mockInjection?.results?.length) {
        L.push('', '## Mock injection', '', '| Target | Status |', '|---|---|');
        for (const r of t.mockInjection.results) L.push(`| \`${r.match}\` | ${r.status} |`);
    }
    if (t.audit?.length) {
        L.push('', '## Live edits made during this run', '', '| When | Actor | Action | Target | Before | After |', '|---|---|---|---|---|---|');
        for (const a of t.audit) L.push(`| ${a.at} | ${a.actor} | ${a.action} | \`${a.target ?? ''}\` | ${a.before ?? ''} | ${a.after ?? ''} |`);
    }
    L.push('', '## Sequence diagram', '', '```mermaid', toMermaidSequence(t.methods ?? []), '```', '');
    L.push(`_Generated by API Flow Test Debugger · FlowTrace v${t.schemaVersion} · trace \`${t.id}\`_`);
    return L.join('\n');
}

/** Script-free HTML report (mirrors src/report.ts for the extension/MCP path). */
export function reportHtml(t) {
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
    const sevColor = (s) => ({ critical: '#f87171', high: '#fbbf24', medium: '#94a3b8', info: '#818cf8' }[s] ?? '#94a3b8');
    const findings = (t.findings ?? []).map((f) => `<article class="finding" style="border-left-color:${sevColor(f.severity)}">
      <strong><span style="color:${sevColor(f.severity)}">${esc(String(f.severity).toUpperCase())}</span> · ${esc(f.title)}</strong>
      ${f.detail ? `<p>${esc(f.detail)}</p>` : ''}${f.where ? `<p class="muted">Where: <code>${esc(f.where)}</code></p>` : ''}
      ${f.suggestion ? `<p class="suggestion">→ ${esc(f.suggestion)}</p>` : ''}</article>`).join('');
    const methods = _flatten(t.methods ?? []).map(({ m, depth }) => {
        const tags = [m.dbCalls ? `${m.dbCalls} DB` : '', m.n1 ? `N+1 ×${m.enteredCount}` : '', m.error ? 'ERROR' : '',
            typeof m.heapDelta === 'number' && m.heapDelta !== 0 ? _fmtDelta(m.heapDelta) : ''].filter(Boolean).join(' · ');
        return `<div class="method" style="margin-left:${depth * 18}px"><b>${esc(String(m.layer).toUpperCase())}</b> ${esc(m.fn)}
          <span class="muted">${esc(m.source)}</span>${tags ? `<span class="tag">${esc(tags)}</span>` : ''}
          ${m.dataIn ? `<div class="flow">↓ in: ${esc(m.dataIn)}</div>` : ''}${m.dataOut ? `<div class="flow out">↑ out: ${esc(m.dataOut)}</div>` : ''}</div>`;
    }).join('');
    const mutations = (t.mutations ?? []).length
        ? `<table><thead><tr><th>Variable</th><th>From</th><th>To</th><th>Line</th></tr></thead><tbody>${t.mutations.map((m) =>
            `<tr><td><code>${esc(m.name)}</code></td><td class="from">${esc(m.from)}</td><td class="to">${esc(m.to)}</td><td>${esc(m.line)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No variable mutations captured.</p>';
    const memory = t.memory
        ? `<ul><li>Peak: <b>${_fmtBytes(t.memory.peak)}</b></li><li>Net: <b>${_fmtDelta(t.memory.netDelta)}</b></li><li>Reclaimed: <b>${t.memory.reclaimed ? 'yes' : 'no'}</b></li><li>Samples: ${t.memory.series.length}</li></ul>`
        : '<p class="muted">No memory samples captured.</p>';
    const calls = (t.calls ?? []).length ? `<h2>Requests</h2><table><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Pauses</th></tr></thead><tbody>${t.calls.map((c) =>
        `<tr><td>${esc(c.request.method)}</td><td><code>${esc(c.request.url)}</code></td><td>${esc(c.response.status ?? 'ERR')}</td><td>${esc(c.response.durationMs ?? '—')}ms</td><td>${esc(c.pauseCount)}</td></tr>`).join('')}</tbody></table>` : '';

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runtime report — ${esc(t.scenario.name)}</title><style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0f1e;color:#e2e8f0;margin:0;padding:32px}.wrap{max-width:900px;margin:auto}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 10px;color:#a5b4fc}.verdict{display:inline-block;font-weight:700;padding:7px 14px;border-radius:6px;background:#818cf826;border:1px solid #818cf866;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #ffffff1a;padding:7px 10px;text-align:left}th,.muted{color:#94a3b8}code{font-family:ui-monospace,monospace;background:#ffffff14;padding:1px 5px;border-radius:3px}.finding{background:#111726;border:1px solid #ffffff14;border-left-width:4px;border-radius:6px;padding:12px 14px;margin:10px 0}.finding p{margin:5px 0}.suggestion,.to{color:#34d399}.from{text-decoration:line-through;color:#94a3b8}.method{font:12.5px ui-monospace,monospace;padding:5px 10px;border-left:2px solid #ffffff1a}.tag{font-size:11px;color:#fbbf24;margin-left:8px}.flow{color:#94a3b8;padding-left:12px}.flow.out{color:#fbbf24}pre{white-space:pre-wrap;background:#070a12;border:1px solid #ffffff1a;padding:12px;border-radius:6px;overflow:auto}
</style></head><body><main class="wrap"><h1>Runtime report — ${esc(t.scenario.name)}</h1><div class="verdict">${esc(t.verdict)}</div>
<table><tbody><tr><th>Run at</th><td>${esc(t.createdAt)}</td></tr><tr><th>DB mode</th><td>${esc(t.scenario.dbMode)}</td></tr><tr><th>Methods / pauses / DB calls</th><td>${esc(t.stats.methodCount)} / ${esc(t.stats.pauseCount)} / ${esc(t.stats.dbCallTotal)}</td></tr><tr><th>Secrets redacted</th><td>${t.redaction?.on ? 'yes' : 'NO'}</td></tr></tbody></table>
${calls}<h2>Findings</h2>${findings || '<p class="muted">No anomalies detected on this path.</p>'}<h2>Call map</h2>${methods || '<p class="muted">No methods captured.</p>'}<h2>State changes</h2>${mutations}<h2>Memory</h2>${memory}<h2>Sequence diagram (Mermaid)</h2><pre>${esc(toMermaidSequence(t.methods ?? []))}</pre><p class="muted">Generated by API Flow Test Debugger · FlowTrace v${esc(t.schemaVersion)} · trace <code>${esc(t.id)}</code></p></main></body></html>`;
}

/* ---------------- behavioral diff (zero-dep port of src/behavioralDiff.ts) ---------------- */

const _UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const _ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const _EPOCH = /\b1[6-9]\d{11}\b/g;
const _TRACE = /\b[A-Za-z-]*(?:TraceId|RequestId|requestID)@?[A-Za-z0-9-]{6,}\b/g;
const _HEX = /\b[0-9a-f]{16,}\b/gi;

export function normalizeValue(v) {
    return String(v).replace(_UUID, '<uuid>').replace(_ISO, '<timestamp>')
        .replace(_EPOCH, '<epoch>').replace(_TRACE, '<traceid>').replace(_HEX, '<hex>').trim();
}
const _noiseOnly = (a, b) => a === b || (a != null && b != null && normalizeValue(a) === normalizeValue(b));
const _EMPTYISH = /^(''|""|null|undefined|\[\]|\{\}|0|None)$/;

function _flat(ms, out = []) { for (const m of ms ?? []) { out.push(m); _flat(m.children, out); } return out; }

/** Compare two FlowTraces. Same semantics as src/behavioralDiff.ts. */
export function diffTraces(baseline, candidate) {
    const entries = [], normalized = [];
    const bAll = _flat(baseline.methods), cAll = _flat(candidate.methods);
    const bById = new Map(bAll.map((m) => [m.id, m])), cById = new Map(cAll.map((m) => [m.id, m]));

    for (const m of cAll) if (!bById.has(m.id)) entries.push({ severity: 'warning', kind: 'method-added', title: `New method on this path: ${m.fn}`, where: m.source });
    for (const m of bAll) if (!cById.has(m.id)) entries.push({ severity: 'warning', kind: 'method-removed', title: `Method no longer called: ${m.fn}`, where: m.source });

    for (const [id, c] of cById) {
        const b = bById.get(id); if (!b) continue;
        if (b.dbCalls !== c.dbCalls) entries.push({ severity: c.dbCalls > b.dbCalls ? 'regression' : 'info', kind: 'db-calls-changed',
            title: `${c.fn} makes ${c.dbCalls} DB call(s) (was ${b.dbCalls})`, where: c.source, baseline: String(b.dbCalls), candidate: String(c.dbCalls) });
        if (c.n1 && !b.n1) entries.push({ severity: 'regression', kind: 'new-n-plus-one', title: `New N+1: ${c.fn} called ${c.enteredCount}x in a loop`, where: c.source });
        if (c.error && !b.error) entries.push({ severity: 'regression', kind: 'new-exception', title: `New exception in ${c.fn}: ${c.error.type ?? 'Error'}`, detail: c.error.message, where: c.source });
        if (b.error && !c.error) entries.push({ severity: 'info', kind: 'exception-resolved', title: `Exception no longer thrown in ${c.fn}`, where: c.source });
    }

    const key = (m) => `${m.name}@${m.line}`;
    const bMut = new Map((baseline.mutations ?? []).map((m) => [key(m), m]));
    for (const c of (candidate.mutations ?? [])) {
        const b = bMut.get(key(c));
        if (!b) {
            if (_EMPTYISH.test(String(c.to).trim()) && !_EMPTYISH.test(String(c.from).trim()))
                entries.push({ severity: 'regression', kind: 'state-cleared', title: `${c.name} is now cleared (${c.from} → ${c.to})`, where: `line ${c.line}` });
            continue;
        }
        if (_noiseOnly(b.to, c.to) && _noiseOnly(b.from, c.from)) {
            if (b.to !== c.to) normalized.push(`${c.name}@${c.line}: value differs only by noise`);
            continue;
        }
        entries.push({ severity: 'warning', kind: 'mutation-changed', title: `${c.name} now transitions ${c.from} → ${c.to}`, where: `line ${c.line}`, baseline: `${b.from} → ${b.to}`, candidate: `${c.from} → ${c.to}` });
    }

    const n = Math.max((baseline.calls ?? []).length, (candidate.calls ?? []).length);
    for (let i = 0; i < n; i++) {
        const b = baseline.calls?.[i], c = candidate.calls?.[i];
        if (!b || !c) continue;
        if (b.response.status !== c.response.status)
            entries.push({ severity: (c.response.status ?? 500) >= 400 && (b.response.status ?? 0) < 400 ? 'regression' : 'warning',
                kind: 'response-status', title: `${c.request.method} response status ${c.response.status} (was ${b.response.status})`, where: c.request.url });
    }

    if (baseline.memory && candidate.memory) {
        if (!((baseline.memory.netDelta ?? 0) > 0) && (candidate.memory.netDelta ?? 0) > 0)
            entries.push({ severity: 'warning', kind: 'memory-behaviour', title: 'Heap now grows across the run (baseline did not)' });
        if (baseline.memory.reclaimed && !candidate.memory.reclaimed)
            entries.push({ severity: 'warning', kind: 'memory-behaviour', title: 'Heap is no longer reclaimed during the run' });
        normalized.push('exact heap byte counts (run-to-run variance)');
    }

    if (baseline.verdict !== candidate.verdict) {
        const worse = /FAILING|PROBLEM/.test(candidate.verdict) && !/FAILING|PROBLEM/.test(baseline.verdict);
        entries.push({ severity: worse ? 'regression' : 'info', kind: 'verdict', title: 'Verdict changed', baseline: baseline.verdict, candidate: candidate.verdict });
    }

    const regressions = entries.filter((e) => e.severity === 'regression');
    const warnings = entries.filter((e) => e.severity === 'warning');
    const outcome = regressions.length ? 'REGRESSION' : warnings.length ? 'CHANGED' : 'EQUIVALENT';
    const rank = { regression: 0, warning: 1, info: 2 };
    entries.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return {
        outcome,
        summary: outcome === 'REGRESSION' ? `${regressions.length} regression(s) and ${warnings.length} change(s) in runtime behaviour.`
            : outcome === 'CHANGED' ? `${warnings.length} behavioural change(s), no regressions detected.`
            : 'Runtime behaviour is equivalent (differences were noise only).',
        baseline: { id: baseline.id, verdict: baseline.verdict, sha: baseline.git?.sha },
        candidate: { id: candidate.id, verdict: candidate.verdict, sha: candidate.git?.sha },
        entries, normalized: [...new Set(normalized)],
    };
}

export function diffMarkdown(d) {
    const ICON = { regression: '🔴', warning: '🟡', info: '🔵' };
    const L = [`## Behavioral diff — ${d.outcome}`, '', d.summary, ''];
    L.push('| | Baseline | Candidate |', '|---|---|---|');
    L.push(`| Trace | \`${d.baseline.id}\` | \`${d.candidate.id}\` |`);
    L.push(`| Verdict | ${d.baseline.verdict} | ${d.candidate.verdict} |`, '');
    if (!d.entries.length) L.push('_No behavioural differences._');
    else for (const e of d.entries) {
        L.push(`- ${ICON[e.severity]} **${e.title}**`);
        if (e.detail) L.push(`  - ${e.detail}`);
        if (e.where) L.push(`  - where: \`${e.where}\``);
        if (e.baseline !== undefined || e.candidate !== undefined) L.push(`  - baseline: \`${e.baseline ?? '—'}\` → candidate: \`${e.candidate ?? '—'}\``);
    }
    if (d.normalized.length) { L.push('', '<details><summary>Ignored as noise</summary>', ''); for (const nz of d.normalized) L.push(`- ${nz}`); L.push('', '</details>'); }
    return L.join('\n');
}

/* ---------------- behavior contracts (zero-dep) ---------------- */

const _CEMPTY = /^(''|""|null|undefined|\[\]|\{\}|0|None)$/;
const _cflat = (ms, out = []) => { for (const m of ms ?? []) { out.push(m); _cflat(m.children, out); } return out; };
const _cmatch = (ref, m) => ref === m.id || ref === m.fn || (ref.includes('.') && ref.split('.').pop() === m.fn);

export function createContract(trace, opts = {}) {
    const all = _cflat(trace.methods);
    const maxCalls = {};
    for (const m of all) if (m.dbCalls > 0) maxCalls[m.id] = m.dbCalls;
    const cleared = new Set((trace.mutations ?? []).filter((m) => _CEMPTY.test(String(m.to).trim())).map((m) => m.name));
    const neverClear = [...new Set((trace.mutations ?? []).map((m) => m.name).filter((n) => !cleared.has(n)))];
    const a = {
        noUncaughtExceptions: true,
        mustCall: all.filter((m) => m.layer === 'controller' || m.layer === 'service').map((m) => m.id),
    };
    if (Object.keys(maxCalls).length) a.maxCalls = maxCalls;
    if (neverClear.length) a.neverClear = neverClear;
    if (trace.scenario?.dbMode === 'mocked') a.mocksMustInject = true;
    if (trace.stats?.dbCallTotal) a.maxTotalDbCalls = trace.stats.dbCallTotal;
    if (typeof trace.calls?.[0]?.response?.status === 'number') a['response.status'] = trace.calls[0].response.status;
    if (trace.memory?.reclaimed) a.memoryMustReclaim = true;
    return { scenario: opts.scenario ?? trace.scenario?.name ?? 'unnamed', assert: a };
}

export function verifyContract(contract, trace) {
    const v = [], ok = [], all = _cflat(trace.methods), a = contract.assert || {};
    let checked = 0;
    if (typeof a['response.status'] === 'number') {
        checked++; const actual = trace.calls?.[0]?.response?.status ?? null;
        if (actual !== a['response.status']) v.push({ rule: 'response.status', expected: String(a['response.status']), actual: String(actual) });
        else ok.push(`response.status = ${actual}`);
    }
    if (a.noUncaughtExceptions) {
        checked++; const thrown = all.filter((m) => m.error);
        if (thrown.length) for (const m of thrown) v.push({ rule: 'noUncaughtExceptions', expected: 'no exception', actual: `${m.error.type ?? 'Error'}: ${m.error.message}`, where: m.source, hint: 'An exception was thrown on this path.' });
        else ok.push('no uncaught exceptions');
    }
    for (const ref of a.mustCall ?? []) { checked++; if (!all.some((m) => _cmatch(ref, m))) v.push({ rule: 'mustCall', expected: `${ref} is called`, actual: 'not called', hint: 'Path changed, or no breakpoint covers it (coverage gap).' }); else ok.push(`mustCall ${ref}`); }
    for (const ref of a.mustNotCall ?? []) { checked++; const hit = all.find((m) => _cmatch(ref, m)); if (hit) v.push({ rule: 'mustNotCall', expected: `${ref} NOT called`, actual: 'was called', where: hit.source }); else ok.push(`mustNotCall ${ref}`); }
    for (const [ref, limit] of Object.entries(a.maxCalls ?? {})) {
        checked++; const hits = all.filter((m) => _cmatch(ref, m));
        const count = hits.reduce((n, m) => n + Math.max(m.dbCalls, m.enteredCount > 1 ? m.enteredCount : 0), 0);
        if (count > limit) v.push({ rule: 'maxCalls', expected: `${ref} <= ${limit}`, actual: String(count), where: hits[0]?.source, hint: 'Often an N+1 introduced by a loop.' }); else ok.push(`maxCalls ${ref}`);
    }
    for (const [name, allowed] of Object.entries(a.allowedTransitions ?? {})) {
        checked++; const bad = (trace.mutations ?? []).filter((m) => m.name === name && !allowed.map(String).includes(String(m.to).replace(/^['"]|['"]$/g, '')));
        if (bad.length) v.push({ rule: 'allowedTransitions', expected: `${name} in [${allowed.join(', ')}]`, actual: bad.map((b) => b.to).join(', '), where: `line ${bad[0].line}` }); else ok.push(`allowedTransitions ${name}`);
    }
    for (const name of a.neverClear ?? []) {
        checked++; const c = (trace.mutations ?? []).find((m) => m.name === name && _CEMPTY.test(String(m.to).trim()) && !_CEMPTY.test(String(m.from).trim()));
        if (c) v.push({ rule: 'neverClear', expected: `${name} never cleared`, actual: `${c.from} -> ${c.to}`, where: `line ${c.line}`, hint: 'Silent data loss.' }); else ok.push(`neverClear ${name}`);
    }
    if (a.mocksMustInject) {
        checked++; const res = trace.mockInjection?.results ?? [], failed = res.filter((r) => r.status !== 'ok');
        if (!res.length) v.push({ rule: 'mocksMustInject', expected: 'mocks injected', actual: 'none declared', hint: 'Run was NOT isolated.' });
        else if (failed.length) v.push({ rule: 'mocksMustInject', expected: 'all injected', actual: `${failed.length} failed: ${failed.map((f) => f.match).join(', ')}`, hint: 'Those calls hit the real dependency.' });
        else ok.push('mocksMustInject');
    }
    if (a.memoryMustReclaim) { checked++; if (trace.memory && trace.memory.reclaimed === false) v.push({ rule: 'memoryMustReclaim', expected: 'heap reclaimed', actual: 'never decreased' }); else ok.push('memoryMustReclaim'); }
    if (typeof a.maxTotalDbCalls === 'number') { checked++; if ((trace.stats?.dbCallTotal ?? 0) > a.maxTotalDbCalls) v.push({ rule: 'maxTotalDbCalls', expected: `<= ${a.maxTotalDbCalls}`, actual: String(trace.stats.dbCallTotal) }); else ok.push('maxTotalDbCalls'); }
    return { pass: v.length === 0, scenario: contract.scenario, checked, violations: v, satisfied: ok };
}

export function contractToYaml(c) {
    const a = c.assert || {}, L = [`scenario: ${c.scenario}`, 'assert:'];
    for (const k of ['response.status', 'noUncaughtExceptions', 'mocksMustInject', 'memoryMustReclaim', 'maxTotalDbCalls'])
        if (a[k] !== undefined) L.push(`  ${k}: ${a[k]}`);
    for (const k of ['mustCall', 'mustNotCall', 'neverClear'])
        if (a[k]?.length) { L.push(`  ${k}:`); for (const x of a[k]) L.push(`    - ${x}`); }
    if (a.maxCalls) { L.push('  maxCalls:'); for (const [k, n] of Object.entries(a.maxCalls)) L.push(`    ${JSON.stringify(k)}: ${n}`); }
    if (a.allowedTransitions) { L.push('  allowedTransitions:'); for (const [k, vals] of Object.entries(a.allowedTransitions)) L.push(`    ${JSON.stringify(k)}: [${vals.join(', ')}]`); }
    return L.join('\n') + '\n';
}

export function parseContract(text) {
    const t = String(text).trim();
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
            a[mapKey][key] = val.startsWith('[') ? val.slice(1, -1).split(',').map((s) => num(s.trim().replace(/^['"]|['"]$/g, ''))) : num(val);
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

export function explainResult(r) {
    if (r.pass) return `Contract "${r.scenario}" PASSED — ${r.checked} rule(s) satisfied.`;
    const L = [`Contract "${r.scenario}" FAILED — ${r.violations.length} of ${r.checked} rule(s) violated.`, ''];
    for (const v of r.violations) {
        L.push(`- ${v.rule}`, `  - expected: ${v.expected}`, `  - actual:   ${v.actual}`);
        if (v.where) L.push(`  - where:    ${v.where}`);
        if (v.hint) L.push(`  - ${v.hint}`);
    }
    return L.join('\n');
}

/* ---------------- easy-start: debug-status surface (zero-dep pure helpers) ----------------
 *
 * These helpers are the SINGLE SOURCE for the self-reporting status surface
 * (design §4). They are pure (no `vscode`, no file I/O) so the MCP server
 * (mcp/flow-mcp.mjs), the extension host (via SessionManager in
 * src/sessionManager.ts, which imports projectSessionStatus from here), and the
 * unit tests (verify/session-status.test.mjs) all share one implementation and
 * the SAME freshness constants. If any of this logic is also needed in src/*.ts,
 * mirror it with a "keep in sync with mcp/callmap.mjs" comment — do NOT fork it.
 *
 * The status model answers a different question from get_pause_state's pause-age
 * model: "is the STATUS FILE fresh?" (heartbeat age) vs "is this PAUSE fresh?"
 * (pause age, 120000ms, inline in flow-mcp.mjs). The two are deliberately
 * distinct constants (design §4.4). */

/** Status-file heartbeat write cadence (ms): SessionManager rewrites session.json this often while live. */
export const HEARTBEAT_MS = 5000;
/** Status-file staleness threshold (ms): = 2× heartbeat + margin. Older => the host likely crashed. */
export const STALE_MS = 15000;

/** Coerce an unknown value to a finite number, else null (defensive read of an on-disk, possibly-edited file). */
function _num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Evaluate a (possibly stale, possibly hand-edited) session.json object into a
 * crisp status an agent can act on WITHOUT interpreting raw fields (design §4.4,
 * §4.5). Returns { live, stale, staleReason?, verdict, ...identity }.
 *
 * The four base verdicts are mutually exclusive on the DRIVEN session's state:
 *   NOT RUNNING / RUNNING, NOT PAUSED / RUNNING, PAUSED at thread N / STALE …
 * When a NON-driven session is paused (otherSessions[i].paused), a hint clause is
 * appended pointing at use_session (design §4.5, finding #4) — purely additive
 * text; the base classification stays driven-only.
 *
 * Every field is treated as untrusted: `live`/`paused` must be strictly `true`;
 * numeric fields pass through only if finite (else null); `portSource` only if it
 * is one of the two known labels; `otherSessions` truncated to 10 (design §6).
 */
export function evaluateDebugStatus(status, nowMs) {
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

    // Absent / unreadable file ⇒ unambiguous NOT RUNNING (design §4.5, A10).
    if (!status || typeof status !== 'object') {
        return { live: false, stale: false, verdict: 'NOT RUNNING — no debug session has been started.', otherSessions: [] };
    }

    const live = status.live === true;
    const paused = status.paused === true;
    const pausedThreadId = _num(status.pausedThreadId);
    const port = _num(status.port);
    const pid = _num(status.pid);
    const portSource = (status.portSource === 'config' || status.portSource === 'debugPort(approx)')
        ? status.portSource : null;

    // Normalize otherSessions defensively (array, capped at 10, strict paused flag).
    const otherSessions = Array.isArray(status.otherSessions)
        ? status.otherSessions.slice(0, 10).map((o) => ({
              sessionId: typeof o?.sessionId === 'string' ? o.sessionId : null,
              name: typeof o?.name === 'string' ? o.name : null,
              type: typeof o?.type === 'string' ? o.type : null,
              paused: o?.paused === true,
          }))
        : [];
    const anyOtherPaused = otherSessions.some((o) => o.paused === true);

    // Freshness: a crashed host may leave live:true but stop heartbeating.
    const heartbeat = Date.parse(status.lastHeartbeatAt);
    const heartbeatAgeMs = Number.isFinite(heartbeat) ? now - heartbeat : null;
    let stale = false;
    let staleReason;
    if (!live) {
        // Not live at all — not "stale", just not running.
    } else if (heartbeatAgeMs === null) {
        stale = true;
        staleReason = 'the status file has no valid heartbeat timestamp — the debugger may have crashed.';
    } else if (heartbeatAgeMs > STALE_MS) {
        stale = true;
        staleReason = `the last heartbeat was ${Math.round(heartbeatAgeMs / 1000)}s ago — the debugger may have crashed. Restart it.`;
    }

    const identity = {
        sessionId: typeof status.sessionId === 'string' ? status.sessionId : null,
        name: typeof status.name === 'string' ? status.name : null,
        configName: typeof status.configName === 'string' ? status.configName : null,
        type: typeof status.type === 'string' ? status.type : null,
        port, portSource, pid,
        paused, pausedThreadId,
        startedBy: (status.startedBy === 'agent' || status.startedBy === 'human') ? status.startedBy : null,
        startedAt: typeof status.startedAt === 'string' ? status.startedAt : null,
        lastPauseAt: typeof status.lastPauseAt === 'string' ? status.lastPauseAt : null,
        lastHeartbeatAt: typeof status.lastHeartbeatAt === 'string' ? status.lastHeartbeatAt : null,
        otherSessions,
    };

    // Verdict (mutually exclusive on the driven session):
    let verdict;
    if (!live) {
        verdict = 'NOT RUNNING — no debug session is currently live.';
    } else if (stale) {
        verdict = `STALE — ${staleReason}`;
    } else if (paused) {
        verdict = `RUNNING, PAUSED at thread ${pausedThreadId ?? '?'}`;
    } else {
        verdict = 'RUNNING, NOT PAUSED';
    }
    // Non-driven-paused hint (additive, design §4.5 finding #4): only when the
    // driven session itself is live and not stale (so the base verdict is one of
    // RUNNING, …) and some other session is paused.
    if (live && !stale && anyOtherPaused) {
        verdict += ' (note: a non-driven session is paused; call use_session with its sessionId from otherSessions to drive it)';
    }

    return {
        live: live && !stale,
        stale,
        ...(staleReason ? { staleReason } : {}),
        verdict,
        ...identity,
    };
}

/**
 * Build the session.json object from PLAIN inputs (no `vscode`), so the exact
 * serialization shape is single-sourced and unit-testable. Called by
 * SessionManager.touch() (src/sessionManager.ts) and by the round-trip test.
 *
 * `driven` is a plain projection of the driven DrivenState (or null/undefined
 * when nothing is driven); `otherSessions` is the live-but-not-driven list.
 * `nowIso` is the heartbeat/serialization timestamp.
 */
export function projectSessionStatus(driven, otherSessions, nowIso) {
    const now = typeof nowIso === 'string' ? nowIso : new Date().toISOString();
    const others = Array.isArray(otherSessions)
        ? otherSessions.slice(0, 10).map((o) => ({
              sessionId: o?.sessionId ?? null,
              name: o?.name ?? null,
              type: o?.type ?? null,
              paused: o?.paused === true,
          }))
        : [];
    if (!driven) {
        return {
            live: false,
            sessionId: null,
            name: null,
            configName: null,
            type: null,
            port: null,
            portSource: null,
            pid: null,
            paused: false,
            pausedThreadId: null,
            startedBy: null,
            startedAt: null,
            lastPauseAt: null,
            lastHeartbeatAt: now,
            otherSessions: others,
            ...(Array.isArray(otherSessions) && otherSessions.length > 10 ? { otherSessionsTruncated: true } : {}),
        };
    }
    return {
        live: true,
        sessionId: driven.sessionId ?? null,
        name: driven.name ?? null,
        configName: driven.configName ?? null,
        type: driven.type ?? null,
        port: _num(driven.port),
        portSource: (driven.portSource === 'config' || driven.portSource === 'debugPort(approx)') ? driven.portSource : null,
        pid: _num(driven.pid),
        paused: driven.pausedThreadId !== undefined && driven.pausedThreadId !== null,
        pausedThreadId: _num(driven.pausedThreadId),
        startedBy: (driven.startedBy === 'agent' || driven.startedBy === 'human') ? driven.startedBy : null,
        startedAt: driven.startedAt ?? null,
        lastPauseAt: driven.lastPauseAt ?? null,
        lastHeartbeatAt: now,
        otherSessions: others,
        ...(Array.isArray(otherSessions) && otherSessions.length > 10 ? { otherSessionsTruncated: true } : {}),
    };
}

/**
 * The plain object PauseBridge.writeNeutral() serializes to latest.json on a
 * driven-session SWITCH or terminate-promotion where the newly driven session is
 * not currently paused (design §2.3). Keeping it pure here lets the identity-
 * reconciliation invariant (session.json.sessionId == latest.json.sessionId) be
 * unit-tested without a VS Code host.
 */
export function neutralPause(sessionId) {
    return {
        sessionId: sessionId ?? null,
        waiting: false,
        sessionEnded: false,
        note: 'driven session switched; no pause captured yet',
    };
}

/**
 * Filter parsed log.ndjson records to the DRIVEN session (design §2.3 finding #2).
 * `lines` are the already-parsed pause records (each may carry a `sessionId`).
 * Returns { pauses, belongsToDriven }:
 *   - pauses: only lines whose sessionId equals drivenId, PLUS lines with no
 *     sessionId at all (written by an older extension — treated as the driven
 *     session's, for backward compatibility).
 *   - belongsToDriven: true iff at least one surviving line is attributable to the
 *     driven session (so the call-map tools can emit "no trace for the driven
 *     session yet" when the log holds only OTHER sessions' lines).
 *
 * When drivenId is null/undefined (no session.json, older extension), every line
 * is kept and belongsToDriven reflects whether any lines exist — the old
 * behaviour, unchanged.
 */
export function filterLogBySession(lines, drivenId) {
    const all = Array.isArray(lines) ? lines : [];
    if (drivenId === null || drivenId === undefined) {
        return { pauses: all, belongsToDriven: all.length > 0 };
    }
    const pauses = [];
    let belongsToDriven = false;
    for (const line of all) {
        const sid = line && typeof line === 'object' ? line.sessionId : undefined;
        if (sid === undefined || sid === null) {
            // Unattributed (older extension) — belongs to the driven session.
            pauses.push(line);
            belongsToDriven = true;
        } else if (sid === drivenId) {
            pauses.push(line);
            belongsToDriven = true;
        }
        // else: a different session's line — dropped.
    }
    return { pauses, belongsToDriven };
}
