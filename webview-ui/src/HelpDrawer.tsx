/**
 * In-panel guide. The tool had no place that answered "what can I do with this?"
 * — users had to be told. This is that place: what it does, how to start, what
 * each badge means, and the ways to drive it.
 */

import { useEffect } from 'react';

type Send = (msg: unknown) => void;

export function HelpDrawer({ onClose, send, pythonReady }: { onClose: () => void; send: Send; pythonReady?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help" role="dialog" aria-modal="true" aria-label="API Flow Test Debugger help" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="help-title">API Flow Test Debugger — what you can do</span>
          <button className="help-x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="help-body">
          <p className="help-lede">
            Drive a real API request and <b>watch the data move through your code</b> — which methods
            ran, what each one received and returned, what changed, and where it broke.
          </p>

          <div className="help-sec">
            <h4>1 · Start it (once)</h4>
            <ol>
              <li>In the target repo, press <kbd>F5</kbd> to run your API <b>under the debugger</b>. Breakpoints only bind to a debug session.</li>
              <li>Set breakpoints — click the <b>editor gutter</b> (no config needed), or add them in the Breakpoints box below.</li>
              <li>Trigger the endpoint. Either press <b>▶ Run</b> here, or just call it from <b>Postman / curl / your browser</b>.</li>
            </ol>
            <p className="help-note">
              No scenario JSON is required to watch a flow. The runner is only a convenience that
              fires the calls for you and chains <code>{'${var}'}</code> between them.
            </p>
          </div>

          <div className="help-sec">
            <h4>2 · Read the flow</h4>
            <ul>
              <li><b>Call Map</b> — each method is a box, nested by who called whom: controller → service → DB. <code>↓ in</code> / <code>↑ out</code> show the data crossing each boundary.</li>
              <li><b>Flow Graph</b> — the same run as a node-per-pause graph, with a minimap.</li>
              <li><b>Click any value</b> anywhere to open it full-size, scrollable, JSON pretty-printed, with Copy.</li>
              <li><b>Data State Inspector</b> — all variables at the current pause. Framework noise is hidden by default; untick to see everything.</li>
            </ul>
          </div>

          <div className="help-sec">
            <h4>3 · Badges worth knowing</h4>
            <ul className="help-badges">
              <li><span className="cm-n1">⚠ N+1 ×3</span> a DB call repeated inside a loop — usually a bug worth batching.</li>
              <li><span className="cm-hit">×3</span> that line ran 3 times (a loop), collapsed into one row.</li>
              <li><span className="flow-node-ext">EXT</span> this pause came from outside the tool (Postman/curl), not from ▶ Run.</li>
              <li><span className="cm-err">✗</span> an exception was thrown here; the box turns red.</li>
              <li><span className="cm-heap up">▲ 1.2 MB</span> heap grew across this method (▼ = it was freed).</li>
            </ul>
          </div>

          <div className="help-sec">
            <h4>4 · Change things mid-flight</h4>
            <ul>
              <li><b>✎ on a variable</b> — edit a live value at the pause and continue, to force a branch without touching code.</li>
              <li><b>DB: real | mocked</b> — <code>real</code> hits your database. <code>mocked</code> stubs it, but each mock needs an explicit target
                like <code>src/db/Accessor#getById</code>. If a mock can't be injected the panel says so — it never pretends to be isolated.</li>
              <li><b>Save as unit test</b> — turn a recorded run into a replayable test.</li>
              <li><b>⤓ Mermaid</b> — export the trace as a sequence diagram for a ticket or MR.</li>
            </ul>
          </div>

          <div className="help-sec">
            <h4>5 · Let an AI agent drive it</h4>
            <p>
              The tool ships an MCP server, so an agent can run the whole investigation itself and
              return a diagnosis — exceptions, N+1s, suspicious mutations, heap growth — instead of
              you relaying what the panel shows. One call (<code>auto_debug</code>) applies breakpoints,
              fires the request, records every pause, and reports a verdict.
            </p>
            <p className="help-note">Full reference: <code>docs/AGENT_AUTOMATION.md</code> in the repo.</p>
            {pythonReady && (
              <p className="help-note">
                🐍 This workspace's Python has <code>debugpy</code> installed, so an agent (or a CI job)
                can also record a trace with <b>no IDE at all</b> — <code>flow-verify collect --lang python</code>
                or the <code>collect_trace_headless</code> MCP tool. Panel-driven collection isn't built yet;
                this hint only appears because the CLI/agent path is ready to use right now.
              </p>
            )}
          </div>

          <div className="help-sec">
            <h4>Tips</h4>
            <ul>
              <li><b>⧉ New window</b> (top right) moves this panel to its own window for a bigger screen.</li>
              <li>Breakpoints you set yourself appear under <b>“Set by you”</b>; agent/scenario ones under <b>“From scenario / agent”</b>.</li>
              <li>Untick a call's checkbox to skip it — the button becomes <b>▶ Run selected</b>.</li>
            </ul>
          </div>
        </div>

        <div className="help-foot">
          <button className="btn" onClick={() => { send({ kind: 'openInNewWindow' }); onClose(); }}>
            ⧉ Open in a new window
          </button>
          <button className="btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
