/**
 * Standalone verification harness for the DAP capture pipeline.
 *
 * The extension only runs inside a live VS Code Extension Host, so this harness
 * mocks the DebugSession.customRequest surface and replays a realistic DAP
 * conversation (threads -> stackTrace -> scopes -> variables), then asserts that
 * the snapshot we would post to the webview is correct.
 *
 * Run with:  node verify/dap-flow.mjs
 * This mirrors the real logic in src/extension.ts (captureAndPublishState).
 */

// ---- Mock of a DAP-backed vscode.DebugSession ----
function makeMockSession() {
  const log = [];
  return {
    log,
    async customRequest(command, args) {
      log.push({ command, args });
      switch (command) {
        case 'threads':
          return { threads: [{ id: 1, name: 'main' }] };
        case 'stackTrace':
          return {
            stackFrames: [
              { id: 1000, name: 'calculateOptimalPath', source: { name: 'astar.ts' }, line: 42 },
              { id: 1001, name: 'main', source: { name: 'index.ts' }, line: 8 },
            ],
          };
        case 'scopes':
          if (args.frameId !== 1000) throw new Error(`unexpected frameId ${args.frameId}`);
          return {
            scopes: [
              { name: 'Local', variablesReference: 2000, expensive: false },
              { name: 'Global', variablesReference: 3000, expensive: true },
            ],
          };
        case 'variables':
          if (args.variablesReference === 2000) {
            return {
              variables: [
                { name: 'nodesVisited', value: '42', type: 'number', variablesReference: 0 },
                { name: 'data', value: 'Object', type: 'object', variablesReference: 2100 },
              ],
            };
          }
          if (args.variablesReference === 2100) {
            return {
              variables: [
                { name: 'algorithm', value: '"A* Search"', type: 'string', variablesReference: 0 },
                { name: 'isOptimal', value: 'true', type: 'boolean', variablesReference: 0 },
              ],
            };
          }
          return { variables: [] };
        default:
          throw new Error(`unmocked command ${command}`);
      }
    },
  };
}

// ---- Re-implementation of the capture logic (kept in lockstep with extension.ts) ----
function mapVariables(raw) {
  return raw.map((v) => ({
    name: v.name,
    value: v.value,
    type: v.type,
    variablesReference: v.variablesReference ?? 0,
  }));
}

async function captureState(session, threadId, reason, step) {
  if (threadId === undefined) {
    const threads = await session.customRequest('threads');
    threadId = threads?.threads?.[0]?.id;
  }
  const stackTrace = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
  const rawFrames = stackTrace?.stackFrames ?? [];
  const stack = rawFrames.map((f) => ({ id: f.id, name: f.name, source: f.source?.name, line: f.line }));
  const topFrame = rawFrames[0];
  const scopes = [];
  if (topFrame) {
    const scopeResp = await session.customRequest('scopes', { frameId: topFrame.id });
    for (const scope of scopeResp?.scopes ?? []) {
      if (scope.expensive) {
        scopes.push({ name: scope.name, variablesReference: scope.variablesReference, variables: [] });
        continue;
      }
      const varResp = await session.customRequest('variables', { variablesReference: scope.variablesReference });
      scopes.push({ name: scope.name, variablesReference: scope.variablesReference, variables: mapVariables(varResp?.variables ?? []) });
    }
  }
  return { kind: 'stopped', reason, frame: stack[0] ?? null, stack, scopes, step };
}

async function expandVariable(session, variablesReference) {
  const varResp = await session.customRequest('variables', { variablesReference });
  return { kind: 'variables', variablesReference, variables: mapVariables(varResp?.variables ?? []) };
}

// ---- Assertions ----
function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

async function main() {
  const session = makeMockSession();

  // Section 1: initial stop — data flows threads -> stack -> scopes -> variables
  const snap = await captureState(session, undefined, 'breakpoint', 1);
  assert(snap.kind === 'stopped', 'publishes a "stopped" snapshot');
  assert(snap.frame?.name === 'calculateOptimalPath', 'top frame is the active function');
  assert(snap.frame?.source === 'astar.ts' && snap.frame?.line === 42, 'top frame carries source:line');
  assert(snap.stack.length === 2, 'full call stack captured (2 frames)');
  assert(snap.scopes.length === 2, 'both scopes present');
  assert(snap.scopes[0].name === 'Local' && snap.scopes[0].variables.length === 2, 'Local scope variables loaded');
  assert(snap.scopes[1].name === 'Global' && snap.scopes[1].variables.length === 0, 'expensive Global scope is NOT auto-loaded');
  const nodesVar = snap.scopes[0].variables.find((v) => v.name === 'nodesVisited');
  assert(nodesVar?.value === '42', 'primitive value captured (nodesVisited=42)');
  const dataVar = snap.scopes[0].variables.find((v) => v.name === 'data');
  assert(dataVar?.variablesReference === 2100, 'expandable object exposes a variablesReference for drill-in');

  // Section 2: interactive drill-in — webview expands "data"
  const expanded = await expandVariable(session, dataVar.variablesReference);
  assert(expanded.kind === 'variables', 'expand returns a "variables" message');
  assert(expanded.variables.length === 2, 'child variables of "data" resolved on demand');
  assert(expanded.variables.some((v) => v.name === 'algorithm' && v.value === '"A* Search"'), 'nested value captured (algorithm)');

  // Section 3: verify the exact DAP call ORDER (the data-flow contract)
  // capture: threads -> stackTrace -> scopes -> variables(Local). Global is expensive => skipped.
  // then the drill-in adds: variables(data).
  const order = session.log.map((e) => e.command);
  const expectedOrder = ['threads', 'stackTrace', 'scopes', 'variables', 'variables'];
  assert(
    JSON.stringify(order) === JSON.stringify(expectedOrder),
    `DAP call order is correct: ${order.join(' -> ')}`
  );

  console.log(process.exitCode ? '\nRESULT: FAILURES ABOVE' : '\nRESULT: ALL CHECKS PASSED');
}

main();
