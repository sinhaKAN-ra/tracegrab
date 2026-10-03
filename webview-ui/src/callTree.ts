// Pure, framework-free call-tree builder for the Call Map view.
// Built from enter/exit EVENT ORDERING (relative stack-depth deltas between
// consecutive pauses), NOT from trusting the full DAP stack — because async /
// Promise frames stitch inconsistently across debug adapters and can be
// truncated. We only rely on: the top frame identity, and whether the stack got
// deeper / shallower / stayed. This is async-resilient.

export interface FrameLite {
    name: string;
    source?: string;
    line: number;
}
export interface VarLite {
    name: string;
    value: string;
    type?: string;
}
export interface PauseInput {
    order: number;
    frame: FrameLite | null;
    stackDepth: number; // stack.length (1-based); async gaps may make this jumpy
    vars: VarLite[]; // top-scope locals at this pause
    dbMode?: 'real' | 'mocked';
    /** true if the adapter marked an async boundary in the stack (e.g. "(async)"). */
    asyncGap?: boolean;
    /** heapUsed bytes at this pause, if sampled. */
    heapUsed?: number;
    /** set if this pause is an exception/throw. */
    exception?: { message: string; type?: string };
}

export type Layer = 'controller' | 'service' | 'db' | 'external' | 'other';

export interface Mutation {
    name: string;
    from: string; // previous value (short)
    to: string; // new value (short)
}
export interface StepLite {
    order: number;
    line: number;
    hit: number;
    vars: VarLite[];
    /** variables whose value changed vs the previous step in this method. */
    mutations?: Mutation[];
    /** heapUsed at this pause (bytes), if sampled. */
    heapUsed?: number;
    /** set if this pause was an exception/throw. */
    error?: { message: string; type?: string };
}
export interface CallNode {
    id: string;
    fn: string;
    source: string;
    layer: Layer;
    depth: number; // tree depth (call depth), independent of raw stack numbers
    steps: StepLite[];
    children: CallNode[];
    parentId?: string;
    dataIn?: string; // inferred args (entry locals), label only
    dataOut?: string; // inferred return (changed caller local / last value)
    dbCalls: number; // how many DB-layer calls happened directly under this node
    n1?: boolean; // N+1 suspicion: this node was entered many times under a loop
    enteredCount: number;
    asyncBoundary?: boolean;
    firstOrder: number;
    lastOrder: number;
    /** set if any pause inside this method (not children) threw. */
    error?: { message: string; type?: string };
    /** peak heapUsed observed while inside this method (bytes). */
    heapPeak?: number;
    /** heap delta across this method's lifetime (last - first), bytes. */
    heapDelta?: number;
    /** set when this node was entered more than once (a loop). enteredCount is the repeat count. */
    looped?: boolean;
    /** set when consecutive same-key iterations were folded into this node. */
    aggregated?: boolean;
    /** set when this method's key matches an open ancestor (self-recursion). */
    recursive?: boolean;
    /** how deep the self-recursion nests (levels of the self-chain). */
    recursionDepth?: number;
}

export type Transition =
    | { kind: 'enter'; node: CallNode }
    | { kind: 'step'; node: CallNode }
    | { kind: 'return'; from: CallNode; to: CallNode | null };

const methodKey = (f: FrameLite) => `${f.name}@${f.source ?? '?'}`;

/** Heuristic layer inference from function name + file path. */
export function inferLayer(fn: string, source = ''): Layer {
    const s = `${fn} ${source}`.toLowerCase();
    if (/controller|ctrl|router|route|handler/.test(s)) return 'controller';
    if (/repo|repository|accessor|dynamo|dao|\.db|dbutils|query|prisma|knex|sequelize/.test(s)) return 'db';
    if (/service|svc|usecase|manager|helper/.test(s)) return 'service';
    if (/http|fetch|axios|client|gateway|sdk|s3|sns|sqs/.test(s)) return 'external';
    return 'other';
}

/**
 * Incremental builder. Feed pauses in order; it maintains a call stack of
 * CallNodes and a root list, classifying each pause by depth delta.
 */
export class CallTreeBuilder {
    private roots: CallNode[] = [];
    private stack: CallNode[] = []; // current path of open CallNodes
    private idSeq = 0;
    private prevDepth = 0;
    /** loop context: if the same method is re-entered while a sibling loop node
     *  at the parent is active, flag N+1. Tracked per parent+childKey. */
    private reentryByParent = new Map<string, number>();

    getRoots(): CallNode[] {
        return this.roots;
    }

