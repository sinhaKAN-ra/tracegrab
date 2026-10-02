#!/usr/bin/env node
/**
 * Headless demo / visual-proof harness.
 *
 * Builds a STANDALONE HTML page from the real built webview bundle
 * (webview-ui/dist) + a mock `acquireVsCodeApi` that replays a scripted DAP
 * pause stream (fan-out + N+1 + loop + mutation + error + a rising/falling
 * heap series). The page is self-contained — open it in ANY browser or a new
 * tab for a clean, full-screen view of the Call Map, outside the cramped
 * editor panel.
 *
 * Usage:
 *   npm run build --prefix webview-ui   # ensure dist is fresh
 *   node verify/make-demo.mjs           # writes verify/demo/index.html
 *   node verify/make-demo.mjs --open    # also open it in the default browser
 *   node verify/make-demo.mjs --shot    # also screenshot via headless Chrome if present
 *
 * The scripted stream is the SAME message shape the extension host posts
 * (kind:'session' / 'stopped' with memory+exception), so the page exercises the
 * real App.tsx reducer and CallMap render path — genuine visual proof, not a mock.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'webview-ui', 'dist', 'assets');
// Canonical, repo-tracked location for the demo page + visual-proof screenshot,
// so it doubles as documentation / future reference.
const outDir = path.join(root, 'docs', 'screenshots');

function readAsset(ext) {
    const f = fs.readdirSync(distDir).find((n) => n.endsWith(ext));
    if (!f) throw new Error(`No ${ext} in ${distDir} — run: npm run build --prefix webview-ui`);
    return fs.readFileSync(path.join(distDir, f), 'utf8');
}

// ---- scripted DAP pause stream: controller -> 2 services -> DB (with N+1 + loop + mutation + error) ----
const F = (name, source, line) => ({ id: 1, name, source, line });
const V = (o) => Object.entries(o).map(([name, value]) => ({ name, value, variablesReference: 0 }));
const scope = (vars) => [{ name: 'Local', variablesReference: 1, variables: vars }];
// A realistic multi-scope shape (mirrors the allocateTask capture): clean Local
// locals + a noisy Closure full of module imports + this:undefined.
const richScopes = (localVars) => [
    { name: 'Local', variablesReference: 1, variables: [
        ...V(localVars),
        { name: 'this', value: 'undefined', variablesReference: 0 },
        { name: 'req', value: 'IncomingMessage {_events:{…}, socket:Socket, httpVersionMajor:1, …}', variablesReference: 91 },
        { name: 'res', value: 'ServerResponse {_events:{…}, outputData:Array(0), …}', variablesReference: 92 },
    ] },
    { name: 'Closure', variablesReference: 2, variables: [
        { name: 'AllocationService_1', value: '{AllocationService: ƒ, __esModule: true}', variablesReference: 93 },
        { name: 'be_stdlib_1', value: '{createHttpDrainHandler: <accessor>, gracefulShutdown: <accessor>, …}', variablesReference: 94 },
        { name: 'be_stdlib_2', value: '{createHttpDrainHandler: <accessor>, …}', variablesReference: 95 },
        { name: 'Consumer_1', value: '{Consumer: ƒ, __esModule: true}', variablesReference: 96 },
        { name: 'entity_library_1', value: '{DFGResponse: <accessor>, Entity: <accessor>, …}', variablesReference: 97 },
    ] },
];
const mem = (heapUsed) => ({ order: 0, heapUsed, heapTotal: heapUsed + 500000, rss: heapUsed + 2000000, heapDelta: 0 });

let step = 0;
const stop = (frame, stack, vars, extra = {}) => ({
    kind: 'stopped', reason: extra.reason || 'breakpoint', frame, stack,
    scopes: scope(V(vars)), step: ++step, dbMode: 'mocked', external: extra.external ?? true, ...extra,
});

// stack is [top, ...callers]; depths drive the tree.
const STREAM = [
    { kind: 'init', scenario: { id: 's1', name: 'Demo: getDashboard flow', dbMode: 'mocked', calls: [
        { id: 'c1', name: 'get', method: 'GET', url: 'http://127.0.0.1:8004/dashboard/U7', extract: { uid: '$.id' } },
        { id: 'c2', name: 'refresh', method: 'POST', url: 'http://127.0.0.1:8004/dashboard/${uid}/refresh', enabled: false },
    ], breakpoints: [] }, mockSets: [] },
    { kind: 'session', status: 'started', name: 'Demo: getDashboard' },
    stop(F('getDashboard', 'dash.ctrl.ts', 20), [1], { userId: 'U7' }, { memory: mem(3_000_000) }),
    stop(F('getProfile', 'profile.svc.ts', 9), [1, 1], { q: 'byId(U7)' }, { memory: mem(3_200_000) }),
    stop(F('findUser', 'users.repo.ts', 14), [1, 1, 1], { row: '{name:Kai}' }, { memory: mem(3_500_000) }),
    stop(F('getProfile', 'profile.svc.ts', 12), [1, 1], { profile: '{name:Kai}' }, { memory: mem(3_300_000) }),
    stop(F('getDashboard', 'dash.ctrl.ts', 28), [1], { profile: '{name:Kai}' }, { memory: mem(3_250_000) }),
    stop(F('getOrders', 'orders.svc.ts', 11), [1, 1], { ids: '[o1,o2,o3]' }, { memory: mem(3_600_000) }),
    // loop over 3 ids, each hits findItem in the DB layer => N+1
    stop(F('getOrders', 'orders.svc.ts', 15), [1, 1], { i: '0', sum: '0' }, { memory: mem(3_800_000) }),
    stop(F('findItem', 'items.repo.ts', 8), [1, 1, 1], { id: 'o1' }, { memory: mem(4_100_000) }),
    stop(F('getOrders', 'orders.svc.ts', 15), [1, 1], { i: '1', sum: '10' }, { memory: mem(4_400_000) }),
    stop(F('findItem', 'items.repo.ts', 8), [1, 1, 1], { id: 'o2' }, { memory: mem(4_700_000) }),
    stop(F('getOrders', 'orders.svc.ts', 15), [1, 1], { i: '2', sum: '30' }, { memory: mem(4_200_000) }),
    stop(F('findItem', 'items.repo.ts', 8), [1, 1, 1], { id: 'o3' }, { memory: mem(3_900_000) }),
    // an error path in the DB layer
    stop(F('findItem', 'items.repo.ts', 9), [1, 1, 1], { id: 'o3' },
        { reason: 'exception', memory: mem(3_700_000), exception: { message: 'timeout querying items', type: 'DBTimeout' } }),
    stop(F('getDashboard', 'dash.ctrl.ts', 34), [1], { res: '{profile,orders}' }, { memory: mem(3_600_000) }),
];
// Give the final (active) pause the realistic multi-scope shape.
STREAM[STREAM.length - 1].scopes = richScopes({ userId: "'U7'", res: "{profile,orders}" });
// Show the mock editor populated + the categorised editor-breakpoint list.
STREAM.push({ kind: 'mockSet', mockSet: {
    name: 'dashboard-fixtures', language: 'node',
    variableOverrides: { 'orders.svc.ts:15:sum': '999' },
    boundaryMocks: [
        { match: 'db.findUser', returns: { id: 'U7', name: 'Kai' } },
        { match: 'db.findOrders', returns: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] },
    ],
} });
STREAM.push({ kind: 'allBreakpoints', entries: [
    { file: 'dash.ctrl.ts', line: 20, enabled: true, source: 'scenario' },
    { file: 'orders.svc.ts', line: 15, condition: 'i === 2', enabled: true, source: 'scenario' },
    { file: 'items.repo.ts', line: 8, enabled: true, source: 'manual' },
    { file: 'profile.svc.ts', line: 9, enabled: false, source: 'manual' },
] });

const js = readAsset('.js');
const css = readAsset('.css');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API Flow Test Debugger — Call Map (demo)</title>
<style>${css}</style>
<style>
  html,body{margin:0;background:#0b0f1e;color:#e2e8f0;height:100%;}
  #root{height:100vh;}
  .demo-banner{position:fixed;top:0;left:0;right:0;z-index:9999;font:12px ui-monospace,monospace;
    background:rgba(99,102,241,0.18);color:#c7d2fe;padding:4px 10px;border-bottom:1px solid rgba(99,102,241,0.4);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
</style>
</head><body>
<div class="demo-banner">DEMO — replaying a scripted pause stream through the real built bundle. Open in a new tab for a full-screen view.</div>
<div id="root" style="padding-top:24px;"></div>
<script>
  // The canonical screenshot verifies the runtime workspace, not the first-run
  // help overlay. Help has its own interaction flow and would obscure every
  // control this harness is meant to prove.
  try { localStorage.setItem('flowdbg.helpSeen', '1'); } catch {}
  // Mock the VS Code webview bridge: capture postMessage, feed the scripted stream in.
  const STREAM = ${JSON.stringify(STREAM)};
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) { /* webview -> host: openSource/etc. no-op in demo */
        if (m && m.kind === 'openSource') console.log('openSource', m.file, m.line);
      },
      getState: function () { return undefined; },
      setState: function () {},
    };
  };
  // After the bundle mounts and posts {kind:'ready'}, drip-feed the stream.
  let i = 0, started = false;
  function pump() {
    if (i >= STREAM.length) return;
    window.postMessage(STREAM[i++], '*');
    setTimeout(pump, 15);
  }
  function start() { if (started) return; started = true; pump(); }
  window.addEventListener('load', function () { setTimeout(start, 200); });
  setTimeout(start, 600); // belt-and-suspenders for headless timing
</script>
<script type="module">${js}</script>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'index.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log(`Demo written: ${outFile}`);
console.log(`Open in a browser:  file://${outFile}`);

const args = process.argv.slice(2);
if (args.includes('--open')) {
    try { execSync(`open "${outFile}"`, { stdio: 'ignore' }); } catch { /* non-mac */ }
}
if (args.includes('--shot')) {
    const chromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    const chrome = chromePaths.find((p) => fs.existsSync(p));
    const shot = path.join(outDir, 'callmap.png');
    if (chrome) {
        try {
            execSync(
                `"${chrome}" --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --hide-scrollbars ` +
                `--force-device-scale-factor=2 --window-size=1500,1000 --screenshot="${shot}" ` +
                `--virtual-time-budget=5000 "file://${outFile}"`,
                { stdio: 'pipe', timeout: 30000 }
            );
            console.log(`Screenshot written: ${shot}`);
        } catch (e) {
            console.error('Headless screenshot failed:', String(e.message || e));
            process.exitCode = 0; // demo html is still valid
        }
    } else {
        console.log('No headless Chrome/Chromium/Edge found — open the file URL above to view it.');
    }
}
