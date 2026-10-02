import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction, ReactNode } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
} from 'reactflow';
import type { Edge, Node, NodeProps } from 'reactflow';
import 'reactflow/dist/style.css';
import { CallMap } from './CallMap';
import { openValue, ValueViewerHost, CopyButton } from './ValueViewer';
import { HelpDrawer } from './HelpDrawer';
import { CallTreeBuilder, type CallNode } from './callTree';
import {
  ContextNav, EvidenceNav, FindingsView, OutcomeStrip, ProblemsDock,
  ProveView, RequestEditor, RunRail, RuntimeBar, ShellPanel,
  type ComparisonResult, type ContractResult,
  type ContextTab, type DockTab, type EvidenceTab, type RunSummary,
} from './ProductShell';
import { deriveOutcome } from './outcome';
import { mergeBreakpoints, type UnifiedBpRow } from './breakpoints';

// ---- Protocol (mirrors src/protocol.ts) ----
type StackFrameDTO = { id: number; name: string; source?: string; line: number };
type VariableDTO = { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string };
type ScopeDTO = { name: string; variablesReference: number; variables: VariableDTO[] };
type MockInjection = {
  at: string; mockSetName?: string; note?: string;
  results: Array<{ match: string; status: 'ok' | 'failed' | 'unsupported'; message: string }>;
};
type MemorySample = { order: number; heapUsed: number; heapTotal: number; rss: number; external?: number; heapDelta?: number };

type ApiCall = {
  id: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  enabled?: boolean;
  extract?: Record<string, string>;
};
type Scenario = { id: string; name: string; calls: ApiCall[]; breakpoints: Breakpoint[]; dbMode: 'real' | 'mocked'; mockSetName?: string; strictMocks?: boolean };
type Breakpoint = { file: string; line: number; condition?: string; label?: string; enabled?: boolean };
type AllBp = { file: string; line: number; condition?: string; enabled: boolean; source: 'scenario' | 'manual' };
type CallResult = {
  callId: string; name: string; status: number | null; ok: boolean;
  durationMs: number; responseBody?: string; error?: string; pauseCount: number;
};
type MockSet = {
  name: string; language: string;
  variableOverrides: Record<string, string>;
  boundaryMocks: Array<{ match: string; returns: unknown }>;
};

type ToWebview =
  | { kind: 'init'; scenario: Scenario; mockSets: string[] }
  | { kind: 'session'; status: 'started' | 'ended'; name?: string; restore?: boolean }
  | { kind: 'debugStatus'; status: 'running' | 'paused' | 'ended'; threadId?: number; reason?: string }
  | { kind: 'stopped'; reason: string; frame: StackFrameDTO | null; stack: StackFrameDTO[]; scopes: ScopeDTO[]; step: number; runId?: string; pauseId?: string; callId?: string; external?: boolean; dbMode?: 'real' | 'mocked'; memory?: MemorySample; exception?: { message: string; type?: string } }
  | { kind: 'memory'; sample: MemorySample }
  | { kind: 'variables'; variablesReference: number; variables: VariableDTO[] }
  | { kind: 'variableSet'; ok: boolean; name: string; value?: string; message?: string }
  | { kind: 'runStarted'; scenarioId: string; runId: string }
  | { kind: 'callStarted'; runId: string; callId: string; name: string; index: number }
  | { kind: 'callResult'; runId?: string; result: CallResult }
  | { kind: 'runFinished'; scenarioId: string; runId: string; results: CallResult[]; cancelled?: boolean }
  | { kind: 'mockSet'; mockSet: MockSet }
  | { kind: 'mockInjection'; report: MockInjection }
  | { kind: 'reportReady'; format: 'markdown' | 'html'; content: string; savedTo?: string; verdict: string }
  | { kind: 'pythonReadiness'; ready: boolean; reason?: string; version?: string; python?: string }
  | { kind: 'baselines'; names: string[]; contracts: string[] }
  | { kind: 'baselineSaved'; name: string }
  | { kind: 'comparisonReady'; baseline: string; outcome: string; markdown: string; entries: Array<{ severity: string; title: string; where?: string }> }
  | { kind: 'contractSaved'; name: string; yaml: string }
  | { kind: 'contractVerified'; name: string; pass: boolean; explanation: string; violations: Array<{ rule: string; expected: string; actual: string; where?: string }> }
  | { kind: 'breakpointsApplied'; breakpoints: Breakpoint[]; message?: string }
  | { kind: 'allBreakpoints'; entries: AllBp[] }
  | { kind: 'testGenerated'; path: string }
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string };

type VsCodeApi = { postMessage: (msg: unknown) => void };
declare global {
  interface Window { acquireVsCodeApi?: () => VsCodeApi }
}
const vscodeApi: VsCodeApi | undefined = window.acquireVsCodeApi?.();
const send = (msg: unknown) => vscodeApi?.postMessage(msg);

const NODE_ACTIVE = { background: 'rgba(22,27,43,0.95)', color: '#e2e8f0', border: '1px solid #6366f1', boxShadow: '0 0 12px rgba(99,102,241,0.55)', width: 230 };
const NODE_PAST = { background: 'rgba(22,27,43,0.7)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', width: 230 };

const uid = () => Math.random().toString(36).slice(2, 8);

/** Parse a curl command (as Postman/browsers emit) into an ApiCall shape.
 *  Handles -X/--request, -H/--header, -d/--data/--data-raw, and the bare URL.
 *  Tokenizes with quote awareness so quoted bodies/headers survive. */
