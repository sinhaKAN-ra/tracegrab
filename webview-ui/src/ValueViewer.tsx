/* eslint-disable react-refresh/only-export-components -- openValue() is a
   deliberate shared helper co-located with its host component; a dev-only
   fast-refresh nicety, not worth a separate module. */
import { useEffect, useState } from 'react';

/**
 * ONE shared value viewer for the whole app — like hovering/clicking a variable
 * in a modern debugger. Any value surface (inspector rows, Call Map step vars,
 * data-in/out, columns view) opens it via `openValue(...)`, so behaviour and
 * styling are identical everywhere: a scrollable popover with JSON
 * pretty-printing, copy, and Esc/backdrop close.
 */

export type ValuePayload = { name: string; value: string; kind?: string };

type Listener = (p: ValuePayload | null) => void;
const listeners = new Set<Listener>();

/** Open the shared value viewer from anywhere (no prop drilling). */
export function openValue(p: ValuePayload) {
  for (const l of listeners) l(p);
}
function closeValue() {
  for (const l of listeners) l(null);
}

function prettyIfJson(value: string): { text: string; isJson: boolean } {
  const t = value.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return { text: JSON.stringify(JSON.parse(t), null, 2), isJson: true }; } catch { /* not json */ }
  }
  return { text: value, isJson: false };
}

/**
 * Copy text and REPORT whether it worked.
 *
 * `navigator.clipboard` is frequently unavailable inside a VS Code webview, and
 * writeText() returns a Promise — so a synchronous try/catch around it silently
 * swallows the failure and the copy appears to do nothing. Await it, then fall
 * back to the execCommand textarea trick (which does work in webviews).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it out of view but still selectable (required for execCommand).
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A copy button that confirms the result instead of failing silently. */
export function CopyButton({ text, label = 'Copy', className = 'vv-btn' }: {
  text: string; label?: string; className?: string;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      className={`${className} copy-btn ${state}`}
      title={state === 'fail' ? 'Copy failed — select the text and copy manually' : `${label} to clipboard`}
      onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}
    >
      {state === 'ok' ? '✓ Copied' : state === 'fail' ? '✕ Copy failed' : `⧉ ${label}`}
    </button>
  );
}

/** Mount ONCE near the app root. Renders nothing until a value is opened. */
export function ValueViewerHost() {
  const [payload, setPayload] = useState<ValuePayload | null>(null);

  useEffect(() => {
    const l: Listener = (p) => setPayload(p);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeValue(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload]);

  if (!payload) return null;
  const { text, isJson } = prettyIfJson(payload.value);
  const lines = text.split('\n').length;

  return (
    <div className="vv-backdrop" onClick={closeValue}>
      <div className="vv" role="dialog" aria-modal="true" aria-label={`Value: ${payload.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="vv-head">
          <span className="vv-name">{payload.name}</span>
          {payload.kind && <span className="vv-kind">{payload.kind}</span>}
          {isJson && <span className="vv-tag">JSON</span>}
          <span className="vv-meta">{payload.value.length} chars · {lines} line{lines === 1 ? '' : 's'}</span>
          <CopyButton text={payload.value} label="Copy" />
          <button className="vv-btn vv-x" title="Close (Esc)" onClick={closeValue}>✕</button>
        </div>
        {/* The scrollable body — up/down through the whole value, like a debugger. */}
        <pre className="vv-body">{text}</pre>
      </div>
    </div>
  );
}
