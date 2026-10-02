#!/usr/bin/env node
/**
 * flow-debugger CLI (Option 2 drive path).
 *
 * Writes a scenario JSON to <workspace>/.flow-debugger/scenario.json, which the
 * running "API Flow Test Debugger" extension watches and auto-runs (sets the
 * breakpoints, fires the API-call sequence). No editor-command access needed —
 * any terminal, CI job, or AI agent that can run a shell command can drive it.
 *
 * Usage:
 *   node cli/flow-run.mjs <scenario.json> [--workspace <dir>]
 *   cat scenario.json | node cli/flow-run.mjs -            [--workspace <dir>]
 *
 * The extension must already be running (open the panel once:
 *   "API Flow Test Debugger: Start"), and your target API must be running under
 * the VS Code/Cursor debugger so the breakpoints can bind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function fail(msg) {
    process.stderr.write(`flow-run: ${msg}\n`);
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(
        'Usage: node cli/flow-run.mjs <scenario.json | -> [--workspace <dir>]\n'
    );
    process.exit(args.length === 0 ? 1 : 0);
}

const wsIdx = args.indexOf('--workspace');
const workspace = wsIdx !== -1 ? args[wsIdx + 1] : process.cwd();
const src = args[0];

let rawText;
if (src === '-') {
    rawText = fs.readFileSync(0, 'utf8'); // stdin
} else {
    if (!fs.existsSync(src)) fail(`scenario file not found: ${src}`);
    rawText = fs.readFileSync(src, 'utf8');
}

let scenario;
try {
    scenario = JSON.parse(rawText);
} catch (e) {
    fail(`invalid JSON: ${e.message}`);
}
if (!scenario || typeof scenario !== 'object' || !Array.isArray(scenario.calls)) {
    fail('scenario must be an object with a "calls" array (see docs/AGENTS.md)');
}

const dir = path.join(workspace, '.flow-debugger');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'scenario.json');
// Write atomically so the watcher never reads a half-written file.
const tmp = `${out}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(scenario, null, 2), 'utf8');
fs.renameSync(tmp, out);

process.stdout.write(
    `flow-run: wrote ${out} (${scenario.calls.length} call(s), ` +
        `${Array.isArray(scenario.breakpoints) ? scenario.breakpoints.length : 0} breakpoint(s)). ` +
        'The running extension will pick it up and run.\n'
);
