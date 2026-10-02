#!/usr/bin/env node
/**
 * lint:boundaries — fails the build if the public core:
 *   (a) imports from a path/namespace outside its own trees, or
 *   (b) hard-codes configuration-as-data that belongs at runtime
 *       (feature→tier maps, pricing terms, roadmap/milestone codenames).
 *
 * Zero-dep. Scans src/, webview-ui/src/, mcp/, cli/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'webview-ui/src', 'mcp', 'cli'];
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);

// Curated public docs are also scanned for strategy leaks (codenames/pricing).
// NOT a recursive scan: an explicit list of human-authored docs, so generated
// or vendored files (e.g. a minified bundle under docs/screenshots/) never trip it.
const DOC_FILES = [
  'README.md', 'README.OSS.md', 'AGENTS.md', 'AGENTS.CONTRIB.md', 'CONTRIBUTING.md',
  'docs/MAINTAINING.md', 'docs/ROADMAP.md', 'docs/FLOW_DEBUGGER_DESIGN.md',
  'docs/AGENT_AUTOMATION.md', 'docs/DRIVING_AND_TROUBLESHOOTING.md',
  'docs/INTERACTIVE_HEADLESS_SPEC.md', 'docs/IMPLEMENTATION_PLAN.md',
];

// Lines that legitimately contain a C0-C8-shaped token (example data, not a
// codename). Keep this list tight — each entry is a specific allowed pattern.
const TOKEN_ALLOW = [
  /"id"\s*:\s*"C[0-8]"/,          // example scenario/mock JSON: { "id": "C1" }
  /id:\s*'C[0-8]'/,                // same, single-quoted
];

// External org namespaces the public repo must never import from.
const FORBIDDEN_IMPORT = [
  /from\s+['"]@tracegrab-org\//,
  /from\s+['"]tracegrab-org\b/,
  /require\(\s*['"]@tracegrab-org\//,
  /from\s+['"]\.\.\/\.\.\/(org|private|internal)\//,
];

// Strategy leakage: roadmap codenames and pricing-as-data.
// Codenames C0..C8 as standalone tokens; plan/pricing literals in source.
const FORBIDDEN_TOKEN = [
  { re: /\bC[0-8]\b/, why: 'roadmap/milestone codename — keep out of public source' },
  { re: /FEATURE_TIER\s*[:=]\s*\{[^}]*['"]/, why: 'populated feature→tier map is configuration-as-data; inject at runtime' },
  { re: /['"]\$\d+\s*\/\s*(mo|month|user|seat)/i, why: 'pricing literal — not in public source' },
  { re: /price\s*sheet/i, why: 'pricing reference — not in public source' },
];

// Files allowed to define the mechanism (the Feature type lives here) but still
// checked for the token rules above.
const errors = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
      walk(p);
    } else if (EXT.has(extname(p))) {
      scan(p);
    }
  }
}

function scan(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN_IMPORT) {
      if (re.test(line)) errors.push(`${file}:${i + 1}  cross-boundary import  →  ${line.trim()}`);
    }
    if (TOKEN_ALLOW.some((re) => re.test(line))) return; // allowed example data
    for (const { re, why } of FORBIDDEN_TOKEN) {
      if (re.test(line)) errors.push(`${file}:${i + 1}  ${why}  →  ${line.trim()}`);
    }
  });
}

for (const root of ROOTS) {
  try { walk(root); } catch { /* root may not exist in all checkouts */ }
}

// Curated docs: token rules only (imports are irrelevant in prose).
for (const doc of DOC_FILES) {
  try {
    const text = readFileSync(doc, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (TOKEN_ALLOW.some((re) => re.test(line))) return;
      for (const { re, why } of FORBIDDEN_TOKEN) {
        if (re.test(line)) errors.push(`${doc}:${i + 1}  ${why} (public doc)  →  ${line.trim()}`);
      }
    });
  } catch { /* doc may not exist in all checkouts */ }
}

if (errors.length) {
  console.error('✗ boundary violations:\n' + errors.map((e) => '  ' + e).join('\n'));
  console.error(`\n${errors.length} violation(s). The public core must stay self-contained and strategy-free.`);
  process.exit(1);
}
console.log('✓ boundaries clean');
