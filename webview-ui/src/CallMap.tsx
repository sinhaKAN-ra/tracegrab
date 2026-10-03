import { useState } from 'react';
import type { CallNode, Layer, VarLite, Mutation } from './callTree';
import { toMermaidSequence } from './callTree';
import { openValue, CopyButton, copyText } from './ValueViewer';

type Send = (msg: unknown) => void;

/** Format bytes as a compact human string (e.g. 4.2 MB). */
function fmtBytes(n?: number): string {
  if (typeof n !== 'number') return '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDelta(n?: number): string {
  if (typeof n !== 'number' || n === 0) return '';
  return (n > 0 ? '+' : '') + fmtBytes(n);
}

type MemSample = { order: number; heapUsed: number; heapTotal: number; rss: number; heapDelta?: number };

/** Pure-SVG heap-over-time sparkline. No chart lib — one polyline + a peak dot. */
function Sparkline({ series, width = 160, height = 34 }: { series: MemSample[]; width?: number; height?: number }) {
  if (series.length < 2) return null;
  const vals = series.map((s) => s.heapUsed);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = series.map((s, i) => {
    const x = pad + (series.length === 1 ? 0 : (i / (series.length - 1)) * w);
    const y = pad + h - ((s.heapUsed - min) / range) * h;
    return [x, y];
  });
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${(height - pad).toFixed(1)} L${pad},${(height - pad).toFixed(1)} Z`;
  const peakIdx = vals.indexOf(max);
  const last = pts[pts.length - 1];
  const trendUp = vals[vals.length - 1] >= vals[0];
  const color = trendUp ? '#f87171' : '#34d399';
  return (
    <span className="cm-spark" title={`heap over ${series.length} pauses · min ${fmtBytes(min)} · peak ${fmtBytes(max)}`}>
      <svg width={width} height={height} role="img" aria-label="heap over time">
        <path d={area} fill={color} fillOpacity={0.12} stroke="none" />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        <circle cx={pts[peakIdx][0]} cy={pts[peakIdx][1]} r={2.2} fill="#fbbf24" />
        <circle cx={last[0]} cy={last[1]} r={2.2} fill={color} />
      </svg>
    </span>
  );
}

const LAYER_LABEL: Record<Layer, string> = {
  controller: 'CTRL',
  service: 'SVC',
  db: 'DB',
  external: 'EXT',
  other: 'FN',
};

function short(s: string, n = 28): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Legend explaining the map's visual language. */
function Legend({ layout, onToggle }: { layout: 'nested' | 'columns'; onToggle: () => void }) {
  return (
    <div className="cm-legend">
      <span className="cm-key"><i className="dot ctrl" />Controller</span>
      <span className="cm-key"><i className="dot svc" />Service</span>
      <span className="cm-key"><i className="dot db" />DB</span>
      <span className="cm-key"><i className="dot ext" />External</span>
      <span className="cm-key call">↓ call</span>
      <span className="cm-key ret">↑ return</span>
      <span className="cm-key loop">↻ ×N loop</span>
      <span className="cm-key n1">⚠ N+1</span>
      <button className="cm-layout-btn" onClick={onToggle}>
        {layout === 'nested' ? 'Layout: Nested ▾' : 'Layout: Columns ▾'}
      </button>
    </div>
  );
}

function VarPreview({ vars }: { vars: VarLite[] }) {
  // Same noise filter as the inspector: drop this=undefined, module imports
  // (X_1), and giant built-in objects so the preview stays readable.
  const clean = vars.filter((v) => {
    if (v.name === 'this' && (v.value === 'undefined' || v.value === 'null')) return false;
    if (/_\d+$/.test(v.name)) return false;
    if (/^(IncomingMessage|ServerResponse|Socket|Timeout|TLSSocket)\b/.test(String(v.value))) return false;
    return true;
  });
  if (!clean.length) return null;
  return (
    <>
      {clean.slice(0, 3).map((v) => {
        const full = String(v.value);
        const flat = full.replace(/\s+/g, ' ').trim();
        return (
          <span className="cm-var peek" key={v.name} title="Click to view the full value"
            onClick={(e) => { e.stopPropagation(); openValue({ name: v.name, value: full, kind: v.type }); }}>
            <span className="cm-var-n">{v.name}</span>
            <span className="cm-var-v">{short(flat, 22)}</span>
          </span>
        );
      })}
    </>
  );
}

/** Mutation diff: what this step CHANGED vs the previous step. The "where did
 *  this value come from" answer that makes a debugger worth opening. */
function Mutations({ muts }: { muts?: Mutation[] }) {
  if (!muts || !muts.length) return null;
  return (
    <div className="cm-muts">
      {muts.map((m) => (
        <span className="cm-mut" key={m.name} title={`${m.name}: ${m.from} → ${m.to}`}>
          <span className="cm-mut-n">{m.name}</span>
          <span className="cm-mut-from">{m.from}</span>
          <span className="cm-mut-arrow">→</span>
          <span className="cm-mut-to">{m.to}</span>
        </span>
      ))}
    </div>
  );
}

/** One method box (recursive) — Layout B nested. */
function MethodBox({
  node, send, activeId, depthCap = 6,
}: {
  node: CallNode; send: Send; activeId?: string; depthCap?: number;
}) {
  const [open, setOpen] = useState(true);
  const isActive = node.id === activeId;
  const lastStep = node.steps[node.steps.length - 1];
  const openSource = () => {
    const line = lastStep?.line ?? node.steps[0]?.line ?? 1;
    send({ kind: 'openSource', file: node.source, line });
  };

  const capped = node.depth >= depthCap;

  return (
    <div className={`cm-box ${node.layer} ${isActive ? 'active' : ''} ${node.error ? 'errored' : ''}`}>
      <div className="cm-head">
        <button className="cm-caret" onClick={() => setOpen((o) => !o)}>
          {node.children.length ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className={`cm-tag ${node.layer}`}>{LAYER_LABEL[node.layer]}</span>
        <span className="cm-fn" onClick={openSource} title="Open in editor">{node.fn}</span>
        {node.n1 && <span className="cm-n1" title="Possible N+1: called many times in a loop">⚠ N+1 ×{node.enteredCount}</span>}
        {node.looped && <span className="cm-loop" title="Called N times in a loop">↻ ×{node.enteredCount}{node.recursive ? ' recursive' : ''}</span>}
        {node.dbCalls > 0 && <span className="cm-dbcount">{node.dbCalls} DB</span>}
        {node.error && <span className="cm-err" title={node.error.message}>✗ {short(node.error.type ?? 'throw', 16)}</span>}
        {typeof node.heapDelta === 'number' && node.heapDelta !== 0 && (
          <span className={`cm-heap ${node.heapDelta > 0 ? 'up' : 'down'}`} title={`heap ${node.heapDelta > 0 ? 'grew' : 'freed'} across this method`}>
            {node.heapDelta > 0 ? '▲' : '▼'} {fmtDelta(node.heapDelta)}
          </span>
        )}
        {node.asyncBoundary && <span className="cm-async">async</span>}
        {isActive && <span className="cm-here">● here</span>}
        <span className="cm-file" onClick={openSource}>{node.source}</span>
      </div>

      {node.dataIn && <div className="cm-flow in peek" title="Click to view"
        onClick={(e) => { e.stopPropagation(); openValue({ name: `${node.fn} · in`, value: node.dataIn! }); }}>↓ in: <span className="cm-flow-data">{node.dataIn}</span></div>}

      {open && (
        <div className="cm-body">
          {node.steps.map((s) => (
            <div className={`cm-step ${s.error ? 'errored' : ''}`} key={`${node.id}-${s.line}`}
              onClick={() => send({ kind: 'openSource', file: node.source, line: s.line })}>
              <span className="cm-step-order">#{s.order}</span>
              <span className="cm-step-line">L{s.line}</span>
              {s.hit > 1 && <span className="cm-hit">×{s.hit}</span>}
              <VarPreview vars={s.vars} />
              {s.error && <span className="cm-step-err">✗ {short(s.error.message, 40)}</span>}
              <Mutations muts={s.mutations} />
            </div>
          ))}

          {node.children.length > 0 && !capped && (
            <div className="cm-children">
              {node.children.map((c) => (
                <MethodBox key={c.id} node={c} send={send} activeId={activeId} depthCap={depthCap} />
              ))}
            </div>
          )}
          {node.children.length > 0 && capped && (
            <div className="cm-capped">⤶ {node.children.length} deeper call(s) — depth &gt; {depthCap}</div>
          )}
        </div>
      )}

      {node.dataOut && <div className="cm-flow out peek" title="Click to view"
        onClick={(e) => { e.stopPropagation(); openValue({ name: `${node.fn} · out`, value: node.dataOut! }); }}>↑ out: <span className="cm-flow-data">{node.dataOut}</span></div>}
    </div>
  );
}

/** Layout A — layered columns (architecture view). Polished for fan-out:
 *  boxes are ordered by execution (#N ON the box), a box shows its caller so a
 *  controller fanning out to N services reads clearly, and each box carries its
 *  own N+1/error/heap markers. */
function ColumnsView({ roots, send, activeId }: { roots: CallNode[]; send: Send; activeId?: string }) {
  const cols: Record<Layer, CallNode[]> = { controller: [], service: [], db: [], external: [], other: [] };
  const byId = new Map<string, CallNode>();
  const walk = (n: CallNode) => { cols[n.layer].push(n); byId.set(n.id, n); n.children.forEach(walk); };
  roots.forEach(walk);
  // keep execution order within each column so fan-out siblings stack in call order
  (Object.keys(cols) as Layer[]).forEach((l) => cols[l].sort((a, b) => a.firstOrder - b.firstOrder));

  const order: Layer[] = ['controller', 'service', 'db', 'external', 'other'];
  const shown = order.filter((l) => cols[l].length);
  const callerFn = (n: CallNode) => (n.parentId ? byId.get(n.parentId)?.fn : undefined);

  return (
    <div className="cm-columns">
      {shown.map((layer) => (
        <div className="cm-col" key={layer}>
          <div className="cm-col-label">{LAYER_LABEL[layer]}<span className="cm-col-count">{cols[layer].length}</span></div>
          {cols[layer].map((n) => {
            const from = callerFn(n);
            return (
              <div key={n.id} className={`cm-col-box ${layer} ${n.id === activeId ? 'active' : ''} ${n.error ? 'errored' : ''}`}
                onClick={() => send({ kind: 'openSource', file: n.source, line: n.steps[0]?.line ?? 1 })}>
                <div className="cm-col-fn">
                  <span className="cm-col-order">#{n.firstOrder}</span>{n.fn}
                  {n.n1 && <span className="cm-n1">⚠ N+1 ×{n.enteredCount}</span>}
                  {n.looped && <span className="cm-loop" title="Called N times in a loop">↻ ×{n.enteredCount}{n.recursive ? ' recursive' : ''}</span>}
                  {n.dbCalls > 0 && <span className="cm-dbcount">{n.dbCalls} DB</span>}
                  {n.error && <span className="cm-err">✗</span>}
                </div>
                {from && <div className="cm-col-caller">← from {from}</div>}
                <div className="cm-col-file">{n.source}</div>
                {n.dataIn && <div className="cm-col-data peek" onClick={(e) => { e.stopPropagation(); openValue({ name: `${n.fn} · in`, value: n.dataIn! }); }}>↓ {n.dataIn}</div>}
                {n.dataOut && <div className="cm-col-data out peek" onClick={(e) => { e.stopPropagation(); openValue({ name: `${n.fn} · out`, value: n.dataOut! }); }}>↑ {n.dataOut}</div>}
                {typeof n.heapDelta === 'number' && n.heapDelta !== 0 && (
                  <div className={`cm-col-heap ${n.heapDelta > 0 ? 'up' : 'down'}`}>{n.heapDelta > 0 ? '▲' : '▼'} {fmtDelta(n.heapDelta)}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CallMap({
  roots, send, activeId, memory, memorySeries, bookends,
}: {
  roots: CallNode[]; send: Send; activeId?: string;
  memory?: { heapUsed: number; heapTotal: number; rss: number; heapDelta?: number };
  memorySeries?: MemSample[];
  bookends?: Array<{ method: string; url: string; status: number | null; ok?: boolean; ms?: number }>;
}) {
  const [layout, setLayout] = useState<'nested' | 'columns'>('nested');
  const [mermaid, setMermaid] = useState<string | null>(null);
  const [mermaidCopied, setMermaidCopied] = useState<'ok' | 'fail' | null>(null);

  if (!roots.length) {
    return (
      <div className="cm-empty">
        Run a scenario with breakpoints across your layers (controller → service → DB).
        The Call Map groups each method into its own box and shows the call/return flow
        of data between them — the full request lifecycle. Loops collapse with ×N; a
        method called repeatedly in a loop is flagged ⚠ N+1.
      </div>
    );
  }
  const copyMermaid = async () => {
    const src = toMermaidSequence(roots);
    setMermaid(src);
    setMermaidCopied((await copyText(src)) ? 'ok' : 'fail');
  };
  return (
    <div className="cm-root">
      <Legend layout={layout} onToggle={() => setLayout((l) => (l === 'nested' ? 'columns' : 'nested'))} />
      <div className="cm-toolbar">
        {memory && (
          <span className="cm-mem" title="Debuggee heap at the latest pause (process.memoryUsage)">
            heap <b>{fmtBytes(memory.heapUsed)}</b> / {fmtBytes(memory.heapTotal)} · rss {fmtBytes(memory.rss)}
            {typeof memory.heapDelta === 'number' && memory.heapDelta !== 0 && (
              <span className={`cm-mem-d ${memory.heapDelta > 0 ? 'up' : 'down'}`}>
                {memory.heapDelta > 0 ? ' ▲' : ' ▼'}{fmtDelta(memory.heapDelta)}
              </span>
            )}
          </span>
        )}
        {memorySeries && memorySeries.length >= 2 && <Sparkline series={memorySeries} />}
        <button className="cm-mermaid-btn" onClick={copyMermaid} title="Copy a Mermaid sequence diagram of this trace">
          ⤓ Mermaid
        </button>
      </div>
      {mermaid && (
        <div className="cm-mermaid">
          <div className="cm-mermaid-hd">
            <span>
              Mermaid sequence — paste into a ticket / MR
              {mermaidCopied === 'ok' && <b className="vv-ok"> · ✓ copied</b>}
              {mermaidCopied === 'fail' && <b className="vv-fail"> · copy blocked, select the text below</b>}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <CopyButton text={mermaid} label="Copy" />
              <button onClick={() => { setMermaid(null); setMermaidCopied(null); }}>✕</button>
            </span>
          </div>
          <textarea readOnly value={mermaid} spellCheck={false} />
        </div>
      )}
      <div className="cm-scroll">
        {bookends && bookends.length > 0 && (
          <div className="cm-bookends">
            {bookends.map((b, i) => (
              <div className="cm-bookend" key={i}>
                <span className={`cm-be-method ${b.method.toLowerCase()}`}>{b.method}</span>
                <span className="cm-be-url" title={b.url}>{b.url}</span>
                {b.status != null ? (
                  <span className={`cm-be-status ${b.ok ? 'ok' : 'bad'}`}>{b.status}{typeof b.ms === 'number' ? ` · ${b.ms}ms` : ''}</span>
                ) : (
                  <span className="cm-be-status pending">not run</span>
                )}
              </div>
            ))}
          </div>
        )}
        {layout === 'nested'
          ? roots.map((r) => <MethodBox key={r.id} node={r} send={send} activeId={activeId} />)
          : <ColumnsView roots={roots} send={send} activeId={activeId} />}
      </div>
    </div>
  );
}