function parseCurl(raw: string): { method: ApiCall['method']; url: string; body?: string; headers?: Record<string, string> } | null {
  const s = raw.trim().replace(/\\\r?\n/g, ' '); // join line-continuations
  if (!/^curl\b/.test(s)) return null;
  const toks: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) toks.push(m[1] ?? m[2] ?? m[3]);
  let method = ''; let url = ''; let body: string | undefined;
  const headers: Record<string, string> = {};
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-X' || t === '--request') { method = (toks[++i] || '').toUpperCase(); }
    else if (t === '-H' || t === '--header') {
      const h = toks[++i] || ''; const idx = h.indexOf(':');
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
    else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') { body = toks[++i]; }
    else if (t === '--url') { url = toks[++i] || ''; }
    else if (/^https?:\/\//.test(t) && !url) { url = t; }
    else if (t === '--compressed' || t === '-s' || t === '-i' || t === '-L' || t === '-k') { /* ignore flags */ }
  }
  if (!url) return null;
  const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const finalMethod = allowed.includes(method) ? method : body ? 'POST' : 'GET';
  return {
    method: finalMethod as ApiCall['method'],
    url,
    body: body || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

/** Rich execution-flow node: fn name, file:line, order #, loop hit-count, var preview, DB tag. */
function FlowStepNode({ data }: NodeProps) {
  const vars: VariableDTO[] = (data.scopes?.[0]?.variables ?? []).filter((v: VariableDTO) => !isNoise(v)).slice(0, 3);
  const hit: number = data.hit ?? 1;
  return (
    <div className="flow-node">
      <Handle type="target" position={Position.Top} />
      <div className="flow-node-head">
        <span className="flow-node-order">#{data.order}</span>
        <span className="flow-node-fn">{data.fn}</span>
        {hit > 1 && <span className="flow-node-hit" title="iterations / revisits">×{hit}</span>}
        {data.external && (
          <span className="flow-node-ext" title="Triggered from outside the tool (Postman / curl / browser)">EXT</span>
        )}
        {data.dbMode && (
          <span className={`flow-node-db ${data.dbMode === 'mocked' ? 'mock' : 'live'}`}>
            {data.dbMode === 'mocked' ? 'MOCK' : 'LIVE'}
          </span>
        )}
      </div>
      <div className="flow-node-loc">{data.loc}{data.depth ? `  ·  depth ${data.depth}` : ''}</div>
      {vars.length > 0 && (
        <div className="flow-node-vars">
          {vars.map((v) => (
            <div className="flow-node-var peek" key={v.name} title="Click to view the full value"
              onClick={(e) => { e.stopPropagation(); openValue({ name: v.name, value: String(v.value), kind: v.type }); }}>
              <span className="fn-var-name">{v.name}</span>
              <span className="fn-var-val">{String(v.value).slice(0, 24)}</span>
            </div>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { flowStep: FlowStepNode };

function App() {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [mockSets, setMockSets] = useState<string[]>([]);
  const [activeMock, setActiveMock] = useState<MockSet | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const lastNodeId = useRef<string | null>(null);
  // location key (source:line:frame:depth) -> nodeId, for loop/hit-count aggregation.
  const keyToNode = useRef<Map<string, string>>(new Map());
  const orderCounter = useRef(0);
  const lastDepth = useRef(0);
  // Every historical pause is keyed by its exact order, never by a collapsed
  // graph node — loop iteration #1 must not be overwritten by iteration #3.
  const [captures, setCaptures] = useState<Record<number, { frame: StackFrameDTO | null; scopes: ScopeDTO[] }>>({});
  const [timeline, setTimeline] = useState<Array<{ nodeId: string; order: number; label: string; hit: number }>>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedPauseOrder, setSelectedPauseOrder] = useState<number | null>(null);
  // Call Map: build the method-grouped tree from the pause stream.
  const treeBuilder = useRef<CallTreeBuilder>(new CallTreeBuilder());
  const [callTree, setCallTree] = useState<CallNode[]>([]);
  const [activeMethodId, setActiveMethodId] = useState<string | undefined>(undefined);
  const [memory, setMemory] = useState<MemorySample | undefined>(undefined);
  const [memorySeries, setMemorySeries] = useState<MemorySample[]>([]);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>('findings');
  const [contextTab, setContextTab] = useState<ContextTab>('inspector');
  const [dockTab, setDockTab] = useState<DockTab>('problems');
  const [dockOpen, setDockOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [baselines, setBaselines] = useState<string[]>([]);
  const [contracts, setContracts] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [contractResult, setContractResult] = useState<ContractResult | null>(null);
  const [curlDraft, setCurlDraft] = useState<string | null>(null);

  const [sessionName, setSessionName] = useState<string | null>(null);
  const [scopes, setScopes] = useState<ScopeDTO[]>([]);
  const [currentFrame, setCurrentFrame] = useState<StackFrameDTO | null>(null);
  const [expanded, setExpanded] = useState<Record<number, VariableDTO[]>>({});
  const [hideNoise, setHideNoise] = useState(true);
  const [allBps, setAllBps] = useState<AllBp[]>([]);
  const [mockInjection, setMockInjection] = useState<MockInjection | null>(null);
  const [report, setReport] = useState<{ content: string; savedTo?: string; verdict: string } | null>(null);
  // Headless-collection Python readiness — absent (null) until the host's
  // check resolves; the hint below only ever renders when ready === true, so
  // a workspace with no debugpy shows NOTHING for this feature, not a broken
  // affordance. See docs/TODO_PANEL_HEADLESS_COLLECT.md for the fuller feature
  // this is a stepping stone toward.
  const [pythonReady, setPythonReady] = useState<{ ready: boolean; reason?: string; version?: string } | null>(null);
  // Show the guide automatically the first time, so the tool explains itself
  // instead of waiting to be asked. Dismissal is remembered.
  const [showHelp, setShowHelp] = useState(() => {
    try { return localStorage.getItem('flowdbg.helpSeen') !== '1'; } catch { return false; }
  });
  const closeHelp = () => {
    setShowHelp(false);
    try { localStorage.setItem('flowdbg.helpSeen', '1'); } catch { /* storage may be blocked */ }
  };
  // Which API call (or external trigger) produced each pause order — lets the
  // Call Map be split per call instead of merging every pause into one tree.
  const [orderToCall, setOrderToCall] = useState<Record<number, string>>({});
  const [traceTab, setTraceTab] = useState<string>('all');
  // ReactFlow instance, so the view can re-fit as the trace grows (fitView only
  // applies on first render, which left long runs scrolled off-screen).
  const rfInstance = useRef<{ fitView: (o?: { duration?: number; padding?: number }) => void } | null>(null);
  const [results, setResults] = useState<CallResult[]>([]);
  const [running, setRunning] = useState(false);
  const [debugStatus, setDebugStatus] = useState<'none' | 'running' | 'paused' | 'ended'>('none');
  const [currentCall, setCurrentCall] = useState<{ id: string; name: string; index: number } | null>(null);
  const [completedRun, setCompletedRun] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 3500); }, []);

  const resetTrace = useCallback(() => {
    setNodes([]); setEdges([]); setScopes([]); setExpanded({}); setCurrentFrame(null);
    setCaptures({}); setTimeline([]); setSelectedNode(null); setSelectedPauseOrder(null);
    keyToNode.current = new Map();
    treeBuilder.current = new CallTreeBuilder();
    setCallTree([]); setActiveMethodId(undefined);
    setMemory(undefined); setMemorySeries([]);
    setOrderToCall({}); setTraceTab('all');
    orderCounter.current = 0; lastNodeId.current = null; lastDepth.current = 0;
  }, [setNodes, setEdges]);

  useEffect(() => {
    function onMessage(e: MessageEvent<ToWebview>) {
      const msg = e.data;
      switch (msg.kind) {
        case 'init':
          setScenario(msg.scenario);
          setMockSets(msg.mockSets);
          break;
        case 'session':
          if (msg.status === 'started') {
            setSessionName(msg.name ?? 'Debug session');
            setDebugStatus((s) => s === 'paused' ? s : 'running');
            if (!msg.restore) {
              resetTrace();
              setResults([]); setCompletedRun(false); setRunning(false); setCurrentCall(null);
              setRuns([]); setActiveRunId(undefined);
            }
          } else {
            setSessionName(null);
            setDebugStatus('ended');
            setRunning(false);
            setCurrentCall(null);
          }
          break;
        case 'debugStatus': {
          setDebugStatus(msg.status);
          if (msg.status === 'paused' || msg.status === 'running') {
            const runStatus: RunSummary['status'] = msg.status;
            setRuns((items) => items.map((run, index) => index === 0 ? { ...run, status: runStatus } : run));
          }
          break;
        }
        case 'stopped': {
          setCurrentFrame(msg.frame);
          setScopes(msg.scopes);
          setExpanded({});
          setSelectedNode(null);

          const depth = Math.max(0, (msg.stack?.length ?? 1) - 1);
          const fn = msg.frame?.name ?? 'step';
          const loc = msg.frame ? `${msg.frame.source ?? '?'}:${msg.frame.line}` : `step-${msg.step}`;
          // Loop detection: same function + line + stack depth => same node (an iteration).
          const locKey = `${fn}@${loc}#${depth}`;
          const existingId = keyToNode.current.get(locKey);
          orderCounter.current += 1;
          const order = orderCounter.current;
          setCaptures((c) => ({ ...c, [order]: { frame: msg.frame, scopes: msg.scopes } }));
          setSelectedPauseOrder(null); // follow live until the user picks history
          setDebugStatus('paused');
          const dbTag = (msg as { dbMode?: 'real' | 'mocked' }).dbMode;
          const callOwner = msg.callId ?? 'external';
          const runId = msg.runId ?? 'external-current';
          setActiveRunId(runId);
          setRuns((items) => {
            const existing = items.find((run) => run.id === runId);
            if (existing) return items.map((run) => run.id === runId
              ? { ...run, status: 'paused', pauses: Math.max(run.pauses + 1, msg.step) }
              : run);
            return [{
              id: runId, label: msg.external ? 'Postman / external' : 'Scenario run',
              source: msg.external ? 'external' : 'scenario', status: 'paused',
              pauses: msg.step, startedAt: Date.now(),
            }, ...items];
          });
          setOrderToCall((m) => ({ ...m, [order]: callOwner }));
          // Feed the async-resilient Call Map tree from the same stream.
          const stackDepth = msg.stack?.length ?? 1;
          const asyncGap = (msg.stack ?? []).some((f) => /async|Promise|microtask/i.test(f.name));
          const topVars = msg.scopes?.[0]?.variables?.map((v) => ({ name: v.name, value: v.value, type: v.type })) ?? [];
          const transition = treeBuilder.current.push({
            order, frame: msg.frame, stackDepth, vars: topVars, dbMode: dbTag, asyncGap,
            heapUsed: msg.memory?.heapUsed,
            exception: msg.exception,
          });
          setActiveMethodId(transition.kind === 'return' ? transition.to?.id : transition.node.id);
          setCallTree([...treeBuilder.current.getRoots()]);
          if (msg.memory) {
            const mem = msg.memory;
            setMemory(mem);
            setMemorySeries((s) => [...s, { ...mem, order }].slice(-120));
          }
          if (msg.exception) flash(`✗ ${msg.exception.type ?? 'Exception'}: ${msg.exception.message}`);

          if (existingId) {
            // Revisit → this is a loop iteration (or re-entry). Bump hit count, refresh vars.
            setNodes((nds) =>
              nds.map((n) =>
                n.id === existingId
                  ? { ...n, style: NODE_ACTIVE, data: { ...n.data, hit: (n.data.hit ?? 1) + 1, order, scopes: msg.scopes, frame: msg.frame, dbMode: dbTag } }
                  : { ...n, style: NODE_PAST }
              )
            );
            setTimeline((t) => [...t, { nodeId: existingId, order, label: `${fn} ${loc}`, hit: (t.filter((x) => x.nodeId === existingId).length + 1) }]);
            // Loop-back edge from the previous node to this existing node.
            if (lastNodeId.current && lastNodeId.current !== existingId) {
              const backId = `back-${lastNodeId.current}->${existingId}-${order}`;
              setEdges((eds) => [
                ...eds,
                {
                  id: backId, source: lastNodeId.current!, target: existingId,
                  type: 'smoothstep', animated: true,
                  style: { stroke: '#f59e0b', strokeDasharray: '5 4' },
                  label: '↺ loop', labelStyle: { fill: '#f59e0b', fontSize: 10 },
                  markerEnd: { type: MarkerType.ArrowClosed, color: '#f59e0b' },
                },
              ]);
            }
            lastNodeId.current = existingId;
          } else {
            // New location → new node, indented by stack depth (call hierarchy lane).
            const id = `node-${order}`;
            const nodeCount = keyToNode.current.size;
            const newNode: Node = {
              id, type: 'flowStep',
              data: { fn, loc, order, hit: 1, depth, scopes: msg.scopes, frame: msg.frame, dbMode: dbTag, external: msg.external },
              position: { x: 40 + depth * 60, y: 20 + nodeCount * 96 },
              style: NODE_ACTIVE,
            };
            setNodes((nds) => [...nds.map((n) => ({ ...n, style: NODE_PAST })), newNode]);
            setTimeline((t) => [...t, { nodeId: id, order, label: `${fn} ${loc}`, hit: 1 }]);
            keyToNode.current.set(locKey, id);
            if (lastNodeId.current) {
              const deeper = depth > lastDepth.current;
              setEdges((eds) => [
                ...eds,
                {
                  id: `${lastNodeId.current}->${id}`, source: lastNodeId.current!, target: id,
                  type: 'smoothstep', animated: true,
                  style: { stroke: deeper ? '#38bdf8' : '#6366f1' },
                  label: deeper ? '↳ call' : undefined,
                  labelStyle: { fill: '#38bdf8', fontSize: 10 },
                  markerEnd: { type: MarkerType.ArrowClosed, color: deeper ? '#38bdf8' : '#6366f1' },
                },
              ]);
            }
            lastNodeId.current = id;
          }
          lastDepth.current = depth;
          break;
        }
        case 'variables':
          setExpanded((p) => ({ ...p, [msg.variablesReference]: msg.variables }));
          break;
        case 'variableSet':
          flash(msg.ok ? `Set ${msg.name} = ${msg.value}` : `Set failed: ${msg.message}`);
          break;
        case 'runStarted':
          resetTrace();
          setRunning(true); setResults([]); setCurrentCall(null); setCompletedRun(false);
          setActiveRunId(msg.runId); setEvidenceTab('findings');
          setRuns((items) => [{
            id: msg.runId, label: 'Scenario run', source: 'scenario',
            status: 'running', pauses: 0, startedAt: Date.now(),
          }, ...items.filter((run) => run.id !== msg.runId)]);
          break;
        case 'callStarted':
          setCurrentCall({ id: msg.callId, name: msg.name, index: msg.index });
          break;
        case 'callResult':
          setResults((r) => [...r, msg.result]);
          break;
        case 'runFinished':
          setRunning(false); setCurrentCall(null); setResults(msg.results);
          setCompletedRun(!msg.cancelled && msg.results.length > 0);
          setActiveRunId(msg.runId);
          setRuns((items) => {
            const next: RunSummary = {
              id: msg.runId, label: 'Scenario run', source: 'scenario',
              status: msg.cancelled ? 'cancelled' : 'completed',
              pauses: items.find((run) => run.id === msg.runId)?.pauses ?? 0,
              startedAt: items.find((run) => run.id === msg.runId)?.startedAt ?? Date.now(),
              resultCount: msg.results.length,
            };
            return [next, ...items.filter((run) => run.id !== msg.runId)];
          });
          if (msg.cancelled) flash('Run cancelled');
          break;
        case 'mockSet':
          setActiveMock(msg.mockSet);
          flash(`Loaded mock set "${msg.mockSet.name}"`);
          break;
        case 'mockInjection':
          setMockInjection(msg.report);
          break;
        case 'reportReady':
          setReport({ content: msg.content, savedTo: msg.savedTo, verdict: msg.verdict });
          flash(msg.savedTo ? `Report saved: ${msg.savedTo}` : 'Report generated');
          break;
        case 'pythonReadiness':
          setPythonReady({ ready: msg.ready, reason: msg.reason, version: msg.version });
          break;
        case 'baselines':
          setBaselines(msg.names); setContracts(msg.contracts);
          break;
        case 'baselineSaved':
          flash(`Saved baseline "${msg.name}"`);
          break;
        case 'comparisonReady':
          setComparison({ baseline: msg.baseline, outcome: msg.outcome, markdown: msg.markdown, entries: msg.entries });
          setEvidenceTab('prove');
          flash(`Comparison vs ${msg.baseline}: ${msg.outcome}`);
          break;
        case 'contractSaved':
          setContracts((items) => items.includes(msg.name) ? items : [...items, msg.name]);
          flash(`Generated contract "${msg.name}"`);
          break;
        case 'contractVerified':
          setContractResult({ name: msg.name, pass: msg.pass, explanation: msg.explanation, violations: msg.violations });
          setEvidenceTab('prove');
          flash(`Contract "${msg.name}": ${msg.pass ? 'PASS' : 'FAIL'}`);
          break;
        case 'breakpointsApplied':
          setScenario((s) => (s ? { ...s, breakpoints: msg.breakpoints } : s));
          if (msg.message) flash(msg.message);
          break;
        case 'allBreakpoints':
          setAllBps(msg.entries);
          break;
        case 'testGenerated':
          flash(`Test written: ${msg.path}`);
          break;
        case 'info':
          flash(msg.message);
          break;
        case 'error':
          flash(`⚠ ${msg.message}`);
          break;
      }
    }
    window.addEventListener('message', onMessage);
    send({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [setNodes, setEdges, flash, resetTrace]);

  // Persist scenario edits host-side (debounced) so a reload / "Move Editor into
  // New Window" / test generation sees the CURRENT scenario, not the default.
  useEffect(() => {
    if (!scenario) return;
    const t = setTimeout(() => send({ kind: 'saveScenario', scenario }), 400);
    return () => clearTimeout(t);
  }, [scenario]);

  // Keep the whole trace in view as new pauses arrive.
  useEffect(() => {
    if (!nodes.length) return;
    const t = setTimeout(() => rfInstance.current?.fitView({ duration: 300, padding: 0.2 }), 80);
    return () => clearTimeout(t);
  }, [nodes.length]);

  // Escape closes the report and cURL modals (they set their own state).
  useEffect(() => {
    if (!report && curlDraft === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setReport(null); setCurlDraft(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [report, curlDraft]);

  if (!scenario) {
    return <div className="loading">Loading…</div>;
  }
  const updateCall = (id: string, patch: Partial<ApiCall>) =>
    setScenario((s) => s && { ...s, calls: s.calls.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const addCall = () =>
    setScenario((s) => s && { ...s, calls: [...s.calls, { id: uid(), name: `Call ${s.calls.length + 1}`, method: 'GET', url: 'http://127.0.0.1:3000/' }] });
  const removeCall = (id: string) =>
    setScenario((s) => s && { ...s, calls: s.calls.filter((c) => c.id !== id) });
  const duplicateCall = (id: string) =>
    setScenario((s) => {
      if (!s) return s;
      const index = s.calls.findIndex((c) => c.id === id);
      if (index < 0) return s;
      const source = s.calls[index];
      const copy: ApiCall = { ...source, id: uid(), name: `${source.name} (copy)`, extract: source.extract ? { ...source.extract } : undefined, headers: source.headers ? { ...source.headers } : undefined };
      const calls = [...s.calls];
      calls.splice(index + 1, 0, copy);
      return { ...s, calls };
    });
  const moveCall = (id: string, direction: -1 | 1) =>
    setScenario((s) => {
      if (!s) return s;
      const index = s.calls.findIndex((c) => c.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= s.calls.length) return s;
      const calls = [...s.calls];
      [calls[index], calls[target]] = [calls[target], calls[index]];
      return { ...s, calls };
    });

  const run = () => scenario && send({ kind: 'runScenario', scenario });

  // A call is "broken" if it is enabled and references a ${var} that only an
  // earlier DISABLED call would have produced via extract. Warn, don't block.
  const brokenVarFor = (idx: number): string | undefined => {
    if (!scenario) return undefined;
    const call = scenario.calls[idx];
    if (call.enabled === false) return undefined;
    const refs = new Set<string>();
    const scan = (s?: string) => { if (s) for (const m of s.matchAll(/\$\{(\w+)\}/g)) refs.add(m[1]); };
    scan(call.url); scan(call.body);
    if (!refs.size) return undefined;
    for (const ref of refs) {
      // find any earlier call that produces this var via extract
      let producedByEnabled = false, producedAtAll = false;
      for (let j = 0; j < idx; j++) {
        const prev = scenario.calls[j];
        if (prev.extract && Object.keys(prev.extract).includes(ref)) {
          producedAtAll = true;
          if (prev.enabled !== false) producedByEnabled = true;
        }
      }
      if (producedAtAll && !producedByEnabled) return ref;
    }
    return undefined;
  };
  const enabledCount = scenario ? scenario.calls.filter((c) => c.enabled !== false).length : 0;
  const anyDisabled = scenario ? scenario.calls.some((c) => c.enabled === false) : false;
  const outcome = deriveOutcome(callTree, memorySeries);

  const selectPause = (order: number) => {
    const item = timeline.find((pause) => pause.order === order);
    const capture = captures[order];
    if (!item || !capture) return;
    setSelectedNode(item.nodeId); setSelectedPauseOrder(order);
    setCurrentFrame(capture.frame); setScopes(capture.scopes); setExpanded({});
    setContextTab('inspector');
  };
  const openFindingSource = (where: string) => {
    const match = /^(.*):(\d+)$/.exec(where);
    if (match) send({ kind: 'openSource', file: match[1], line: Number(match[2]) });
  };
  const chooseDock = (tab: DockTab) => {
    if (dockOpen && dockTab === tab) setDockOpen(false);
    else { setDockTab(tab); setDockOpen(true); }
  };

  return (
    <>
      <div className="product-shell">
        <RuntimeBar
          sessionName={sessionName}
          status={debugStatus}
          frame={currentFrame}
          runningCall={running && currentCall ? `Request ${currentCall.index + 1}: ${currentCall.name}` : undefined}
          onControl={(action) => send({ kind: 'debugControl', action })}
        />

        <OutcomeStrip outcome={outcome}
          onReport={() => send({ kind: 'generateReport', format: 'markdown' })} />

        <div className="shell-body">
          <RunRail runs={runs} activeRunId={activeRunId} />

          <ShellPanel className="shell-evidence">
            <EvidenceNav active={evidenceTab} onChange={setEvidenceTab} counts={{
              findings: outcome.findings.length,
              map: callTree.length,
              timeline: timeline.length,
              response: results.length,
            }} />

            <div className="shell-evidence-body">
              {evidenceTab === 'findings' && (
                callTree.length === 0
                  ? <PreconditionState sessionName={sessionName} bpCount={allBps.filter((b) => b.enabled).length} kind="map"
                      onPostman={() => setContextTab('breakpoints')} onScenario={() => setContextTab('request')} onAgent={() => setShowHelp(true)} />
                  : <FindingsView findings={outcome.findings} onOpenSource={openFindingSource} onSelectPause={selectPause} />
              )}

              {evidenceTab === 'map' && (
                callTree.length === 0
                  ? <PreconditionState sessionName={sessionName} bpCount={allBps.filter((b) => b.enabled).length} kind="map"
                      onPostman={() => setContextTab('breakpoints')} onScenario={() => setContextTab('request')} onAgent={() => setShowHelp(true)} />
                  : (() => {
                      const ownerOf = (root: { firstOrder: number }) => orderToCall[root.firstOrder] ?? 'external';
                      const present = [...new Set(callTree.map(ownerOf))];
                      const tabs = present.length > 1 ? ['all', ...present] : [];
                      const shown = traceTab === 'all' ? callTree : callTree.filter((root) => ownerOf(root) === traceTab);
                      const labelFor = (tab: string) => {
                        if (tab === 'all') return `All (${callTree.length})`;
                        if (tab === 'external') return 'External (Postman/curl)';
                        const call = scenario.calls.find((item) => item.id === tab);
                        return call ? `${call.method} ${call.name || call.url.replace(/^https?:\/\/[^/]+/, '')}` : tab;
                      };
                      return <>
                        {tabs.length > 0 && <div className="trace-tabs">{tabs.map((tab) => (
                          <button key={tab} className={`tt ${traceTab === tab ? 'on' : ''}`} onClick={() => setTraceTab(tab)}>{labelFor(tab)}</button>
                        ))}</div>}
                        <CallMap roots={shown} send={send} activeId={activeMethodId} memory={memory} memorySeries={memorySeries}
                          bookends={scenario.calls.filter((call) => call.enabled !== false)
                            .filter((call) => traceTab === 'all' || call.id === traceTab)
                            .map((call) => {
                              const result = results.find((item) => item.callId === call.id);
                              return { method: call.method, url: call.url, status: result?.status ?? null, ok: result?.ok, ms: result?.durationMs };
                            })} />
                      </>;
                    })()
              )}

              {evidenceTab === 'graph' && (
                nodes.length === 0
                  ? <PreconditionState sessionName={sessionName} bpCount={allBps.filter((b) => b.enabled).length} kind="graph"
                      onPostman={() => setContextTab('breakpoints')} onScenario={() => setContextTab('request')} onAgent={() => setShowHelp(true)} />
                  : <div className="shell-graph">
                      <ReactFlow
                        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
                        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                        onNodeClick={(_event, node) => {
                          setSelectedNode(node.id);
                          const hit = [...timeline].reverse().find((pause) => pause.nodeId === node.id);
                          const capture = hit ? captures[hit.order] : undefined;
                          setSelectedPauseOrder(hit?.order ?? null);
                          if (capture) { setCurrentFrame(capture.frame); setScopes(capture.scopes); setExpanded({}); setContextTab('inspector'); }
                        }}
                        onInit={(instance) => { rfInstance.current = instance; }} fitView attributionPosition="bottom-right">
                        <Background color="#334155" gap={16} size={1} />
                        <Controls />
                        <MiniMap pannable zoomable style={{ background: 'rgba(11,15,30,0.9)', border: '1px solid rgba(255,255,255,0.1)' }}
                          nodeColor={(node) => node.id === selectedNode ? '#6366f1' : '#334155'} />
                      </ReactFlow>
                    </div>
              )}

              {evidenceTab === 'timeline' && (
                <div className="timeline-page">
                  {!timeline.length && <div className="shell-empty">No pauses captured yet.</div>}
                  {timeline.map((pause) => (
                    <button key={pause.order} className={`timeline-row ${selectedPauseOrder === pause.order ? 'active' : ''}`}
                      onClick={() => selectPause(pause.order)}>
                      <span>#{pause.order}</span><strong>{pause.label.split(' ')[0]}</strong>
                      <code>{pause.label.slice(pause.label.indexOf(' ') + 1)}</code>
                      {pause.hit > 1 && <em>×{pause.hit}</em>}
                    </button>
                  ))}
                </div>
              )}

              {evidenceTab === 'response' && (
                <div className="response-page">
                  {!results.length && <div className="shell-empty">Run a scenario to capture request responses. External Postman calls currently contribute debugger evidence only.</div>}
                  {results.map((result) => (
                    <article className={`response-card ${result.ok ? 'ok' : 'bad'}`} key={result.callId}>
                      <div><strong>{result.name}</strong><span>{result.status ?? 'ERR'} · {result.durationMs}ms · {result.pauseCount} pauses</span></div>
                      {result.error && <p>{result.error}</p>}
                      {result.responseBody && <button className="btn tiny" onClick={() => openValue({ name: `${result.name} response`, value: result.responseBody! })}>View response body</button>}
                    </article>
                  ))}
                </div>
              )}

              {evidenceTab === 'prove' && (
                <div className="prove-page">
                  <ProveView
                    hasEvidence={callTree.length > 0}
                    baselines={baselines}
                    contracts={contracts}
                    comparison={comparison}
                    contract={contractResult}
                    onAction={(action) => send(action)}
                    onViewMarkdown={(title, markdown) => openValue({ name: title, value: markdown })}
                  />
                </div>
              )}
            </div>

            <ProblemsDock
              tab={dockTab} open={dockOpen} onTab={chooseDock}
              findings={outcome.findings} timeline={timeline}
              selectedOrder={selectedPauseOrder} onSelectPause={selectPause}
            />
          </ShellPanel>

          <ShellPanel className="shell-context">
            <ContextNav active={contextTab} onChange={setContextTab}
              breakpointCount={allBps.filter((bp) => bp.enabled).length} />
            <div className="shell-context-body">
              {contextTab === 'inspector' && <>
                {currentFrame && <div className="context-location">
                  {selectedPauseOrder != null ? `Pause #${selectedPauseOrder}` : 'Live'} at <b>{currentFrame.name}</b> — {currentFrame.source ?? '?'}:{currentFrame.line}
                </div>}
                {scopes.length === 0 && <div className="shell-empty">No variables yet. Pause the debugger or select a timeline entry.</div>}
                {scopes.length > 0 && <label className="insp-filter" title="Hide framework/module noise">
                  <input type="checkbox" checked={hideNoise} onChange={(event) => setHideNoise(event.target.checked)} /> Hide framework noise
                </label>}
                {scopes.map((scope) => {
                  const secondary = /closure|global/i.test(scope.name);
                  const all = scope.variables;
                  const shown = hideNoise ? all.filter((variable) => !isNoise(variable)) : all;
                  const hiddenCount = all.length - shown.length;
                  const ordered = [...shown].sort(byReadability);
                  return <ScopeBlock key={scope.variablesReference} name={scope.name} defaultOpen={!secondary} count={all.length}>
                    <div className="var-tree">
                      {all.length === 0 ? <div className="var-empty">(expensive scope — not auto-loaded)</div>
                        : ordered.length === 0 ? <div className="var-empty">(all {all.length} entries hidden as noise)</div>
                        : <>{ordered.map((variable) => <VariableRow key={`${scope.variablesReference}-${variable.name}`}
                            variable={variable} scopeRef={scope.variablesReference} expanded={expanded} depth={0} />)}
                          {hiddenCount > 0 && <div className="var-hidden-note">+ {hiddenCount} framework/noise entr{hiddenCount === 1 ? 'y' : 'ies'} hidden</div>}</>}
                    </div>
                  </ScopeBlock>;
                })}
              </>}

              {contextTab === 'request' && <div className="context-request">
                <label className="field-label">Scenario
                  <input className="scn-name" value={scenario.name} onChange={(event) => setScenario({ ...scenario, name: event.target.value })} />
                </label>
                <label className="field-label">Dependency mode
                  <select value={scenario.dbMode} onChange={(event) => setScenario({ ...scenario, dbMode: event.target.value as 'real' | 'mocked' })}>
                    <option value="real">Real dependencies</option><option value="mocked">Mocked (fail-closed)</option>
                  </select>
                </label>
                <div className="context-call-list">
                  <RequestEditor
                    calls={scenario.calls}
                    results={results}
                    brokenVarFor={brokenVarFor}
                    onUpdate={(id, patch) => updateCall(id, patch as Partial<ApiCall>)}
                    onRemove={removeCall}
                    onDuplicate={duplicateCall}
                    onMove={moveCall}
                  />
                </div>
                <div className="context-actions">
                  <button className="btn" onClick={addCall}>+ Add request</button>
                  <button className="btn" onClick={() => setCurlDraft('')}>Paste cURL</button>
                </div>
              </div>}

              {contextTab === 'breakpoints' && <BreakpointsPanel scenario={scenario} setScenario={setScenario} allBps={allBps}
                sessionActive={debugStatus !== 'none' && debugStatus !== 'ended'} />}

              {contextTab === 'mocks' && <MockPanel key={activeMock?.name ?? 'no-mock'} scenario={scenario} mockSets={mockSets}
                activeMock={activeMock} injection={mockInjection}
                onSetDbMode={(mode) => setScenario((value) => value ? { ...value, dbMode: mode } : value)} />}
            </div>
          </ShellPanel>
        </div>

        <div className="shell-action-bar">
          <button className="btn primary" disabled={running || enabledCount === 0} onClick={run}>
            {anyDisabled ? `▶ Run selected (${enabledCount})` : '▶ Run scenario'}
          </button>
          {running && <button className="btn danger" onClick={() => send({ kind: 'cancelRun' })}>■ Cancel request</button>}
          <button className="btn" onClick={() => setContextTab('request')}>Edit scenario</button>
          <button className="btn" onClick={() => setContextTab('breakpoints')}>Breakpoints</button>
          {pythonReady?.ready && <span className="hdr-pybadge" title={`debugpy ${pythonReady.version ?? ''} ready for headless collection`}>Python ready</span>}
          <span className="shell-action-spacer" />
          <button className="btn" disabled={!completedRun || running} onClick={() => send({ kind: 'generateTest', scenarioId: scenario.id })}>Save as unit test</button>
          <button className="btn" onClick={() => setShowHelp(true)}>Help</button>
          <button className="btn" onClick={() => send({ kind: 'openInNewWindow' })}>New window</button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
      <ValueViewerHost />
      {showHelp && <HelpDrawer onClose={closeHelp} send={send} pythonReady={pythonReady?.ready ?? false} />}
      {curlDraft !== null && (() => {
        const parsed = curlDraft.trim() ? parseCurl(curlDraft) : null;
        const importIt = () => {
          if (!parsed) return;
          setScenario((value) => value && { ...value, calls: [...value.calls, { id: uid(), name: `Call ${value.calls.length + 1}`, ...parsed }] });
          setCurlDraft(null);
          setContextTab('request');
          flash(`Added ${parsed.method} ${parsed.url}`);
        };
        return (
          <div className="vv-backdrop" onClick={() => setCurlDraft(null)}>
            <div className="vv curl-dialog" role="dialog" aria-modal="true" aria-label="Import a cURL command" onClick={(e) => e.stopPropagation()}>
              <div className="vv-head">
                <span className="vv-name">Import a cURL command</span>
                <span className="vv-meta">from Postman → Code → cURL, or any terminal</span>
                <button className="vv-btn vv-x" title="Close (Esc)" onClick={() => setCurlDraft(null)}>✕</button>
              </div>
              <div className="curl-body">
                <textarea autoFocus value={curlDraft} placeholder="curl -X POST 'http://…' -H 'Authorization: …' -d '{…}'"
                  onChange={(e) => setCurlDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setCurlDraft(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) importIt(); }} />
                {curlDraft.trim() && (
                  parsed
                    ? <div className="curl-preview ok"><b>{parsed.method}</b> {parsed.url}
                        {parsed.headers && <span> · {Object.keys(parsed.headers).length} header(s)</span>}
                        {parsed.body && <span> · body {parsed.body.length} chars</span>}</div>
                    : <div className="curl-preview bad">Not a recognizable curl command yet.</div>
                )}
              </div>
              <div className="curl-actions">
                <button className="btn" onClick={() => setCurlDraft(null)}>Cancel</button>
                <button className="btn primary" disabled={!parsed} onClick={importIt}>Import request</button>
              </div>
            </div>
          </div>
        );
      })()}
      {report && (
        <div className="vv-backdrop" onClick={() => setReport(null)}>
          <div className="vv" role="dialog" aria-modal="true" aria-label="Test report" onClick={(e) => e.stopPropagation()}>
            <div className="vv-head">
              <span className="vv-name">Test report</span>
              <span className="vv-tag">{report.verdict.split('—')[0].trim()}</span>
              {report.savedTo && <span className="vv-meta" title={report.savedTo}>saved to .flow-debugger/reports/</span>}
              <CopyButton text={report.content} label="Copy markdown" />
              <button className="vv-btn vv-x" onClick={() => setReport(null)}>✕</button>
            </div>
            <pre className="vv-body">{report.content}</pre>
          </div>
        </div>
      )}
    </>
  );
}

function VariableRow({
  variable, scopeRef, expanded, depth,
}: {
  variable: VariableDTO; scopeRef: number; expanded: Record<number, VariableDTO[]>; depth: number;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(variable.value);
  const expandable = variable.variablesReference > 0;
  const children = expanded[variable.variablesReference];
  // Only primitives are safely editable via DAP setVariable; objects are not.
  const editable = !expandable && isEditablePrimitive(variable.value);

  const toggle = () => {
    if (!expandable) return;
    if (!open && !children) send({ kind: 'expand', variablesReference: variable.variablesReference });
    setOpen((o) => !o);
  };
  const startEdit = () => { setDraft(variable.value); setEditing(true); };
  const commit = () => {
    setEditing(false);
    if (draft !== variable.value) {
      send({ kind: 'setVariable', variablesReference: scopeRef, name: variable.name, value: draft });
    }
  };
  const cancel = () => { setDraft(variable.value); setEditing(false); };

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div className={`var-row ${isNoise(variable) ? 'noise' : ''}`}>
        <span className="var-caret" onClick={toggle} style={{ cursor: expandable ? 'pointer' : 'default' }}>
          {expandable ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="var-name">{variable.name}</span>
        <span className="var-sep">:</span>
        {editing ? (
          <span className="var-edit-wrap">
            <input className="var-edit" autoFocus value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }} />
            <button className="var-edit-ok" onMouseDown={(e) => { e.preventDefault(); commit(); }} title="Save (Enter)">✓</button>
            <button className="var-edit-x" onMouseDown={(e) => { e.preventDefault(); cancel(); }} title="Cancel (Esc)">✕</button>
          </span>
        ) : (
          <>
            <span
              className={`var-value ${expandable ? 'obj' : ''} peek`}
              role="button" tabIndex={0}
              title="View the full value" aria-label={`View full value of ${variable.name}`}
              onClick={() => openValue({ name: variable.name, value: variable.value, kind: variable.type })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openValue({ name: variable.name, value: variable.value, kind: variable.type }); } }}
            >
              {previewValue(variable.value)}
            </span>
            {editable && (
              <button className="var-edit-btn" onClick={startEdit} title="Edit this value live (setVariable)">✎</button>
            )}
          </>
        )}
      </div>
      {open && children?.map((child) => (
        <VariableRow key={`${variable.variablesReference}-${child.name}`}
          variable={child} scopeRef={variable.variablesReference} expanded={expanded} depth={depth + 1} />
      ))}
    </div>
  );
}

/** Collapsible scope block (Local open, Closure/Global collapsed by default). */function ScopeBlock({ name, count, defaultOpen, children }: {
  name: string; count: number; defaultOpen: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="scope-block" style={{ marginBottom: 14 }}>
      <div className="scope-title" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        style={{ cursor: 'pointer' }}>
        <span className="scope-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>{name}<span className="scope-count">{count}</span>
      </div>
      {open && children}
    </div>
  );
}

/** A variable is "noise" if it is a framework/module import, an empty `this`,
 *  or a big built-in request/response object — never what you inspect. */
function isNoise(v: VariableDTO): boolean {
  const n = v.name;
  if (n === 'this' && (v.value === 'undefined' || v.value === 'null')) return true;
  if (/_\d+$/.test(n)) return true; // TS-compiled module imports: AllocationService_1, be_stdlib_2
  if (/^(exports|module|require|__|globalThis)$/.test(n)) return true;
  if (/^(IncomingMessage|ServerResponse|Socket|Timeout|TLSSocket)\b/.test(v.value)) return true;
  return false;
}

/** Sort primitives before objects, noise last, otherwise by name. */
function byReadability(a: VariableDTO, b: VariableDTO): number {
  const rank = (v: VariableDTO) => (isNoise(v) ? 2 : v.variablesReference > 0 ? 1 : 0);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : a.name.localeCompare(b.name);
}

/** Only quote-wrapped strings, numbers, booleans, null/undefined are safely
 *  editable through DAP setVariable — not object/array previews. */
function isEditablePrimitive(value: string): boolean {
  return /^('.*'|".*"|-?\d+(\.\d+)?|true|false|null|undefined)$/.test(value.trim());
}

/** Truncate long object dumps so a row stays one line; full value on click. */
function previewValue(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine;
}

/** Human label + badge class for the unified `source` column. */
const BP_SOURCE_META: Record<UnifiedBpRow['source'], { label: string; dot: string }> = {
  you: { label: 'you', dot: 'manual' },
  scenario: { label: 'scenario', dot: 'scenario' },
  agent: { label: 'agent', dot: 'scenario' },
};

function BreakpointsPanel({
  scenario, setScenario, allBps, sessionActive,
}: {
  scenario: Scenario; setScenario: Dispatch<SetStateAction<Scenario | null>>; allBps: AllBp[]; sessionActive: boolean;
}) {
  const [file, setFile] = useState('');
  const [line, setLine] = useState('');
  const bps = scenario.breakpoints ?? [];

  const setBps = (next: Breakpoint[]) => setScenario((s) => (s ? { ...s, breakpoints: next } : s));
  const add = () => {
    const ln = parseInt(line, 10);
    if (!file.trim() || !Number.isInteger(ln) || ln < 1) return;
    setBps([...bps, { file: file.trim(), line: ln, enabled: true }]);
    setFile(''); setLine('');
  };
  const toggle = (i: number) => setBps(bps.map((b, j) => (j === i ? { ...b, enabled: b.enabled === false } : b)));
  const setCondition = (i: number, condition: string) =>
    setBps(bps.map((b, j) => (j === i ? { ...b, condition: condition || undefined } : b)));
  const remove = (i: number) => setBps(bps.filter((_, j) => j !== i));
  const apply = () => send({ kind: 'applyBreakpoints', breakpoints: bps });
  const clear = () => { setBps([]); send({ kind: 'clearBreakpoints' }); };

  // One unified model: scenario rows (editable) + editor-only rows (read-only).
  const rows = mergeBreakpoints(bps, allBps, { sessionActive });

  return (
    <div className="bp-panel">
      <div className="bp-head">
        <span>Breakpoints ({bps.filter((b) => b.enabled !== false).length})</span>
        <span className="bp-actions">
          <button className="btn" onClick={apply} title="Set these breakpoints in the debugger">Apply</button>
          <button className="btn" onClick={clear} title="Remove all">Clear</button>
        </span>
      </div>
      {rows.length === 0
        ? <div className="bp-empty">No breakpoints yet. Set them in the editor gutter, add one here, or let an AI agent set them from a test flow.</div>
        : (
          <table className="bp-table" aria-label="Breakpoints">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">On</th>
                <th scope="col" title="Enabled while a debug session is attached — not the debugger's verified-bound flag.">Bound</th>
                <th scope="col">Location</th>
                <th scope="col">Condition</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = BP_SOURCE_META[row.source];
                const loc = `${row.file}:${row.line}`;
                return (
                  <tr className={`bp-trow ${row.enabled ? '' : 'off'}`} key={row.key}>
                    <td className="bp-src">
                      <i className={`bp-dot ${meta.dot}`} aria-hidden="true" />{meta.label}
                    </td>
                    <td className="bp-on">
                      {row.editable
                        ? <input type="checkbox" checked={row.enabled}
                            aria-label={`Toggle breakpoint ${loc}`}
                            onChange={() => toggle(row.scenarioIndex)} />
                        : <span className="bp-ro" title="Toggle in the editor gutter">{row.enabled ? 'on' : 'off'}</span>}
                    </td>
                    <td className="bp-bound">
                      {row.bound === null
                        ? <span className="bp-bound-badge unknown" title="No debug session attached">—</span>
                        : <span className={`bp-bound-badge ${row.bound ? 'yes' : 'no'}`}
                            title={row.bound ? 'Enabled while a debug session is attached' : 'Not active in the attached debug session'}>
                            {row.bound ? 'bound' : 'off'}
                          </span>}
                    </td>
                    <td className="bp-loc-cell">
                      {row.editable
                        ? <span className="bp-loc">{loc}</span>
                        : <button type="button" className="bp-open bp-loc" title="Open in editor"
                            aria-label={`Open ${loc} in editor`}
                            onClick={() => send({ kind: 'openSource', file: row.file, line: row.line })}>{loc}</button>}
                    </td>
                    <td className="bp-cond-cell">
                      {row.editable
                        ? <input className="bp-cond-input" value={row.condition ?? ''} placeholder="condition"
                            aria-label={`Condition for breakpoint ${loc}`}
                            onChange={(e) => setCondition(row.scenarioIndex, e.target.value)} />
                        : (row.condition ? <span className="bp-cond" title="condition">if {row.condition}</span> : <span className="bp-cond-none">—</span>)}
                    </td>
                    <td className="bp-row-actions">
                      {row.editable && (
                        <button type="button" className="call-del" aria-label={`Remove breakpoint ${loc}`}
                          title="Remove" onClick={() => remove(row.scenarioIndex)}>✕</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      <div className="bp-add">
        <input className="bp-file" placeholder="src/handler.ts" value={file} onChange={(e) => setFile(e.target.value)}
          aria-label="Breakpoint file" />
        <input className="bp-line" placeholder="line" value={line} onChange={(e) => setLine(e.target.value)}
          aria-label="Breakpoint line" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" onClick={add}>+ Add</button>
      </div>
    </div>
  );
}

/** First-run / empty state that names the EXACT missing precondition instead of
 *  a generic hint — the single biggest source of "why is nothing showing?". */
function PreconditionState({ sessionName, bpCount, kind, onPostman, onScenario, onAgent }: {
  sessionName: string | null; bpCount: number; kind: 'map' | 'graph';
  onPostman?: () => void; onScenario?: () => void; onAgent?: () => void;
}) {
  const step = (done: boolean, active: boolean, title: string, detail: string) => (
    <div className={`pc-step ${done ? 'done' : active ? 'active' : 'todo'}`}>
      <span className="pc-mark">{done ? '✓' : active ? '➤' : '○'}</span>
      <span className="pc-text"><b>{title}</b><span>{detail}</span></span>
    </div>
  );
  const hasSession = !!sessionName;
  const hasBps = bpCount > 0;
  return (
    <div className="pc-wrap">
      <div className="pc-title">{kind === 'map' ? 'No Call Map yet' : 'No flow captured yet'}</div>
      <div className="pc-sub">Pick how you want to capture runtime behaviour:</div>
      {(onPostman || onScenario || onAgent) && (
        <div className="pc-paths">
          <button className="pc-path" onClick={onPostman} disabled={!onPostman}>
            <b>Observe a Postman / curl request</b>
            <span>Set breakpoints, then hit the endpoint from any client. No scenario needed.</span>
          </button>
          <button className="pc-path" onClick={onScenario} disabled={!onScenario}>
            <b>Run a saved API scenario</b>
            <span>Define an ordered call sequence and fire it from the panel.</span>
          </button>
          <button className="pc-path" onClick={onAgent} disabled={!onAgent}>
            <b>Let an agent / CI collect &amp; verify</b>
            <span>Drive it headlessly over MCP or the flow-verify CLI — no IDE required.</span>
          </button>
        </div>
      )}
      <div className="pc-sub" style={{ marginTop: 4 }}>Whichever path you choose, these must be true:</div>
      <div className="pc-steps">
        {step(hasSession, !hasSession,
          'Start the API under the debugger',
          hasSession ? `Attached: ${sessionName}` : 'Press F5 in the target repo so breakpoints bind — the panel reads the active debug session.')}
        {step(hasBps, hasSession && !hasBps,
          'Add breakpoints in the handler',
          hasBps ? `${bpCount} breakpoint(s) active` : 'Click the editor gutter to set them (no JSON needed) — or add them below, or let an AI agent set them. They appear here under “Set by you”.')}
        {step(false, hasSession && hasBps,
          'Trigger the endpoint — any way you like',
          'Press ▶ Run above, OR just call it from Postman / curl / a browser. No scenario JSON required — every pause is captured the same way (Postman-triggered pauses are tagged EXT). Loops collapse to ×N, deeper calls nest.')}
      </div>
      <div className="pc-foot">
        💡 The scenario runner is just a convenience for firing the calls. You can debug entirely from Postman with hand-set breakpoints.
      </div>
    </div>
  );
}

function MockPanel({
  scenario, mockSets, activeMock, injection, onSetDbMode,
}: {
  scenario: Scenario; mockSets: string[]; activeMock: MockSet | null;
  injection?: MockInjection | null;
  onSetDbMode?: (m: 'real' | 'mocked') => void;
}) {
  // Initialize the editable draft rows straight from the loaded set. The parent
  // remounts this panel (key = mock set name) when a different set loads, so no
  // prop->state sync effect is needed.
  const [name, setName] = useState(activeMock?.name ?? '');
  const [mocks, setMocks] = useState<Array<{ match: string; returns: string }>>(
    () => (activeMock?.boundaryMocks ?? []).map((b) => ({
      match: b.match,
      returns: typeof b.returns === 'string' ? b.returns : JSON.stringify(b.returns),
    }))
  );
  const [overrides, setOverrides] = useState<Array<{ key: string; value: string }>>(
    () => Object.entries(activeMock?.variableOverrides ?? {}).map(([key, value]) => ({ key, value }))
  );

  const isMocked = scenario.dbMode === 'mocked';
  const hasMocks = mocks.length > 0;
  // The dangerous case: you believe the DB is stubbed but nothing stubs it.
  const unarmed = isMocked && !hasMocks;

  const badJson = (s: string) => {
    if (!s.trim()) return false;
    try { JSON.parse(s); return false; } catch { return true; }
  };
  const anyBadJson = mocks.some((m) => badJson(m.returns));

  const save = () => {
    const clean = name.trim();
    if (!clean) return;
    const mockSet: MockSet = {
      name: clean,
      language: activeMock?.language ?? 'node',
      variableOverrides: Object.fromEntries(
        overrides.filter((o) => o.key.trim()).map((o) => [o.key.trim(), o.value])
      ),
      boundaryMocks: mocks
        .filter((m) => m.match.trim())
        .map((m) => {
          let returns: unknown = m.returns;
          try { returns = JSON.parse(m.returns); } catch { /* keep as raw string */ }
          return { match: m.match.trim(), returns };
        }),
    };
    send({ kind: 'saveMockSet', mockSet });
  };

  return (
    <div className="mock-panel">
      <div className="mock-head">
        <h3>Mocks &amp; DB</h3>
        <span className={`db-badge ${isMocked ? 'mocked' : 'real'}`}>
          DB: {scenario.dbMode}
        </span>
      </div>

      {unarmed && (
        <div className="mock-warn" role="alert">
          <b>⚠ DB is set to “mocked” but no boundary mocks are defined.</b>
          <div>The run is blocked until you add a resolvable mock or switch DB to “real”. No request will be sent.</div>
          <div className="mock-warn-actions">
            <button className="btn" onClick={() => onSetDbMode?.('real')}>Switch DB to “real”</button>
            <button className="btn" onClick={() => setMocks([...mocks, { match: '', returns: '{}' }])}>+ Add a boundary mock</button>
          </div>
          <div className="mock-warn-hint">
            Most debugging wants <b>real</b>. Pick <b>mocked</b> only to run a handler with no DB — each
            mock then needs an explicit target like <code>src/db/Accessor#getById</code>.
          </div>
        </div>
      )}
      {!isMocked && hasMocks && (
        <div className="mock-note">
          {mocks.length} boundary mock(s) defined but <b>DB = real</b> — they are not applied. Switch DB to <code>mocked</code> to use them.
        </div>
      )}

      <div className="mock-load">
        <select value={activeMock?.name ?? ''}
          onChange={(e) => { if (e.target.value) send({ kind: 'loadMockSet', name: e.target.value }); }}>
          <option value="">— no mock set loaded —</option>
          {/* Guarantee the loaded set is selectable even if the on-disk list
              hasn't refreshed yet, otherwise the control shows blank. */}
          {activeMock && !mockSets.includes(activeMock.name) && (
            <option value={activeMock.name}>{activeMock.name}</option>
          )}
          {mockSets.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Boundary mocks: stub a DB / external call by matching its name. */}
      <div className="mock-section">
        <div className="mock-section-head">
          <span>Boundary mocks <i>({mocks.length})</i></span>
          <button className="btn tiny" onClick={() => setMocks([...mocks, { match: '', returns: '{}' }])}>+ Add</button>
        </div>
        {mocks.length === 0 ? (
          <div className="mock-empty">
            None. A boundary mock stubs a DB/external call in the running app. Target it
            explicitly as <code>module#method</code> — e.g. match
            <code>src/db/WorkflowDynamoAccessor#getWorkflowInternal</code> returns <code>{'{"id":"W1"}'}</code>.
            A bare name like <code>db.getClaim</code> cannot be resolved.
          </div>
        ) : mocks.map((m, i) => {
          const inj = injection?.results.find((r) => r.match === m.match);
          return (
          <div className="mock-row" key={i}>
            <input className="mock-match" placeholder="module#method e.g. src/db/Accessor#getById" value={m.match}
              onChange={(e) => setMocks(mocks.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))} />
            <textarea className={`mock-returns ${badJson(m.returns) ? 'bad' : ''}`} rows={2}
              placeholder='returns (JSON) e.g. {"id":"abc"}' value={m.returns}
              onChange={(e) => setMocks(mocks.map((x, j) => (j === i ? { ...x, returns: e.target.value } : x)))} />
            {inj && (
              <span className={`mock-inj ${inj.status}`} title={inj.message}>
                {inj.status === 'ok' ? '✓' : inj.status === 'unsupported' ? '?' : '✗'}
              </span>
            )}
            <button className="mock-del" title="Remove" onClick={() => setMocks(mocks.filter((_, j) => j !== i))}>✕</button>
          </div>
          );
        })}
      </div>

      {/* Variable overrides: re-inject a value at file:line:var on the next run. */}
      <div className="mock-section">
        <div className="mock-section-head">
          <span>Variable overrides <i>({overrides.length})</i></span>
          <button className="btn tiny" onClick={() => setOverrides([...overrides, { key: '', value: '' }])}>+ Add</button>
        </div>
        {overrides.length === 0 ? (
          <div className="mock-empty">
            None. Edit a variable in the inspector (✎) then save this set to capture it, or add
            <code>file.ts:42:varName</code> manually.
          </div>
        ) : overrides.map((o, i) => (
          <div className="mock-row" key={i}>
            <input className="mock-match" placeholder="file.ts:42:varName" value={o.key}
              onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            <input className="mock-ovr-val" placeholder="new value" value={o.value}
              onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button className="mock-del" title="Remove" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>

      <div className="mock-save">
        <input placeholder="mock set name (required)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={save} disabled={!name.trim() || anyBadJson}
          title={!name.trim() ? 'Enter a name first' : anyBadJson ? 'Fix invalid JSON in a "returns" field' : 'Save to .flow-debugger/mocks/'}>
          Save mock set
        </button>
      </div>
      {anyBadJson && <div className="mock-note bad">A “returns” field is not valid JSON.</div>}

      <p className="mock-hint">
        Click <b>✎</b> on a variable in the inspector to edit it live during a pause.
        Saved overrides are re-injected at their <code>file:line:var</code> on the next run;
        boundary mocks stub DB/external calls when <b>DB = mocked</b>.
      </p>
    </div>
  );
}

export default App;
