/**
 * FlowTrace v1 — the portable, versioned trace artifact.
 *
 * A FlowTrace is everything the tool observed for one scenario run, in a stable
 * shape that can be saved, reopened, exported, diffed, asserted against a
 * contract, and reported on with NO live debugger attached.
 *
 * Pure + dependency-free so the MCP server and a future headless runner can
 * build/read traces without vscode.
 */

export const FLOWTRACE_SCHEMA_VERSION = 1;

export interface TraceGit {
    sha?: string;
    branch?: string;
    dirty?: boolean;
}
export interface TraceRuntime {
    adapter?: string; // e.g. 'pwa-node', 'debugpy'
    language?: string; // 'node' | 'python' | …
}
export interface TraceMutation {
    name: string;
    from: string;
    to: string;
    line: number;
}
export interface TraceStep {
    order: number;
    line: number;
    hit: number;
    vars: Array<{ name: string; value: string; type?: string }>;
    mutations?: TraceMutation[];
    heapUsed?: number;
    error?: { message: string; type?: string };
}
export interface TraceMethod {
    /** Deterministic across runs of the same code: fn@source. */
    id: string;
    fn: string;
    source: string;
    layer: string;
    depth: number;
    dataIn?: string;
    dataOut?: string;
    dbCalls: number;
    n1?: boolean;
    enteredCount: number;
    error?: { message: string; type?: string };
    heapDelta?: number;
    firstOrder: number;
    lastOrder: number;
    children: TraceMethod[];
}
export interface TraceFinding {
    severity: 'critical' | 'high' | 'medium' | 'info';
    kind: string;
    title: string;
    detail?: string;
    where?: string;
    suggestion?: string;
}
export interface TraceCall {
    callId?: string;
    request: { method: string; url: string; body?: string };
    response: { status: number | null; ok?: boolean; durationMs?: number; bodyShape?: unknown };
    pauseCount: number;
}
export interface FlowTrace {
    schemaVersion: number;
    id: string;
    createdAt: string;
    git?: TraceGit;
    runtime?: TraceRuntime;
    scenario: { name: string; dbMode: 'real' | 'mocked'; mockSetName?: string; strictMocks?: boolean };
    mockInjection?: { results: Array<{ match: string; status: string; message?: string }> };
    calls: TraceCall[];
    methods: TraceMethod[];
    findings: TraceFinding[];
    verdict: string;
    memory?: { series: Array<{ order: number; heapUsed: number }>; peak?: number; netDelta?: number; reclaimed?: boolean };
    mutations: TraceMutation[];
    /** Live mutations made during the run (from the audit log). */
    audit?: Array<{ at: string; actor: string; action: string; target?: string; before?: string; after?: string }>;
    redaction: { on: boolean };
    stats: { methodCount: number; pauseCount: number; dbCallTotal: number };
}

/** Stable id for a method so two runs of the same code compare cleanly. */
export function methodId(fn: string, source: string): string {
    return `${fn}@${source}`;
}

interface CallNodeLike {
    fn: string; source: string; layer: string; depth: number;
    dataIn?: string; dataOut?: string; dbCalls: number; n1?: boolean;
    enteredCount: number; error?: { message: string; type?: string };
    heapDelta?: number; firstOrder: number; lastOrder: number;
    steps: Array<{ order: number; line: number; hit: number; vars: Array<{ name: string; value: string; type?: string }>; mutations?: Array<{ name: string; from: string; to: string }>; heapUsed?: number; error?: { message: string; type?: string } }>;
    children: CallNodeLike[];
}

function toTraceMethod(n: CallNodeLike, out: TraceMutation[]): TraceMethod {
    for (const s of n.steps) {
        for (const m of s.mutations ?? []) out.push({ ...m, line: s.line });
    }
    return {
        id: methodId(n.fn, n.source),
        fn: n.fn, source: n.source, layer: n.layer, depth: n.depth,
        dataIn: n.dataIn, dataOut: n.dataOut, dbCalls: n.dbCalls, n1: n.n1,
        enteredCount: n.enteredCount, error: n.error, heapDelta: n.heapDelta,
        firstOrder: n.firstOrder, lastOrder: n.lastOrder,
        children: n.children.map((c) => toTraceMethod(c, out)),
    };
}

export interface BuildTraceInput {
    id?: string;
    scenario: { name: string; dbMode: 'real' | 'mocked'; mockSetName?: string; strictMocks?: boolean };
    roots: CallNodeLike[];
    diagnosis?: { verdict?: string; findings?: TraceFinding[] };
    calls?: TraceCall[];
    heapSeries?: Array<{ order: number; heapUsed: number }>;
    git?: TraceGit;
    runtime?: TraceRuntime;
    mockInjection?: { results: Array<{ match: string; status: string; message?: string }> };
    audit?: FlowTrace['audit'];
    redacted?: boolean;
}

/** Assemble a FlowTrace from a built call tree + diagnosis + run metadata. */
export function buildFlowTrace(input: BuildTraceInput): FlowTrace {
    const mutations: TraceMutation[] = [];
    const methods = input.roots.map((r) => toTraceMethod(r, mutations));

    let methodCount = 0, dbCallTotal = 0, pauseCount = 0;
    const walk = (m: TraceMethod) => {
        methodCount += 1;
        dbCallTotal += m.dbCalls;
        m.children.forEach(walk);
    };
    methods.forEach(walk);
    const countSteps = (n: CallNodeLike) => { pauseCount += n.steps.length; n.children.forEach(countSteps); };
    input.roots.forEach(countSteps);

    const series = input.heapSeries ?? [];
    const used = series.map((s) => s.heapUsed);
    const memory = series.length
        ? {
              series,
              peak: Math.max(...used),
              netDelta: used[used.length - 1] - used[0],
              reclaimed: used.some((h, i) => i > 0 && h < used[i - 1]),
          }
        : undefined;

    return {
        schemaVersion: FLOWTRACE_SCHEMA_VERSION,
        id: input.id ?? `ft_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        git: input.git,
        runtime: input.runtime,
        scenario: input.scenario,
        mockInjection: input.mockInjection,
        calls: input.calls ?? [],
        methods,
        findings: input.diagnosis?.findings ?? [],
        verdict: input.diagnosis?.verdict ?? 'UNKNOWN',
        memory,
        mutations,
        audit: input.audit,
        redaction: { on: input.redacted !== false },
        stats: { methodCount, pauseCount, dbCallTotal },
    };
}

/** Basic forward-compatibility guard for readers. */
export function isSupportedTrace(t: { schemaVersion?: number }): boolean {
    return typeof t?.schemaVersion === 'number' && t.schemaVersion <= FLOWTRACE_SCHEMA_VERSION;
}
