/**
 * Message protocol between the extension host and the webview for the
 * API Flow Test Debugger. Shared by both sides (host imports it; webview
 * keeps a structural copy). See docs/FLOW_DEBUGGER_DESIGN.md.
 */

// ---- Debug/DAP data ----
export interface StackFrameDTO {
    id: number;
    name: string;
    source?: string;
    line: number;
}

export interface VariableDTO {
    name: string;
    value: string;
    type?: string;
    variablesReference: number; // > 0 means expandable
    /** DAP evaluate name, used to target setVariable/setExpression. */
    evaluateName?: string;
}

export interface ScopeDTO {
    name: string;
    variablesReference: number;
    variables: VariableDTO[];
}

/** Heap / memory sample of the debuggee at a pause (from process.memoryUsage()). */
export interface MemorySample {
    order: number;
    heapUsed: number; // bytes
    heapTotal: number;
    rss: number;
    external?: number;
    /** delta in heapUsed vs the previous sample (bytes; can be negative = GC/free). */
    heapDelta?: number;
}

/** Result of trying to inject ONE boundary mock into the live debuggee. */
export interface MockInjectionResult {
    match: string;
    /** ok = actually stubbed; failed = target found but patch failed; unsupported = match can't be resolved. */
    status: 'ok' | 'failed' | 'unsupported';
    message: string;
}

/**
 * Whether `dbMode: 'mocked'` actually took effect. Surfaced so a run is never
 * silently hitting the real database while claiming to be mocked.
 */
export interface MockInjectionReport {
    at: string;
    mockSetName?: string;
    results: MockInjectionResult[];
    note?: string;
}

// ---- Breakpoints (set programmatically by the extension or an AI agent) ----
export interface Breakpoint {
    /** Workspace-relative or absolute file path, e.g. "src/verify-service.ts". */
    file: string;
    /** 1-based line number. */
    line: number;
    /**
     * Content-addressed alternatives (B3) — resolved to a line at apply time so
     * the breakpoint survives edits above it. Checked in order: statement text
     * (substring match), then function/symbol name. `line` is the fallback.
     */
    statement?: string;
    function?: string;
    /** Optional expression; the debugger only pauses when it is truthy. */
    condition?: string;
    /** Optional label from the test scenario, e.g. "after IA resolve". */
    label?: string;
    /** Whether it is currently active (applied to the debug session). */
    enabled?: boolean;
}

// ---- Scenario / Flow Runner ----
export interface ApiCall {
    id: string;
    name: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: string; // raw JSON string
    /** When false, the runner skips this call. Defaults to true (run it). */
    enabled?: boolean;
    /**
     * Optional chaining: map fields of THIS call's JSON response into named
     * variables the next calls can reference as ${var}.
     * e.g. { "claimId": "$.data.id" }  (simple $.a.b[0] path)
     */
    extract?: Record<string, string>;
}

export interface Scenario {
    id: string;
    name: string;
    calls: ApiCall[];
    /** Breakpoints to set programmatically before the run (from the test flow). */
    breakpoints: Breakpoint[];
    /** real = hit the DB; mocked = boundary mocks serve DB calls. */
    dbMode: 'real' | 'mocked';
    mockSetName?: string;
    /**
     * Legacy compatibility flag. Mocked mode is now always fail-closed in the
     * host: unavailable, absent, or failed injection aborts before HTTP leaves
     * the runner. CI may still set this field; false no longer weakens safety.
     */
    strictMocks?: boolean;
}

export interface CallResult {
    callId: string;
    name: string;
    status: number | null;
    ok: boolean;
    durationMs: number;
    responseBody?: string;
    error?: string;
    /** How many debugger pauses this call triggered. */
    pauseCount: number;
}

// ---- Mock store (shared JSON: hand-written | imported | captured) ----
export interface BoundaryMock {
    /** Explicit target of the call being intercepted, e.g. "src/db/OrderRepository#findById". */
    match: string;
    returns: unknown;
}

export interface MockSet {
    name: string;
    language: string;
    /** Keyed by "file:line:varName" -> new value (string form for setVariable). */
    variableOverrides: Record<string, string>;
    boundaryMocks: BoundaryMock[];
}

