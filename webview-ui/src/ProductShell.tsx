import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Outcome, UiFinding } from './outcome';

type StackFrame = { name: string; source?: string; line: number };

export type DebugStatus = 'none' | 'running' | 'paused' | 'ended';
export type EvidenceTab = 'findings' | 'map' | 'graph' | 'timeline' | 'response' | 'prove';
export type ContextTab = 'inspector' | 'request' | 'breakpoints' | 'mocks';
export type DockTab = 'problems' | 'timeline';

export type RunSummary = {
  id: string;
  label: string;
  source: 'scenario' | 'external';
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  pauses: number;
  startedAt: number;
  resultCount?: number;
};

export function RuntimeBar({
  sessionName, status, frame, runningCall, onControl,
}: {
  sessionName: string | null;
  status: DebugStatus;
  frame: StackFrame | null;
  runningCall?: string;
  onControl: (action: 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'stop') => void;
}) {
  const label = !sessionName ? 'No debug session'
    : status === 'paused' ? 'Paused'
    : status === 'running' ? 'Debugger running'
    : status === 'ended' ? 'Session ended' : sessionName;
  return (
    <div className={`shell-runtime ${status}`} role="status" aria-live="polite">
      <span className="shell-runtime-dot" aria-hidden="true" />
      <strong>{label}</strong>
      <span className="shell-runtime-where">
        {status === 'paused' && frame ? `${frame.name} · ${frame.source ?? '?'}:${frame.line}` : runningCall ?? sessionName ?? 'Press F5 to attach'}
      </span>
      <span className="shell-runtime-actions">
        {status === 'paused' && (
          <>
            <button className="btn primary" onClick={() => onControl('continue')}>▶ Continue</button>
            <button className="btn" onClick={() => onControl('stepOver')}>↷ Over</button>
            <button className="btn" onClick={() => onControl('stepIn')}>↓ Into</button>
            <button className="btn" onClick={() => onControl('stepOut')}>↑ Out</button>
          </>
        )}
        {sessionName && <button className="btn danger" onClick={() => onControl('stop')}>■ Stop</button>}
      </span>
    </div>
  );
}

export function OutcomeStrip({ outcome, onReport }: { outcome: Outcome; onReport: () => void }) {
  const evidence = outcome.verdict !== 'NO EVIDENCE';
  return (
    <div className={`shell-outcome ${outcome.tone}`} aria-label={`Runtime outcome: ${outcome.verdict}`}>
      <strong className={`shell-verdict ${outcome.tone}`}>{outcome.verdict}</strong>
      <span className={`outcome-chip ${outcome.exceptions ? 'bad' : ''}`}>exceptions <b>{outcome.exceptions}</b></span>
      <span className={`outcome-chip ${outcome.n1 ? 'warn' : ''}`}>N+1 <b>{outcome.n1}</b></span>
      <span className="outcome-chip">DB calls <b>{outcome.dbCalls}</b></span>
      <span className={`outcome-chip ${outcome.memory === 'not reclaimed' ? 'warn' : outcome.memory === 'reclaimed' ? 'ok' : ''}`}>memory <b>{outcome.memory}</b></span>
      <span className="shell-outcome-spacer" />
      <button className="btn" disabled={!evidence} onClick={onReport}>▤ Report</button>
    </div>
  );
}

