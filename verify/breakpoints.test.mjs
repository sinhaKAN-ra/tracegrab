#!/usr/bin/env node
/** Tests for the Phase 3 unified-breakpoints merge model (framework-free). */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-breakpoints-'));
execSync(
  `npx --yes tsc "${path.join(root, 'webview-ui', 'src', 'breakpoints.ts')}" ` +
  `--outDir "${outDir}" --module esnext --target es2022 --moduleResolution bundler`,
  { stdio: 'pipe' },
);
const { mergeBreakpoints } = await import(path.join(outDir, 'breakpoints.js'));
let pass = 0, fail = 0;
const assert = (condition, message) => condition
  ? (pass++, console.log(`✓ ${message}`))
  : (fail++, console.error(`✗ FAIL: ${message}`));

// scenario-only: becomes an editable scenario row.
{
  const rows = mergeBreakpoints(
    [{ file: 'src/a.ts', line: 10, enabled: true, condition: 'x > 1' }],
    [],
    { sessionActive: false },
  );
  assert(rows.length === 1, 'scenario-only yields one row');
  assert(rows[0].source === 'scenario' && rows[0].editable === true, 'scenario row is source=scenario and editable');
  assert(rows[0].scenarioIndex === 0, 'scenario row carries its list index');
  assert(rows[0].condition === 'x > 1', 'scenario row preserves its condition');
  assert(rows[0].bound === null, 'no session => bound is unknown (null)');
}

// editor-only manual: becomes a read-only "you" row.
{
  const rows = mergeBreakpoints(
    [],
    [{ file: 'src/b.ts', line: 5, enabled: true, source: 'manual' }],
    { sessionActive: false },
  );
  assert(rows.length === 1 && rows[0].source === 'you', 'editor-only manual maps to source=you');
  assert(rows[0].editable === false && rows[0].scenarioIndex === -1, 'editor-only row is read-only with index -1');
}

// editor-only scenario-source: becomes a read-only "scenario" row.
{
  const rows = mergeBreakpoints(
    [],
    [{ file: 'src/c.ts', line: 7, enabled: false, source: 'scenario' }],
    { sessionActive: false },
  );
  assert(rows.length === 1 && rows[0].source === 'scenario' && rows[0].editable === false,
    'editor-only scenario-source maps to source=scenario, read-only');
  assert(rows[0].enabled === false, 'editor-only row carries its enabled flag');
}

// overlap: a scenario row and its editor mirror collapse to ONE editable row.
{
  const rows = mergeBreakpoints(
    [{ file: 'src/d.ts', line: 42, enabled: true }],
    [{ file: 'src/d.ts', line: 42, enabled: true, source: 'scenario' }],
    { sessionActive: false },
  );
  assert(rows.length === 1, 'overlapping file:line dedupes to one row');
  assert(rows[0].editable === true, 'the surviving overlap row is the editable scenario row');
}

// overlap via basename fallback: absolute editor path vs relative scenario path.
{
  const rows = mergeBreakpoints(
    [{ file: 'src/e.ts', line: 3, enabled: true }],
    [{ file: 'e.ts', line: 3, enabled: true, source: 'manual' }],
    { sessionActive: false },
  );
  assert(rows.length === 1, 'basename+line fallback dedupes differing path spellings');
}

// bound derivation with an active session.
{
  const rows = mergeBreakpoints(
    [{ file: 'src/f.ts', line: 1, enabled: true }, { file: 'src/f.ts', line: 2, enabled: false }],
    [],
    { sessionActive: true },
  );
  assert(rows[0].bound === true, 'session + enabled => bound true');
  assert(rows[1].bound === false, 'session + disabled => bound false');
}

console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
