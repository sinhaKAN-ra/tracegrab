/**
 * Test report generation. Turns a FlowTrace into a shareable report of what
 * was tested and what happened, with every stat captured: findings, call map,
 * variables + mutations, memory, mock-injection status, live-edit audit.
 *
 * Markdown for a ticket/PR; self-contained HTML for sharing or printing to PDF.
 * Pure + dependency-free so the MCP server can generate reports too.
 */

import type { FlowTrace, TraceMethod } from './flowTrace.js';

const SEV_ICON: Record<string, string> = {
    critical: '✗', high: '⚠', medium: '▲', info: 'ℹ',
};

function fmtBytes(n?: number): string {
    if (typeof n !== 'number') return '—';
    const a = Math.abs(n);
    if (a < 1024) return `${n} B`;
    if (a < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}
function fmtDelta(n?: number): string {
    if (typeof n !== 'number') return '—';
    return (n > 0 ? '+' : '') + fmtBytes(n);
}
function esc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Flatten the method tree into indented lines for the call-map section. */
function flatten(methods: TraceMethod[], depth = 0, out: Array<{ m: TraceMethod; depth: number }> = []) {
    for (const m of methods) {
        out.push({ m, depth });
        flatten(m.children, depth + 1, out);
    }
    return out;
}

/** Mermaid sequence diagram of the call flow, for embedding in the report. */
export function traceToMermaid(t: FlowTrace): string {
    const lines = ['sequenceDiagram'];
    const alias = new Map<string, string>();
    let i = 0;
    for (const { m } of flatten(t.methods)) {
        if (!alias.has(m.id)) { alias.set(m.id, `P${++i}`); lines.push(`    participant ${alias.get(m.id)} as ${m.fn}`); }
    }
    const emit = (m: TraceMethod) => {
        for (const c of m.children) {
            lines.push(`    ${alias.get(m.id)}->>${alias.get(c.id)}: call${c.dataIn ? ': ' + c.dataIn : ''}`);
            if (c.n1) lines.push(`    Note over ${alias.get(c.id)}: N+1 x${c.enteredCount}`);
            if (c.error) lines.push(`    Note over ${alias.get(c.id)}: ERROR ${c.error.message}`);
            emit(c);
            lines.push(`    ${alias.get(c.id)}-->>${alias.get(m.id)}${c.dataOut ? ': ' + c.dataOut : ': return'}`);
        }
    };
    t.methods.forEach(emit);
    return lines.join('\n');
}

/** ---------------- Markdown ---------------- */
export function reportMarkdown(t: FlowTrace): string {
    const L: string[] = [];
    L.push(`# Test report — ${t.scenario.name}`);
    L.push('');
    L.push(`**Verdict:** ${t.verdict}`);
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push(`| Run at | ${t.createdAt} |`);
    if (t.git?.sha) L.push(`| Commit | \`${t.git.sha}\`${t.git.branch ? ` (${t.git.branch})` : ''}${t.git.dirty ? ' — dirty' : ''} |`);
    if (t.runtime?.language) L.push(`| Runtime | ${t.runtime.language}${t.runtime.adapter ? ` / ${t.runtime.adapter}` : ''} |`);
    L.push(`| DB mode | ${t.scenario.dbMode}${t.scenario.strictMocks ? ' (strict)' : ''} |`);
    L.push(`| Methods captured | ${t.stats.methodCount} |`);
    L.push(`| Debugger pauses | ${t.stats.pauseCount} |`);
    L.push(`| DB calls | ${t.stats.dbCallTotal} |`);
    L.push(`| Secrets redacted | ${t.redaction.on ? 'yes' : 'NO'} |`);
    L.push('');

    // Requests
    if (t.calls.length) {
        L.push('## Requests');
        L.push('');
        L.push('| Method | URL | Status | Duration | Pauses |');
        L.push('|---|---|---|---|---|');
        for (const c of t.calls) {
            L.push(`| ${c.request.method} | \`${c.request.url}\` | ${c.response.status ?? 'ERR'} | ${c.response.durationMs ?? '—'}ms | ${c.pauseCount} |`);
        }
        L.push('');
    }

    // Findings
    L.push('## Findings');
    L.push('');
    if (!t.findings.length) {
        L.push('_No anomalies detected on this path._');
    } else {
        for (const f of t.findings) {
            L.push(`### ${SEV_ICON[f.severity] ?? ''} ${f.severity.toUpperCase()} — ${f.title}`);
            if (f.detail) L.push(f.detail);
            if (f.where) L.push(`- **Where:** \`${f.where}\``);
            if (f.suggestion) L.push(`- **Suggestion:** ${f.suggestion}`);
            L.push('');
        }
    }
    L.push('');

    // Call map
    L.push('## Call map');
    L.push('');
    L.push('```');
    for (const { m, depth } of flatten(t.methods)) {
        const tags = [
            m.dbCalls ? `${m.dbCalls} DB` : '',
            m.n1 ? `N+1 x${m.enteredCount}` : '',
            m.error ? `ERROR ${m.error.type ?? ''}` : '',
            typeof m.heapDelta === 'number' && m.heapDelta !== 0 ? `heap ${fmtDelta(m.heapDelta)}` : '',
        ].filter(Boolean).join(' · ');
        L.push(`${'  '.repeat(depth)}${m.layer.toUpperCase()} ${m.fn} (${m.source})${tags ? '  [' + tags + ']' : ''}`);
        if (m.dataIn) L.push(`${'  '.repeat(depth)}  in:  ${m.dataIn}`);
        if (m.dataOut) L.push(`${'  '.repeat(depth)}  out: ${m.dataOut}`);
    }
    L.push('```');
    L.push('');

    // Mutations
    L.push('## State changes observed');
    L.push('');
    if (!t.mutations.length) {
        L.push('_No variable mutations captured._');
    } else {
        L.push('| Variable | From | To | Line |');
        L.push('|---|---|---|---|');
        for (const m of t.mutations) L.push(`| \`${m.name}\` | ${m.from} | ${m.to} | ${m.line} |`);
    }
    L.push('');

    // Memory
    L.push('## Memory');
    L.push('');
    if (!t.memory) {
        L.push('_No heap samples (non-Node runtime, or sampling unavailable)._');
    } else {
        L.push(`- **Peak heap:** ${fmtBytes(t.memory.peak)}`);
        L.push(`- **Net change:** ${fmtDelta(t.memory.netDelta)}`);
        L.push(`- **Reclaimed during run:** ${t.memory.reclaimed ? 'yes (GC observed)' : 'no'}`);
        L.push(`- **Samples:** ${t.memory.series.length}`);
    }
    L.push('');

    // Mocks
    if (t.mockInjection?.results?.length) {
        L.push('## Mock injection');
        L.push('');
        L.push('| Target | Status |');
        L.push('|---|---|');
        for (const r of t.mockInjection.results) L.push(`| \`${r.match}\` | ${r.status}${r.message ? ` — ${r.message}` : ''} |`);
        L.push('');
    }

    // Audit
    if (t.audit?.length) {
        L.push('## Live edits made during this run');
        L.push('');
        L.push('| When | Actor | Action | Target | Before | After |');
        L.push('|---|---|---|---|---|---|');
        for (const a of t.audit) {
            L.push(`| ${a.at} | ${a.actor} | ${a.action} | \`${a.target ?? ''}\` | ${a.before ?? ''} | ${a.after ?? ''} |`);
        }
        L.push('');
    }

    L.push('## Sequence diagram');
    L.push('');
    L.push('```mermaid');
    L.push(traceToMermaid(t));
    L.push('```');
    L.push('');
    L.push(`_Generated by API Flow Test Debugger · FlowTrace v${t.schemaVersion} · trace \`${t.id}\`_`);
    return L.join('\n');
}

/** ---------------- HTML ---------------- */
export function reportHtml(t: FlowTrace): string {
    const md = reportMarkdown(t);
    const sev = (s: string) => ({ critical: '#f87171', high: '#fbbf24', medium: '#94a3b8', info: '#818cf8' }[s] ?? '#94a3b8');
    const findings = t.findings.map((f) => `
    <div class="f" style="border-left-color:${sev(f.severity)}">
      <div class="fh"><span class="sev" style="color:${sev(f.severity)}">${SEV_ICON[f.severity] ?? ''} ${esc(f.severity)}</span> ${esc(f.title)}</div>
      ${f.detail ? `<p>${esc(f.detail)}</p>` : ''}
      ${f.where ? `<p class="mut">where: <code>${esc(f.where)}</code></p>` : ''}
      ${f.suggestion ? `<p class="sug">→ ${esc(f.suggestion)}</p>` : ''}
    </div>`).join('');

    const tree = flatten(t.methods).map(({ m, depth }) => {
        const tags = [
            m.dbCalls ? `${m.dbCalls} DB` : '',
            m.n1 ? `N+1 ×${m.enteredCount}` : '',
            m.error ? `ERROR` : '',
            typeof m.heapDelta === 'number' && m.heapDelta !== 0 ? fmtDelta(m.heapDelta) : '',
        ].filter(Boolean).join(' · ');
        return `<div class="m" style="margin-left:${depth * 18}px">
          <b>${esc(m.layer.toUpperCase())}</b> ${esc(m.fn)} <span class="mut">${esc(m.source)}</span>
          ${tags ? `<span class="tag">${esc(tags)}</span>` : ''}
          ${m.dataIn ? `<div class="flow">↓ in: ${esc(m.dataIn)}</div>` : ''}
          ${m.dataOut ? `<div class="flow out">↑ out: ${esc(m.dataOut)}</div>` : ''}
        </div>`;
    }).join('');

    const muts = t.mutations.length
        ? `<table><tr><th>Variable</th><th>From</th><th>To</th><th>Line</th></tr>${t.mutations.map((m) => `<tr><td><code>${esc(m.name)}</code></td><td class="from">${esc(m.from)}</td><td class="to">${esc(m.to)}</td><td>${m.line}</td></tr>`).join('')}</table>`
        : '<p class="mut">No variable mutations captured.</p>';

    const mem = t.memory
        ? `<ul><li>Peak heap: <b>${fmtBytes(t.memory.peak)}</b></li><li>Net change: <b>${fmtDelta(t.memory.netDelta)}</b></li><li>Reclaimed: <b>${t.memory.reclaimed ? 'yes (GC observed)' : 'no'}</b></li><li>Samples: ${t.memory.series.length}</li></ul>`
        : '<p class="mut">No heap samples.</p>';

    return `<!doctype html><html><head><meta charset="utf-8"><title>Report — ${esc(t.scenario.name)}</title><style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0f1e;color:#e2e8f0;margin:0;padding:32px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px} h2{font-size:18px;margin:28px 0 10px;color:#a5b4fc}
.verdict{display:inline-block;font-weight:700;padding:6px 14px;border-radius:6px;background:rgba(129,140,248,.15);border:1px solid rgba(129,140,248,.4);margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{border:1px solid rgba(255,255,255,.1);padding:7px 10px;text-align:left}
th{color:#94a3b8}
code{font-family:ui-monospace,monospace;background:rgba(255,255,255,.08);padding:1px 5px;border-radius:3px}
.mut{color:#94a3b8;font-size:12px} .from{color:#94a3b8;text-decoration:line-through} .to{color:#34d399}
.f{background:#111726;border:1px solid rgba(255,255,255,.08);border-left-width:4px;border-radius:6px;padding:12px 14px;margin-bottom:10px}
.fh{font-weight:600} .sev{font-family:ui-monospace,monospace;font-size:11px;margin-right:8px;text-transform:uppercase}
.sug{color:#34d399;font-size:13px}
.m{font-family:ui-monospace,monospace;font-size:12.5px;padding:4px 0;border-left:2px solid rgba(255,255,255,.1);padding-left:10px}
.tag{font-size:11px;color:#fbbf24;margin-left:8px} .flow{color:#94a3b8;font-size:11.5px;padding-left:12px}
.flow.out{color:#fbbf24}
pre{background:#0b0f1e;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:12px;overflow:auto;font-size:12px}
</style></head><body><div class="wrap">
<h1>Test report — ${esc(t.scenario.name)}</h1>
<div class="verdict">${esc(t.verdict)}</div>
<table>
<tr><th>Run at</th><td>${esc(t.createdAt)}</td></tr>
${t.git?.sha ? `<tr><th>Commit</th><td><code>${esc(t.git.sha)}</code> ${esc(t.git.branch ?? '')}${t.git.dirty ? ' (dirty)' : ''}</td></tr>` : ''}
<tr><th>DB mode</th><td>${esc(t.scenario.dbMode)}${t.scenario.strictMocks ? ' (strict)' : ''}</td></tr>
<tr><th>Methods / pauses / DB calls</th><td>${t.stats.methodCount} / ${t.stats.pauseCount} / ${t.stats.dbCallTotal}</td></tr>
<tr><th>Secrets redacted</th><td>${t.redaction.on ? 'yes' : '<b style="color:#f87171">NO</b>'}</td></tr>
</table>
${t.calls.length ? `<h2>Requests</h2><table><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Pauses</th></tr>${t.calls.map((c) => `<tr><td>${esc(c.request.method)}</td><td><code>${esc(c.request.url)}</code></td><td>${c.response.status ?? 'ERR'}</td><td>${c.response.durationMs ?? '—'}ms</td><td>${c.pauseCount}</td></tr>`).join('')}</table>` : ''}
<h2>Findings</h2>${findings || '<p class="mut">No anomalies detected on this path.</p>'}
<h2>Call map</h2>${tree || '<p class="mut">No methods captured.</p>'}
<h2>State changes observed</h2>${muts}
<h2>Memory</h2>${mem}
${t.mockInjection?.results?.length ? `<h2>Mock injection</h2><table><tr><th>Target</th><th>Status</th></tr>${t.mockInjection.results.map((r) => `<tr><td><code>${esc(r.match)}</code></td><td>${esc(r.status)}</td></tr>`).join('')}</table>` : ''}
${t.audit?.length ? `<h2>Live edits during this run</h2><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr>${t.audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td><code>${esc(a.target ?? '')}</code></td><td>${esc(a.before ?? '')}</td><td>${esc(a.after ?? '')}</td></tr>`).join('')}</table>` : ''}
<h2>Sequence diagram (Mermaid)</h2><pre>${esc(traceToMermaid(t))}</pre>
<p class="mut">Generated by API Flow Test Debugger · FlowTrace v${t.schemaVersion} · trace <code>${esc(t.id)}</code></p>
<!-- markdown source length: ${md.length} chars -->
</div></body></html>`;
}