    /** Process one pause. Returns the classified transition. */
    push(p: PauseInput): Transition {
        if (!p.frame) {
            // no frame → treat as a step on the current node if any
            const cur = this.stack[this.stack.length - 1];
            if (cur) return { kind: 'step', node: cur };
        }
        const frame = p.frame ?? { name: 'step', line: 0 };
        const key = methodKey(frame);
        const cur = this.stack[this.stack.length - 1];

        // SAME method (top of our stack matches) → a line step or loop iteration
        // — BUT only when NOT deeper. A same-key frame that is DEEPER (stackDepth
        // grew) is a DIRECT self-recursive call; fall through to the ENTER path so
        // it nests as a self-child instead of folding into one node as line-steps.
        if (
            cur &&
            methodKey({ name: cur.fn, source: cur.source, line: 0 }) === key &&
            !(p.stackDepth > this.prevDepth)
        ) {
            this.addStep(cur, frame, p);
            this.prevDepth = p.stackDepth;
            return { kind: 'step', node: cur };
        }

        // DEEPER than before → a call (enter). Also treat "stack grew" as enter.
        const deeper = p.stackDepth > this.prevDepth || this.stack.length === 0;
        // Is this key an ancestor already open? Then it's a RETURN to it.
        const ancestorIdx = this.stack.findIndex(
            (n) => methodKey({ name: n.fn, source: n.source, line: 0 }) === key
        );

        if (ancestorIdx !== -1 && !deeper) {
            // RETURN: pop back to the ancestor, annotate dataOut on the popped ones.
            while (this.stack.length - 1 > ancestorIdx) {
                const popped = this.stack.pop()!;
                popped.dataOut = inferDataOut(popped);
            }
            const to = this.stack[this.stack.length - 1] ?? null;
            const from = to; // we've returned INTO `to`
            this.addStep(to!, frame, p);
            this.prevDepth = p.stackDepth;
            return { kind: 'return', from: from!, to: this.stack[ancestorIdx - 1] ?? null };
        }

        // ENTER a new method (deeper, or a brand-new sibling after a return).
        const parent = deeper ? cur : this.enterSibling();
        const node: CallNode = {
            id: `cn-${++this.idSeq}`,
            fn: frame.name,
            source: frame.source ?? '?',
            layer: inferLayer(frame.name, frame.source),
            depth: parent ? parent.depth + 1 : 0,
            steps: [],
            children: [],
            parentId: parent?.id,
            dbCalls: 0,
            enteredCount: 1,
            asyncBoundary: p.asyncGap,
            firstOrder: p.order,
            lastOrder: p.order,
        };
        node.dataIn = inferDataIn(p.vars);
        this.addStep(node, frame, p);

        if (parent) {
            parent.children.push(node);
            if (node.layer === 'db') parent.dbCalls += 1;
            // N+1 detection: same childKey entered repeatedly under this parent.
            const rk = `${parent.id}:${key}`;
            const count = (this.reentryByParent.get(rk) ?? 0) + 1;
            this.reentryByParent.set(rk, count);
            if (count >= 3 && node.layer === 'db') {
                // mark the FIRST such child (find sibling with same key) as N+1
                const sib = parent.children.find(
                    (c) => methodKey({ name: c.fn, source: c.source, line: 0 }) === key
                );
                if (sib) {
                    sib.n1 = true;
                }
            }
        } else {
            this.roots.push(node);
        }
        this.stack.push(node);
        this.prevDepth = p.stackDepth;
        return { kind: 'enter', node };
    }

    /** When not deeper but key unknown, we returned then called a sibling: pop one. */
    private enterSibling(): CallNode | undefined {
        if (this.stack.length > 0) {
            const popped = this.stack.pop()!;
            popped.dataOut = inferDataOut(popped);
        }
        return this.stack[this.stack.length - 1];
    }

    private addStep(node: CallNode, frame: FrameLite, p: PauseInput) {
        node.lastOrder = p.order;
        // roll up heap + error at the node level
        if (typeof p.heapUsed === 'number') {
            node.heapPeak = Math.max(node.heapPeak ?? 0, p.heapUsed);
        }
        if (p.exception) node.error = p.exception;

        const existing = node.steps.find((s) => s.line === frame.line);
        // mutation diff: compare this pause's vars to the LAST recorded step's vars.
        const prevStep = node.steps[node.steps.length - 1];
        const mutations = diffVars(prevStep?.vars, p.vars);

        if (existing) {
            existing.hit += 1;
            existing.vars = p.vars;
            existing.order = p.order;
            existing.heapUsed = p.heapUsed;
            if (mutations.length) existing.mutations = mutations;
            if (p.exception) existing.error = p.exception;
        } else {
            node.steps.push({
                order: p.order,
                line: frame.line,
                hit: 1,
                vars: p.vars,
                heapUsed: p.heapUsed,
                mutations: mutations.length ? mutations : undefined,
                error: p.exception,
            });
        }
        // node heap delta = last sampled - first sampled
        const heaps = node.steps.map((s) => s.heapUsed).filter((h): h is number => typeof h === 'number');
        if (heaps.length >= 2) node.heapDelta = heaps[heaps.length - 1] - heaps[0];
    }
}

