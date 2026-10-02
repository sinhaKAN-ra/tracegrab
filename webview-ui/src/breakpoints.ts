/**
 * Pure, React-free merge of the two breakpoint sources the panel shows:
 *   - the scenario's editable list (`scenario.breakpoints`), and
 *   - the live editor mirror (`allBps`, every SourceBreakpoint in the editor).
 *
 * It produces ONE ordered display model so `BreakpointsPanel` can render a
 * single four-column table (source / enabled / bound / condition) instead of
 * two independent lists. Keep this module dependency-free and framework-free so
 * it is unit-testable like `outcome.ts` — never import React here.
 */

/** Scenario-owned breakpoint (the editable list). Mirror of App.tsx `Breakpoint`. */
export type ScenarioBreakpoint = {
  file: string;
  line: number;
  condition?: string;
  label?: string;
  enabled?: boolean;
};

/** Editor-mirror breakpoint. Mirror of App.tsx `AllBp`. */
export type EditorBreakpoint = {
  file: string;
  line: number;
  condition?: string;
  enabled: boolean;
  source: 'scenario' | 'manual';
};

/** Who added a breakpoint, as shown in the `source` column.
 *  `agent` is reserved: the host cannot yet distinguish agent-applied from
 *  scenario-applied breakpoints, so the merge never emits it today. */
export type BpSource = 'you' | 'scenario' | 'agent';

/** One row of the unified breakpoints table. */
export type UnifiedBpRow = {
  /** Stable key for React. */
  key: string;
  file: string;
  line: number;
  source: BpSource;
  enabled: boolean;
  /** Best-effort bound signal: true/false while a debug session is attached,
   *  null when there is no session to bind against (unknown). This is NOT the
   *  DAP `verified` flag — the public VS Code API does not expose it. */
  bound: boolean | null;
  condition: string | undefined;
  /** Editable rows come from the scenario list; mirror-only rows are read-only. */
  editable: boolean;
  /** Index into `scenario.breakpoints` when `editable`, else -1. */
  scenarioIndex: number;
};

/** Normalize a path for union matching: compare on the trailing relative path,
 *  ignoring leading `./` and collapsing `\` to `/`. */
function normPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when two breakpoint locations refer to the same file:line. Scenario
 *  paths may be workspace-relative (`src/x.ts`) while editor-mirror paths are
 *  already workspace-relative from the host, so match on the relative path and
 *  fall back to basename+line. */
function sameLocation(a: { file: string; line: number }, b: { file: string; line: number }): boolean {
  if (a.line !== b.line) return false;
  const pa = normPath(a.file);
  const pb = normPath(b.file);
  if (pa === pb) return true;
  const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return basename(pa) === basename(pb);
}

/** Derive the best-effort bound signal (see UnifiedBpRow.bound). */
function deriveBound(enabled: boolean, sessionActive: boolean): boolean | null {
  if (!sessionActive) return null;
  return enabled;
}

/**
 * Merge the scenario list (editable backbone) with the editor mirror into one
 * ordered table. Scenario rows come first (editable, `source:'scenario'`),
 * followed by editor-only rows that are NOT already represented in the scenario
 * list (read-only; `manual` → `you`, `scenario` → `scenario`).
 */
export function mergeBreakpoints(
  scenarioBps: ScenarioBreakpoint[],
  allBps: EditorBreakpoint[],
  opts: { sessionActive: boolean },
): UnifiedBpRow[] {
  const sessionActive = opts.sessionActive;
  const rows: UnifiedBpRow[] = [];

  scenarioBps.forEach((bp, i) => {
    const enabled = bp.enabled !== false;
    rows.push({
      key: `scn:${normPath(bp.file)}:${bp.line}:${i}`,
      file: bp.file,
      line: bp.line,
      source: 'scenario',
      enabled,
      bound: deriveBound(enabled, sessionActive),
      condition: bp.condition,
      editable: true,
      scenarioIndex: i,
    });
  });

  allBps.forEach((bp, i) => {
    const covered = scenarioBps.some((s) => sameLocation(s, bp));
    if (covered) return; // collapse a scenario row and its editor mirror into one
    rows.push({
      key: `edt:${bp.source}:${normPath(bp.file)}:${bp.line}:${i}`,
      file: bp.file,
      line: bp.line,
      source: bp.source === 'manual' ? 'you' : 'scenario',
      enabled: bp.enabled,
      bound: deriveBound(bp.enabled, sessionActive),
      condition: bp.condition,
      editable: false,
      scenarioIndex: -1,
    });
  });

  return rows;
}