export function RunRail({ runs, activeRunId }: { runs: RunSummary[]; activeRunId?: string }) {
  return (
    <aside className="shell-panel shell-run-rail" aria-label="Capture runs">
      <div className="shell-panel-head">Runs <span>{runs.length}</span></div>
      <div className="shell-scroll">
        {!runs.length && (
          <div className="rail-empty">Your first Postman request or scenario run will appear here as a separate capture.</div>
        )}
        {runs.map((run, index) => (
          <div className={`run-card ${run.id === activeRunId ? 'active' : ''}`} key={run.id}>
            <div className="run-card-title">
              <span className={`run-source ${run.source}`}>{run.source === 'external' ? 'EXT' : 'RUN'}</span>
              <strong>{run.label}</strong>
            </div>
            <div className="run-card-meta">#{runs.length - index} · {run.pauses} pause{run.pauses === 1 ? '' : 's'} · {run.status}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

const TABS: Array<{ id: EvidenceTab; label: string }> = [
  { id: 'findings', label: 'Findings' }, { id: 'map', label: 'Call Map' },
  { id: 'graph', label: 'Flow Graph' }, { id: 'timeline', label: 'Timeline' },
  { id: 'response', label: 'Response' }, { id: 'prove', label: 'Prove' },
];

export function EvidenceNav({ active, onChange, counts }: {
  active: EvidenceTab;
  onChange: (tab: EvidenceTab) => void;
  counts?: Partial<Record<EvidenceTab, number>>;
}) {
  return (
    <nav className="shell-tabs" aria-label="Run evidence">
      {TABS.map((tab) => (
        <button key={tab.id} className={active === tab.id ? 'active' : ''} aria-current={active === tab.id ? 'page' : undefined}
          onClick={() => onChange(tab.id)}>
          {tab.label}{typeof counts?.[tab.id] === 'number' && <span>{counts[tab.id]}</span>}
        </button>
      ))}
    </nav>
  );
}

export function ContextNav({ active, onChange, breakpointCount }: {
  active: ContextTab;
  onChange: (tab: ContextTab) => void;
  breakpointCount: number;
}) {
  const tabs: Array<{ id: ContextTab; label: string }> = [
    { id: 'inspector', label: 'Inspect' }, { id: 'request', label: 'Request' },
    { id: 'breakpoints', label: `Breaks ${breakpointCount}` }, { id: 'mocks', label: 'Mocks' },
  ];
  return (
    <nav className="shell-tabs context" aria-label="Context drawer">
      {tabs.map((tab) => <button key={tab.id} className={active === tab.id ? 'active' : ''}
        aria-current={active === tab.id ? 'page' : undefined} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
    </nav>
  );
}

export function FindingsView({ findings, onOpenSource, onSelectPause }: {
  findings: UiFinding[];
  onOpenSource: (where: string) => void;
  onSelectPause: (order: number) => void;
}) {
  if (!findings.length) {
    return <div className="findings-clear"><strong>No anomalies detected in this capture.</strong><span>Open Call Map to inspect the path, or save this run as a future baseline.</span></div>;
  }
  return (
    <div className="shell-findings">
      {findings.map((finding) => (
        <article className={`shell-finding ${finding.severity}`} key={finding.id}>
          <div className="finding-title"><span>{finding.severity}</span><strong>{finding.title}</strong></div>
          <p>{finding.detail}</p>
          {finding.where && <code>{finding.where}</code>}
          {finding.suggestion && <div className="finding-suggestion">→ {finding.suggestion}</div>}
          <div className="finding-actions">
            {finding.where && <button className="btn tiny" onClick={() => onOpenSource(finding.where!)}>Open code</button>}
            {finding.pauseOrder != null && <button className="btn tiny" onClick={() => onSelectPause(finding.pauseOrder!)}>Show pause #{finding.pauseOrder}</button>}
          </div>
        </article>
      ))}
    </div>
  );
}

export function ProblemsDock({
  tab, open, onTab, findings, timeline, selectedOrder, onSelectPause,
}: {
  tab: DockTab; open: boolean; onTab: (tab: DockTab) => void;
  findings: UiFinding[];
  timeline: Array<{ order: number; label: string; hit: number }>;
  selectedOrder: number | null;
  onSelectPause: (order: number) => void;
}) {
  return (
    <section className={`problems-dock ${open ? 'open' : ''}`}>
      <div className="dock-tabs">
        <button className={open && tab === 'problems' ? 'active' : ''} onClick={() => onTab('problems')}>Problems <span>{findings.length}</span></button>
        <button className={open && tab === 'timeline' ? 'active' : ''} onClick={() => onTab('timeline')}>Timeline <span>{timeline.length}</span></button>
      </div>
      {open && tab === 'problems' && (
        <div className="dock-body">{findings.length ? findings.map((f) => (
          <div className="dock-problem" key={f.id}><span className={f.severity}>{f.severity}</span><b>{f.title}</b><code>{f.where}</code></div>
        )) : <div className="dock-empty">No runtime problems detected.</div>}</div>
      )}
      {open && tab === 'timeline' && (
        <div className="dock-timeline">{timeline.map((pause) => (
          <button key={pause.order} className={selectedOrder === pause.order ? 'active' : ''} title={pause.label}
            onClick={() => onSelectPause(pause.order)}>{pause.order} {pause.label.split(' ')[0]}{pause.hit > 1 ? ` ×${pause.hit}` : ''}</button>
        ))}</div>
      )}
    </section>
  );
}

export function ShellPanel({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`shell-panel ${className}`}>{children}</section>;
}

type EditableCall = {
  id: string; name: string; method: string; url: string;
  headers?: Record<string, string>; body?: string; enabled?: boolean; extract?: Record<string, string>;
};
type KV = { k: string; v: string };
const toRows = (record?: Record<string, string>): KV[] => Object.entries(record ?? {}).map(([k, v]) => ({ k, v }));
const fromRows = (rows: KV[]): Record<string, string> | undefined => {
  const clean = rows.filter((row) => row.k.trim());
  return clean.length ? Object.fromEntries(clean.map((row) => [row.k.trim(), row.v])) : undefined;
};

/**
 * Phase 3 — full request editor. Exposes every field the ApiCall model supports
 * (name, method, URL, headers, body, extraction), plus reorder/duplicate, so a
 * pasted cURL's headers and body are visible and editable instead of hidden.
 */
export function RequestEditor({
  calls, results, brokenVarFor, onUpdate, onRemove, onDuplicate, onMove,
}: {
  calls: EditableCall[];
  results: Array<{ callId: string; status: number | null; ok: boolean }>;
  brokenVarFor: (index: number) => string | undefined;
  onUpdate: (id: string, patch: Partial<EditableCall>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<Record<string, 'headers' | 'body' | 'extract'>>({});
  return (
    <div className="req-editor">
      {calls.map((call, index) => {
        const off = call.enabled === false;
        const open = expanded[call.id] ?? false;
        const active = tab[call.id] ?? 'headers';
        const result = results.find((r) => r.callId === call.id);
        const brokenVar = brokenVarFor(index);
        const headerRows = toRows(call.headers);
        const extractRows = Object.entries(call.extract ?? {}).map(([k, v]) => ({ k, v }));
        const bodyDisabled = call.method === 'GET';
        return (
          <div className={`req-card ${off ? 'disabled' : ''}`} key={call.id}>
            <div className="req-head">
              <input type="checkbox" checked={!off} title={off ? 'Disabled' : 'Enabled'}
                onChange={(e) => onUpdate(call.id, { enabled: e.target.checked })} />
              <span className="req-index">{index + 1}</span>
              <input className="req-name" value={call.name} aria-label="Request name"
                onChange={(e) => onUpdate(call.id, { name: e.target.value })} />
              {result && <b className={result.ok ? 'ok' : 'bad'}>{result.status ?? 'ERR'}</b>}
              <span className="req-head-actions">
                <button className="req-icon" title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => onMove(call.id, -1)}>↑</button>
                <button className="req-icon" title="Move down" aria-label="Move down" disabled={index === calls.length - 1} onClick={() => onMove(call.id, 1)}>↓</button>
                <button className="req-icon" title="Duplicate" aria-label="Duplicate request" onClick={() => onDuplicate(call.id)}>⧉</button>
                <button className="req-icon danger" title="Remove" aria-label="Remove request" onClick={() => onRemove(call.id)}>✕</button>
              </span>
            </div>
            <div className="req-line">
              <select value={call.method} disabled={off} aria-label="HTTP method"
                onChange={(e) => onUpdate(call.id, { method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="req-url" value={call.url} disabled={off} placeholder="http://…/path or ${var}"
                aria-label="Request URL" onChange={(e) => onUpdate(call.id, { url: e.target.value })} />
              <button className="req-expand" aria-expanded={open} onClick={() => setExpanded((s) => ({ ...s, [call.id]: !open }))}>
                {open ? '▾' : '▸'} details
              </button>
            </div>
            {brokenVar && <div className="context-warning">⚠ {`\${${brokenVar}}`} is produced by a disabled request — it won't be filled.</div>}
            {open && (
              <div className="req-details">
                <div className="req-subtabs">
                  <button className={active === 'headers' ? 'on' : ''} onClick={() => setTab((s) => ({ ...s, [call.id]: 'headers' }))}>Headers {headerRows.length ? `(${headerRows.length})` : ''}</button>
                  <button className={active === 'body' ? 'on' : ''} onClick={() => setTab((s) => ({ ...s, [call.id]: 'body' }))}>Body</button>
                  <button className={active === 'extract' ? 'on' : ''} onClick={() => setTab((s) => ({ ...s, [call.id]: 'extract' }))}>Extract {extractRows.length ? `(${extractRows.length})` : ''}</button>
                </div>
                {active === 'headers' && (
                  <div className="req-kv">
                    {headerRows.map((row, i) => (
                      <div className="req-kv-row" key={i}>
                        <input placeholder="Header" value={row.k} onChange={(e) => { const next = [...headerRows]; next[i] = { ...row, k: e.target.value }; onUpdate(call.id, { headers: fromRows(next) }); }} />
                        <input placeholder="Value" value={row.v} onChange={(e) => { const next = [...headerRows]; next[i] = { ...row, v: e.target.value }; onUpdate(call.id, { headers: fromRows(next) }); }} />
                        <button className="req-icon danger" aria-label="Remove header" onClick={() => onUpdate(call.id, { headers: fromRows(headerRows.filter((_, j) => j !== i)) })}>✕</button>
                      </div>
                    ))}
                    <button className="btn tiny" onClick={() => onUpdate(call.id, { headers: fromRows([...headerRows, { k: '', v: '' }]) })}>+ Header</button>
                  </div>
                )}
                {active === 'body' && (
                  <div className="req-body">
                    {bodyDisabled
                      ? <div className="req-hint">GET requests send no body.</div>
                      : <textarea rows={5} value={call.body ?? ''} placeholder='{"key":"value"} — supports ${var}'
                          onChange={(e) => onUpdate(call.id, { body: e.target.value })} />}
                  </div>
                )}
                {active === 'extract' && (
                  <div className="req-kv">
                    <div className="req-hint">Capture a field from this response into a variable later requests use as {'${name}'}.</div>
                    {extractRows.map((row, i) => (
                      <div className="req-kv-row" key={i}>
                        <input placeholder="varName" value={row.k} onChange={(e) => { const next = [...extractRows]; next[i] = { ...row, k: e.target.value }; onUpdate(call.id, { extract: fromRows(next) }); }} />
                        <input placeholder="$.data.id" value={row.v} onChange={(e) => { const next = [...extractRows]; next[i] = { ...row, v: e.target.value }; onUpdate(call.id, { extract: fromRows(next) }); }} />
                        <button className="req-icon danger" aria-label="Remove extraction" onClick={() => onUpdate(call.id, { extract: fromRows(extractRows.filter((_, j) => j !== i)) })}>✕</button>
                      </div>
                    ))}
                    <button className="btn tiny" onClick={() => onUpdate(call.id, { extract: fromRows([...extractRows, { k: '', v: '' }]) })}>+ Extraction</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export type ComparisonResult = { baseline: string; outcome: string; markdown: string; entries: Array<{ severity: string; title: string; where?: string }> };
export type ContractResult = { name: string; pass: boolean; explanation: string; violations: Array<{ rule: string; expected: string; actual: string; where?: string }> };

/**
 * Phase 4 — prove-a-change workspace. Surfaces the already-tested baseline diff
 * and behavior-contract engines (save_trace/compare_traces, create/verify
 * contract) so a human can prove behaviour didn't regress, not just observe it.
 */
export function ProveView({
  hasEvidence, baselines, contracts, comparison, contract, onAction, onViewMarkdown,
}: {
  hasEvidence: boolean;
  baselines: string[];
  contracts: string[];
  comparison: ComparisonResult | null;
  contract: ContractResult | null;
  onAction: (action: { kind: 'saveBaseline' | 'compareBaseline' | 'saveContract' | 'verifyContract'; name: string }) => void;
  onViewMarkdown: (title: string, markdown: string) => void;
}) {
  const [baselineName, setBaselineName] = useState('baseline');
  const [contractName, setContractName] = useState('contract');
  if (!hasEvidence) {
    return <div className="shell-empty">Capture a run first. Then save it as a baseline, or generate a behavior contract, and prove later runs against it.</div>;
  }
  const tone = (outcome: string) => outcome === 'REGRESSION' ? 'bad' : outcome === 'CHANGED' ? 'warn' : 'ok';
  return (
    <div className="prove-view">
      <section className="prove-block">
        <h4>Baseline comparison</h4>
        <p>Save this run as the reference, then compare a later run to detect regressions.</p>
        <div className="prove-row">
          <input value={baselineName} onChange={(e) => setBaselineName(e.target.value)} aria-label="Baseline name" />
          <button className="btn" onClick={() => onAction({ kind: 'saveBaseline', name: baselineName })}>Save as baseline</button>
        </div>
        {baselines.length > 0 && (
          <div className="prove-list">
            {baselines.map((name) => (
              <div className="prove-item" key={name}>
                <code>{name}</code>
                <button className="btn tiny" onClick={() => onAction({ kind: 'compareBaseline', name })}>Compare current →</button>
              </div>
            ))}
          </div>
        )}
        {comparison && (
          <div className={`prove-result ${tone(comparison.outcome)}`}>
            <div className="prove-verdict"><b>{comparison.outcome}</b> vs {comparison.baseline}
              <button className="btn tiny" onClick={() => onViewMarkdown(`Comparison vs ${comparison.baseline}`, comparison.markdown)}>Full diff</button></div>
            {comparison.entries.slice(0, 6).map((entry, index) => (
              <div className={`prove-entry ${entry.severity}`} key={index}><span>{entry.severity}</span>{entry.title}{entry.where ? ` · ${entry.where}` : ''}</div>
            ))}
            {comparison.entries.length === 0 && <div className="prove-entry">No behavioural differences — equivalent to the baseline.</div>}
          </div>
        )}
      </section>

      <section className="prove-block">
        <h4>Behavior contract</h4>
        <p>Turn this run into required behaviour, then verify a later run and gate a PR on it (same engine as the CI runner).</p>
        <div className="prove-row">
          <input value={contractName} onChange={(e) => setContractName(e.target.value)} aria-label="Contract name" />
          <button className="btn" onClick={() => onAction({ kind: 'saveContract', name: contractName })}>Generate contract</button>
        </div>
        {contracts.length > 0 && (
          <div className="prove-list">
            {contracts.map((name) => (
              <div className="prove-item" key={name}>
                <code>{name}</code>
                <button className="btn tiny" onClick={() => onAction({ kind: 'verifyContract', name })}>Verify current →</button>
              </div>
            ))}
          </div>
        )}
        {contract && (
          <div className={`prove-result ${contract.pass ? 'ok' : 'bad'}`}>
            <div className="prove-verdict"><b>{contract.pass ? 'PASS' : 'FAIL'}</b> — {contract.name}</div>
            {contract.violations.map((violation, index) => (
              <div className="prove-entry high" key={index}><span>{violation.rule}</span>expected {violation.expected}, got {violation.actual}{violation.where ? ` · ${violation.where}` : ''}</div>
            ))}
            {contract.pass && <div className="prove-entry">All contract rules satisfied by the current run.</div>}
          </div>
        )}
      </section>
    </div>
  );
}