function inferDataIn(vars: VarLite[]): string | undefined {
    if (!vars.length) return undefined;
    return vars
        .slice(0, 2)
        .map((v) => `${v.name}=${short(v.value)}`)
        .join(', ');
}
function inferDataOut(node: CallNode): string | undefined {
    const last = node.steps[node.steps.length - 1];
    if (!last || !last.vars.length) return undefined;
    const v = last.vars[last.vars.length - 1];
    return `${v.name}=${short(v.value)}`;
}
function short(s: string): string {
    return s.length > 22 ? s.slice(0, 22) + '…' : s;
}

/** Compute variables whose value changed between two var snapshots (same method). */
export function diffVars(prev: VarLite[] | undefined, next: VarLite[]): Mutation[] {
    if (!prev || !prev.length) return [];
    const prevMap = new Map(prev.map((v) => [v.name, v.value]));
    const out: Mutation[] = [];
    for (const v of next) {
        const before = prevMap.get(v.name);
        if (before !== undefined && before !== v.value) {
            out.push({ name: v.name, from: short(before), to: short(v.value) });
        }
    }
    return out;
}

/**
 * Export the call tree as a Mermaid sequence diagram — one participant per
 * layer/method, call arrows down (with inferred data-in) and return arrows up
 * (with inferred data-out). Paste into a ticket / MR for a shareable trace.
 */
export function toMermaidSequence(roots: CallNode[]): string {
    const lines: string[] = ['sequenceDiagram'];
    const participants = new Map<string, string>(); // id -> alias
    let pSeq = 0;
    const alias = (n: CallNode): string => {
        if (!participants.has(n.id)) {
            participants.set(n.id, `P${++pSeq}`);
        }
        return participants.get(n.id)!;
    };
    // declare participants in encounter order
    const declare: CallNode[] = [];
    const collect = (n: CallNode) => { declare.push(n); n.children.forEach(collect); };
    roots.forEach(collect);
    for (const n of declare) {
        lines.push(`    participant ${alias(n)} as ${n.fn}`);
    }
    const emit = (n: CallNode) => {
        for (const c of n.children) {
            const looped = c.looped || (c.enteredCount ?? 1) > 1;
            const loopLabel = looped
                ? `loop ${c.enteredCount}×${c.recursive ? ' (recursive)' : ''}`
                : (c.recursive ? `loop (recursive, depth ${c.recursionDepth ?? 1})` : null);
            if (loopLabel) lines.push(`    ${loopLabel}`);
            const dataIn = c.dataIn ? `: ${c.dataIn}` : '';
            lines.push(`    ${alias(n)}->>${alias(c)}: call${dataIn}`);
            if (c.n1) lines.push(`    Note over ${alias(c)}: ⚠ N+1 ×${c.enteredCount}`);
            if (c.error) lines.push(`    Note over ${alias(c)}: ✗ ${c.error.message}`);
            emit(c);
            const dataOut = c.dataOut ? `: ${c.dataOut}` : ': return';
            lines.push(`    ${alias(c)}-->>${alias(n)}${dataOut}`);
            if (loopLabel) lines.push(`    end`);
        }
    };
    roots.forEach(emit);
    return lines.join('\n');
}

/**
 * Post-build pass (pure). Collapses runs of CONSECUTIVE same-key children under
 * a parent (a loop) and self-calls (recursion) into a single aggregated node,
 * and marks loop / recursion metadata. The single writer of `enteredCount` /
 * `looped`. Keep byte-for-byte in sync with mcp/callmap.mjs.
 */
