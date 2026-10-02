import type { CallNode } from './callTree';

type MemSample = { order: number; heapUsed: number };

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'info';
export type UiFinding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  where?: string;
  suggestion?: string;
  pauseOrder?: number;
};
export type Outcome = {
  verdict: 'NO EVIDENCE' | 'LOOKS OK' | 'SUSPECT' | 'PROBLEM FOUND' | 'FAILING';
  tone: 'neutral' | 'ok' | 'warn' | 'bad';
  exceptions: number;
  n1: number;
  dbCalls: number;
  memory: 'no samples' | 'reclaimed' | 'not reclaimed' | 'stable';
  findings: UiFinding[];
};

function flat(roots: CallNode[], out: CallNode[] = []): CallNode[] {
  for (const node of roots) {
    out.push(node);
    flat(node.children, out);
  }
  return out;
}

const EMPTY = /^(?:''|""|null|undefined|None|\[\]|\{\}|0)$/;

/**
 * Immediate UI outcome derived from the trusted call-tree evidence already on
 * screen. Full baseline/contract inference arrives in Phase 4; this gives the
 * Phase 2 shell an honest live answer without inventing unavailable data.
 */
export function deriveOutcome(roots: CallNode[], memory: MemSample[]): Outcome {
  if (!roots.length) {
    return { verdict: 'NO EVIDENCE', tone: 'neutral', exceptions: 0, n1: 0, dbCalls: 0, memory: 'no samples', findings: [] };
  }
  const nodes = flat(roots);
  const findings: UiFinding[] = [];

  for (const node of nodes) {
    if (node.error) {
      const errorStep = node.steps.find((step) => step.error);
      findings.push({
        id: `exception:${node.id}`,
        severity: 'critical',
        title: `${node.error.type ?? 'Exception'} thrown in ${node.fn}`,
        detail: node.error.message,
        where: `${node.source}:${errorStep?.line ?? node.steps.at(-1)?.line ?? 1}`,
        suggestion: 'Inspect the inputs on this hop and compare this pause with the last successful run.',
        pauseOrder: errorStep?.order,
      });
    }
    if (node.n1) {
      findings.push({
        id: `n1:${node.id}`,
        severity: 'high',
        title: `N+1 query: ${node.fn} called ${node.enteredCount}× in a loop`,
        detail: 'A DB method runs once per item instead of batching.',
        where: node.source,
        suggestion: 'Batch the lookup or preload the required rows before entering the loop.',
        pauseOrder: node.firstOrder,
      });
    }
    for (const step of node.steps) {
      for (const mutation of step.mutations ?? []) {
        if (EMPTY.test(String(mutation.to).trim()) && !EMPTY.test(String(mutation.from).trim())) {
          findings.push({
            id: `clear:${node.id}:${step.order}:${mutation.name}`,
            severity: 'high',
            title: `${mutation.name} was cleared in ${node.fn}`,
            detail: `${mutation.from} → ${mutation.to}`,
            where: `${node.source}:${step.line}`,
            suggestion: 'Confirm this reset is intentional; otherwise this is likely where data is lost.',
            pauseOrder: step.order,
          });
        }
      }
    }
  }

  let memoryLabel: Outcome['memory'] = 'no samples';
  if (memory.length >= 2) {
    const first = memory[0].heapUsed;
    const last = memory[memory.length - 1].heapUsed;
    const reclaimed = memory.some((sample, index) => index > 0 && sample.heapUsed < memory[index - 1].heapUsed);
    memoryLabel = reclaimed ? 'reclaimed' : last > first ? 'not reclaimed' : 'stable';
    if (!reclaimed && last > first) {
      findings.push({
        id: 'memory:not-reclaimed',
        severity: 'medium',
        title: 'Heap grew and was never reclaimed',
        detail: `heapUsed increased across ${memory.length} pause samples with no observed decrease.`,
        where: 'process',
        suggestion: 'Check for accumulating arrays, maps, listeners, or unbounded result sets on this path.',
      });
    }
  }

  // Parent rollups can expose the same exception as their child. Keep one card
  // per title/location while preserving severity order.
  const rank: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, info: 3 };
  const unique = [...new Map(findings.map((finding) => [`${finding.title}@${finding.where}`, finding])).values()]
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const exceptions = unique.filter((finding) => finding.severity === 'critical').length;
  const n1 = unique.filter((finding) => finding.id.startsWith('n1:')).length;
  const dbCalls = nodes.reduce((sum, node) => sum + (node.dbCalls ?? 0), 0);
  const worst = unique[0]?.severity;
  return {
    verdict: worst === 'critical' ? 'FAILING' : worst === 'high' ? 'PROBLEM FOUND' : worst === 'medium' ? 'SUSPECT' : 'LOOKS OK',
    tone: worst === 'critical' ? 'bad' : worst === 'high' || worst === 'medium' ? 'warn' : 'ok',
    exceptions, n1, dbCalls, memory: memoryLabel, findings: unique,
  };
}