// ---- host -> webview ----
export type ToWebview =
    | { kind: 'init'; scenario: Scenario; mockSets: string[] }
    | { kind: 'session'; status: 'started' | 'ended'; name?: string; /** true when hydrating an already-open session; do not reset trace UI. */ restore?: boolean }
    | { kind: 'debugStatus'; status: 'running' | 'paused' | 'ended'; threadId?: number; reason?: string }
    | {
          kind: 'stopped';
          reason: string;
          frame: StackFrameDTO | null;
          stack: StackFrameDTO[];
          scopes: ScopeDTO[];
          step: number;
          /** Stable identity for this capture run and exact pause. */
          runId?: string;
          pauseId?: string;
          /** id of the API call whose execution caused this pause, if known. */
          callId?: string;
          /** true when no scenario call was in flight — i.e. the request came from
           *  OUTSIDE the tool (Postman, curl, a browser, another service). */
          external?: boolean;
          dbMode?: 'real' | 'mocked';
          memory?: MemorySample;
          /** set when the pause reason is an exception/throw. */
          exception?: { message: string; type?: string };
      }
    | { kind: 'memory'; sample: MemorySample }
    | { kind: 'variables'; variablesReference: number; variables: VariableDTO[] }
    | { kind: 'variableSet'; ok: boolean; name: string; value?: string; message?: string }
    | { kind: 'runStarted'; scenarioId: string; runId: string }
    | { kind: 'callStarted'; runId: string; callId: string; name: string; index: number }
    | { kind: 'callResult'; runId?: string; result: CallResult }
    | { kind: 'runFinished'; scenarioId: string; runId: string; results: CallResult[]; cancelled?: boolean }
    | { kind: 'mockSet'; mockSet: MockSet }
    | { kind: 'mockInjection'; report: MockInjectionReport }
    /** A generated test report, with where it was saved. */
    | { kind: 'reportReady'; format: 'markdown' | 'html'; content: string; savedTo?: string; verdict: string }
    /**
     * Headless collection readiness for the target's Python interpreter.
     * Only sent (and only rendered) when a check actually ran — the panel must
     * NOT show a Python-related affordance at all when this is absent/not-ok,
     * since the feature has no fallback UI, only a CLI/MCP one today.
     */
    | { kind: 'pythonReadiness'; ready: boolean; reason?: string; version?: string; python?: string }
    /** Phase 4 — prove-a-change workflow (baseline / compare / contract). */
    | { kind: 'baselines'; names: string[]; contracts: string[] }
    | { kind: 'baselineSaved'; name: string }
    | { kind: 'comparisonReady'; baseline: string; outcome: string; markdown: string; entries: Array<{ severity: string; title: string; where?: string }> }
    | { kind: 'contractSaved'; name: string; yaml: string }
    | { kind: 'contractVerified'; name: string; pass: boolean; explanation: string; violations: Array<{ rule: string; expected: string; actual: string; where?: string }> }
    | { kind: 'breakpointsApplied'; breakpoints: Breakpoint[]; message?: string }
    /**
     * EVERY breakpoint currently set in the editor, categorised by who created
     * it — so the panel can list the user's own hand-set breakpoints alongside
     * the ones this tool / an agent applied from a scenario.
     */
    | {
          kind: 'allBreakpoints';
          entries: Array<{
              file: string; // workspace-relative when possible
              line: number;
              condition?: string;
              enabled: boolean;
              /** 'scenario' = set by this tool/agent; 'manual' = set by the user. */
              source: 'scenario' | 'manual';
          }>;
      }
    | { kind: 'testGenerated'; path: string }
    | { kind: 'info'; message: string }
    | { kind: 'error'; message: string };

// ---- webview -> host ----
export type FromWebview =
    | { kind: 'ready' }
    | { kind: 'runScenario'; scenario: Scenario }
    | { kind: 'expand'; variablesReference: number }
    | { kind: 'setVariable'; variablesReference: number; name: string; value: string }
    | { kind: 'saveScenario'; scenario: Scenario }
    | { kind: 'loadMockSet'; name: string }
    | { kind: 'saveMockSet'; mockSet: MockSet }
    | { kind: 'generateTest'; scenarioId: string }
    | { kind: 'applyBreakpoints'; breakpoints: Breakpoint[] }
    | { kind: 'clearBreakpoints' }
    | { kind: 'openSource'; file: string; line: number }
    /** Move this panel into a separate OS window (bigger screen / second monitor). */
    | { kind: 'openInNewWindow' }
    /** Build a test report from the current run (markdown | html). */
    | { kind: 'generateReport'; format: 'markdown' | 'html' }
    /** Phase 4 — prove-a-change workflow. */
    | { kind: 'listBaselines' }
    | { kind: 'saveBaseline'; name: string }
    | { kind: 'compareBaseline'; name: string }
    | { kind: 'saveContract'; name: string }
    | { kind: 'verifyContract'; name: string }
    /** Cancel the active scenario HTTP sequence (the debug session remains open). */
    | { kind: 'cancelRun' }
    /** Control the currently-paused debugger thread from the panel. */
    | { kind: 'debugControl'; action: 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | 'stop' }
    /** Kept for older webview bundles; equivalent to debugControl/continue. */
    | { kind: 'continue' };