export function annotateLoops(roots: CallNode[]): CallNode[] {
    const keyOf = (n: CallNode) => `${n.fn}@${n.source}`;

    const foldInto = (target: CallNode, dup: CallNode) => {
        // append steps, preserving per-line hit counts
        for (const s of dup.steps) {
            const existing = target.steps.find((t) => t.line === s.line);
            if (existing) {
                existing.hit += s.hit;
                existing.vars = s.vars; existing.order = s.order; existing.heapUsed = s.heapUsed;
                if (s.mutations) existing.mutations = s.mutations;
                if (s.error) existing.error = s.error;
            } else {
                target.steps.push(s);
            }
        }
        target.lastOrder = Math.max(target.lastOrder, dup.lastOrder);
        if (dup.dataOut !== undefined) target.dataOut = dup.dataOut; // from the LAST iteration
        if (dup.error && !target.error) target.error = dup.error;
        // recompute heap peak / delta across merged steps
        const heaps = target.steps.map((s) => s.heapUsed).filter((h): h is number => typeof h === 'number');
        if (heaps.length) target.heapPeak = Math.max(...heaps);
        if (heaps.length >= 2) target.heapDelta = heaps[heaps.length - 1] - heaps[0];
    };

    const collapse = (node: CallNode) => {
        const merged: CallNode[] = [];
        for (const child of node.children) {
            const prev = merged[merged.length - 1];
            if (prev && keyOf(prev) === keyOf(child)) {
                // consecutive same-key sibling → fold into the surviving first node
                prev.enteredCount = (prev.enteredCount ?? 1) + 1;
                prev.aggregated = true;
                foldInto(prev, child);
            } else {
                merged.push(child);
            }
        }
        for (const child of merged) {
            child.looped = (child.enteredCount ?? 1) > 1;
            collapse(child);
        }
        node.children = merged;
    };
    roots.forEach(collapse);

    // DIRECT self-recursion: after the builder fix a method that calls ITSELF
    // nests as a same-key child chain (A → A → A …). Fold that self-chain
    // upward into the TOP node so the map shows ONE node with a repeat/depth
    // count — a `loop N× (recursive)` block — not N nested arrow pairs.
    // N (recursionDepth / enteredCount) = number of self-activations in the
    // chain (A→A→A ⇒ 3). The folded self-children are removed from the tree.
    const collapseRecursion = (node: CallNode) => {
        const selfKey = keyOf(node);
        let selfChild = node.children.find((c) => keyOf(c) === selfKey);
        if (selfChild) {
            // Walk the LINEAR self-chain node → self → self …, folding each
            // self-activation up into `node`. Steps merge; non-self children of
            // each activation are lifted onto `node` so sub-calls aren't lost.
            node.children = node.children.filter((c) => c !== selfChild);
            let depth = 1; // this node is activation #1
            while (selfChild) {
                depth += 1;
                foldInto(node, selfChild);
                const nextSelf: CallNode | undefined = selfChild.children.find((c) => keyOf(c) === selfKey);
                for (const gc of selfChild.children) {
                    if (gc === nextSelf) continue; // next activation — stay on the chain
                    gc.parentId = node.id;
                    node.children.push(gc);
                }
                selfChild = nextSelf;
            }
            node.enteredCount = depth;
            node.recursive = true;
            node.recursionDepth = depth;
        }
        for (const child of node.children) collapseRecursion(child);
    };
    roots.forEach(collapseRecursion);

    // INDIRECT recursion: a node whose key matches an open ancestor THROUGH an
    // intermediate frame (A → B → A) can't fold (the intervening B breaks the
    // self-chain), so flag it in place. We mark BOTH the matching ancestor (top
    // of the self-chain) and the nested self-child, and record the nesting depth.
    const markRecursion = (node: CallNode, ancestorNodes: CallNode[]) => {
        const key = keyOf(node);
        const firstIdx = ancestorNodes.findIndex((a) => keyOf(a) === key);
        if (firstIdx !== -1) {
            const depth = ancestorNodes.length - firstIdx; // levels of self-nesting
            node.recursive = true;
            node.recursionDepth = Math.max(node.recursionDepth ?? 0, depth);
            const top = ancestorNodes[firstIdx];
            top.recursive = true;
            top.recursionDepth = Math.max(top.recursionDepth ?? 0, depth);
        }
        const next = [...ancestorNodes, node];
        for (const child of node.children) markRecursion(child, next);
    };
    roots.forEach((r) => markRecursion(r, []));

    return roots;
}

/** Build the whole tree from an ordered list of pauses (convenience for tests). */
export function buildCallTree(pauses: PauseInput[]): CallNode[] {
    const b = new CallTreeBuilder();
    for (const p of pauses) b.push(p);
    return annotateLoops(b.getRoots());
}

/**
 * Flatten the tree into an agent-friendly summary (layers, N+1, loops,
 * recursion, errors, heap). Keep the methodList projection byte-for-byte in
 * sync with mcp/callmap.mjs::summarizeTree so the MCP get_call_map summary and
 * the webview see the same fields.
 */
export function summarizeTree(roots: CallNode[]) {
    const flat: Array<Record<string, unknown>> = [];
    const walk = (n: CallNode) => {
        flat.push({
            fn: n.fn, layer: n.layer, source: n.source, order: n.firstOrder,
            dbCalls: n.dbCalls, n1: !!n.n1, entered: n.enteredCount,
            looped: !!n.looped, recursive: !!n.recursive, recursionDepth: n.recursionDepth,
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
        errors: flat.filter((m) => m.error).map((m) => {
            const e = m.error as { type?: string; message?: string } | undefined;
            return `${m.fn}: ${e?.type ?? ''} ${e?.message}`;
        }),
        methodList: flat,
    };
}
