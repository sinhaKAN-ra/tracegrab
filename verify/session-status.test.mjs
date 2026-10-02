#!/usr/bin/env node
/**
 * easy-start: tests for the self-reporting debug-status surface (design §9).
 *
 * Framework-free (plain assert counter, no deps), matching the other verify/
 * tests. These exercise the PURE helpers from mcp/callmap.mjs — the single source
 * for the status logic shared by the MCP server, the extension host (via
 * SessionManager.touch → projectSessionStatus), and this test — so the untestable
 * vscode-coupled parts stay thin wrappers over logic that IS tested here.
 *
 * Crucially, this file actually exercises the status-file PRODUCE → DISK → READ →
 * STALE-DETECTION path (not "the code looks right"): it calls projectSessionStatus,
 * writes the result to a temp .flow-debugger/captures/session.json, reads it back
 * through JSON.parse, and runs it through evaluateDebugStatus — the same path the
 * get_debug_status tool uses.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
    evaluateDebugStatus,
    projectSessionStatus,
    neutralPause,
    filterLogBySession,
    HEARTBEAT_MS,
    STALE_MS,
} from '../mcp/callmap.mjs';

let pass = 0, fail = 0;
const assert = (condition, message) => condition
    ? (pass++, console.log(`✓ ${message}`))
    : (fail++, console.error(`✗ FAIL: ${message}`));

const nowMs = Date.parse('2025-02-10T12:00:05.000Z');
const freshIso = '2025-02-10T12:00:05.000Z';
const staleIso = '2025-02-10T11:59:30.000Z'; // 35s before now => > STALE_MS

// ---- constants are the pinned, independent values the design requires ----
assert(HEARTBEAT_MS === 5000, 'HEARTBEAT_MS is 5000');
assert(STALE_MS === 15000, 'STALE_MS is 15000');
assert(STALE_MS !== 120000, 'STALE_MS (status heartbeat age) is independent of the 120000ms pause-age model');

// ---- evaluateDebugStatus: absent / empty ----
{
    const r = evaluateDebugStatus(undefined, nowMs);
    assert(r.live === false && /NOT RUNNING/.test(r.verdict), 'absent status => NOT RUNNING, live:false');
    const r2 = evaluateDebugStatus(null, nowMs);
    assert(r2.live === false && /NOT RUNNING/.test(r2.verdict), 'null status => NOT RUNNING');
    const r3 = evaluateDebugStatus({}, nowMs);
    assert(r3.live === false, 'empty object => not live');
}

// ---- RUNNING, NOT PAUSED ----
{
    const r = evaluateDebugStatus({ live: true, paused: false, lastHeartbeatAt: freshIso }, nowMs);
    assert(r.live === true && r.stale === false, 'live + fresh heartbeat => live, not stale');
    assert(r.verdict === 'RUNNING, NOT PAUSED', 'verdict is exactly RUNNING, NOT PAUSED');
}

// ---- RUNNING, PAUSED at thread 1 ----
{
    const r = evaluateDebugStatus({ live: true, paused: true, pausedThreadId: 1, lastHeartbeatAt: freshIso }, nowMs);
    assert(r.verdict === 'RUNNING, PAUSED at thread 1', 'verdict names the paused thread');
    assert(r.paused === true && r.pausedThreadId === 1, 'paused + pausedThreadId pass through');
}

// ---- STALE by old heartbeat ----
{
    const r = evaluateDebugStatus({ live: true, paused: false, lastHeartbeatAt: staleIso }, nowMs);
    assert(r.stale === true, 'heartbeat older than STALE_MS => stale');
    assert(r.live === false, 'a stale status is reported NOT live');
    assert(/STALE/.test(r.verdict), 'verdict is STALE …');
}

// ---- STALE by missing / non-finite heartbeat ----
{
    const r = evaluateDebugStatus({ live: true, paused: false }, nowMs);
    assert(r.stale === true, 'missing heartbeat => stale');
    const r2 = evaluateDebugStatus({ live: true, lastHeartbeatAt: 'not-a-date' }, nowMs);
    assert(r2.stale === true, 'non-parseable heartbeat => stale');
}

// ---- defensive type coercion (untrusted on-disk file) ----
{
    const r = evaluateDebugStatus({ live: true, paused: false, lastHeartbeatAt: freshIso, port: '9229', pid: 'x', pausedThreadId: 'y' }, nowMs);
    assert(r.port === null, 'string port => null');
    assert(r.pid === null, 'string pid => null');
    assert(r.pausedThreadId === null, 'string pausedThreadId => null');
    const r2 = evaluateDebugStatus({ live: 'true', lastHeartbeatAt: freshIso }, nowMs);
    assert(r2.live === false, "live:'true' (string) is NOT live");
    const r3 = evaluateDebugStatus({ live: true, lastHeartbeatAt: freshIso, portSource: 'bogus', port: 1 }, nowMs);
    assert(r3.portSource === null, 'bogus portSource coerced to null');
}

// ---- verdict mutual-exclusivity (base classification) ----
{
    const base = (s) => evaluateDebugStatus(s, nowMs).verdict.split(' (note:')[0];
    const notRunning = base({ live: false });
    const running = base({ live: true, paused: false, lastHeartbeatAt: freshIso });
    const paused = base({ live: true, paused: true, pausedThreadId: 2, lastHeartbeatAt: freshIso });
    const stale = base({ live: true, lastHeartbeatAt: staleIso });
    const all = [notRunning, running, paused, stale];
    assert(new Set(all).size === 4, 'the four base verdicts are mutually distinct');
}

// ---- non-driven-paused hint (finding #4) ----
{
    const withPausedOther = evaluateDebugStatus({
        live: true, paused: false, lastHeartbeatAt: freshIso,
        otherSessions: [{ sessionId: 'other1', name: 'tests', type: 'node', paused: true }],
    }, nowMs);
    assert(/^RUNNING, NOT PAUSED/.test(withPausedOther.verdict), 'base classification unchanged by the hint');
    assert(/use_session/.test(withPausedOther.verdict), 'hint appended naming use_session when a non-driven session is paused');

    const noPausedOther = evaluateDebugStatus({
        live: true, paused: false, lastHeartbeatAt: freshIso,
        otherSessions: [{ sessionId: 'other1', name: 'tests', type: 'node', paused: false }],
    }, nowMs);
    assert(!/use_session/.test(noPausedOther.verdict), 'no hint when no other session is paused');
}

// ---- auto-launch gate classification (finding #2) ----
{
    const eligible = (s) => { const r = evaluateDebugStatus(s, nowMs); return !r.live || r.stale; };
    assert(eligible({ live: false }) === true, 'NOT RUNNING is auto-launch eligible');
    assert(eligible({ live: true, lastHeartbeatAt: staleIso }) === true, 'STALE is auto-launch eligible');
    assert(eligible({ live: true, paused: false, lastHeartbeatAt: freshIso }) === false, 'live && !stale is NOT eligible (skip auto-launch)');
}

// ---- projectSessionStatus: shape for a driven session ----
{
    const driven = {
        sessionId: 'sessA', name: 'Flow: launch (auto)', configName: 'Flow: launch (auto)',
        type: 'pwa-node', port: 9229, portSource: 'config', pid: 48213,
        pausedThreadId: 1, startedBy: 'agent', startedAt: '2025-02-10T12:00:00.000Z',
        lastPauseAt: '2025-02-10T12:00:04.100Z',
    };
    const obj = projectSessionStatus(driven, [], freshIso);
    assert(obj.live === true, 'driven => live:true');
    assert(obj.sessionId === 'sessA' && obj.paused === true, 'driven projection carries id + paused (threadId set)');
    assert(obj.port === 9229 && obj.portSource === 'config', 'config-sourced port round-trips');
    assert(obj.lastHeartbeatAt === freshIso, 'heartbeat is the supplied nowIso');

    const none = projectSessionStatus(null, [], freshIso);
    assert(none.live === false && none.sessionId === null, 'no driven => live:false, no identity');
}

// ---- PRODUCE → DISK → READ → STALE-DETECTION round-trip (the required path) ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-session-status-'));
const capturesDir = path.join(tmpRoot, '.flow-debugger', 'captures');
fs.mkdirSync(capturesDir, { recursive: true });
const sessionFile = path.join(capturesDir, 'session.json');
const writeSession = (obj) => fs.writeFileSync(sessionFile, JSON.stringify(obj, null, 2), 'utf8');
const readSession = () => JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

{
    // Produce a live/paused status, write it, read it back, evaluate it.
    const driven = { sessionId: 'rtA', name: 'svc', type: 'node', pausedThreadId: 3, startedBy: 'human', startedAt: '2025-02-10T12:00:00.000Z' };
    writeSession(projectSessionStatus(driven, [], freshIso));
    const back = readSession();
    const r = evaluateDebugStatus(back, nowMs);
    assert(r.live === true && r.verdict === 'RUNNING, PAUSED at thread 3', 'round-trip: produced paused status reads back as PAUSED at thread 3');
}
{
    // Produce a stale status on disk; the reader must flag it (A7/A11).
    const driven = { sessionId: 'rtStale', name: 'svc', type: 'node', startedBy: 'human', startedAt: '2025-02-10T11:00:00.000Z' };
    writeSession(projectSessionStatus(driven, [], staleIso));
    const r = evaluateDebugStatus(readSession(), nowMs);
    assert(r.stale === true && r.live === false, 'round-trip: an old-heartbeat status file is flagged stale on read');
}
{
    // Multi-session otherSessions round-trips; driven verdict unaffected.
    const driven = { sessionId: 'rtMulti', name: 'svc', type: 'node', startedBy: 'agent', startedAt: '2025-02-10T12:00:00.000Z' };
    const others = [{ sessionId: 'o1', name: 'tests', type: 'node', paused: false }];
    writeSession(projectSessionStatus(driven, others, freshIso));
    const back = readSession();
    assert(Array.isArray(back.otherSessions) && back.otherSessions[0].sessionId === 'o1', 'otherSessions round-trips to disk');
    const r = evaluateDebugStatus(back, nowMs);
    assert(r.verdict === 'RUNNING, NOT PAUSED', 'a non-driven session does not change the driven verdict');
}
{
    // otherSessions cap at 10 + truncation flag.
    const driven = { sessionId: 'rtCap', name: 'svc', type: 'node', startedBy: 'agent', startedAt: '2025-02-10T12:00:00.000Z' };
    const many = Array.from({ length: 15 }, (_, i) => ({ sessionId: `o${i}`, name: `s${i}`, type: 'node', paused: false }));
    const obj = projectSessionStatus(driven, many, freshIso);
    assert(obj.otherSessions.length === 10, 'otherSessions truncated to 10 on produce');
    assert(obj.otherSessionsTruncated === true, 'otherSessionsTruncated flag set when >10');
}

// ---- switch/promotion identity consistency (findings #1/#4) ----
{
    // Driven switches A -> B: both session.json.sessionId and the neutral
    // latest.json.sessionId must be B, never A, so get_pause_state cannot hand
    // out A's stale frame as B's live one.
    const drivenB = { sessionId: 'B', name: 'bee', type: 'node', startedBy: 'human', startedAt: '2025-02-10T12:00:00.000Z' };
    const sessionObj = projectSessionStatus(drivenB, [{ sessionId: 'A', name: 'ay', type: 'node', paused: false }], freshIso);
    const neutral = neutralPause('B');
    assert(sessionObj.sessionId === 'B', 'after A->B switch, session.json.sessionId is B');
    assert(neutral.sessionId === 'B' && neutral.waiting === false && neutral.sessionEnded === false, 'neutral latest.json is B, not waiting, not ended');
}

// ---- portSource round-trip + bogus coercion ----
{
    const approx = projectSessionStatus({ sessionId: 's', name: 'n', type: 'node', port: 9229, portSource: 'debugPort(approx)', startedBy: 'agent', startedAt: freshIso }, [], freshIso);
    assert(approx.portSource === 'debugPort(approx)', 'debugPort(approx) portSource round-trips');
    const nullPort = projectSessionStatus({ sessionId: 's', name: 'n', type: 'node', startedBy: 'agent', startedAt: freshIso }, [], freshIso);
    assert(nullPort.port === null && nullPort.portSource === null, 'no port => port and portSource null');
    const bogus = projectSessionStatus({ sessionId: 's', name: 'n', type: 'node', port: 1, portSource: 'nonsense', startedBy: 'agent', startedAt: freshIso }, [], freshIso);
    assert(bogus.portSource === null, 'a bogus portSource is coerced to null on produce');
}

// ---- trace-surface session filtering (finding #2) ----
{
    const lines = [
        { order: 1, frame: { name: 'a' }, sessionId: 'A' },
        { order: 2, frame: { name: 'b' }, sessionId: 'B' },
        { order: 3, frame: { name: 'c' }, sessionId: 'B' },
    ];
    const r = filterLogBySession(lines, 'B');
    assert(r.pauses.length === 2 && r.pauses.every((p) => p.sessionId === 'B'), 'only driven (B) lines survive the filter');
    assert(r.belongsToDriven === true, "belongsToDriven true when B's lines exist");

    const onlyOther = filterLogBySession([{ order: 1, frame: {}, sessionId: 'A' }], 'B');
    assert(onlyOther.pauses.length === 0 && onlyOther.belongsToDriven === false, 'log of only other sessions => no driven trace');

    const unattributed = filterLogBySession([{ order: 1, frame: {} }, { order: 2, frame: {}, sessionId: 'B' }], 'B');
    assert(unattributed.pauses.length === 2 && unattributed.belongsToDriven === true, 'sessionId-less lines are kept for the driven session (backward compat)');

    const noDrivenId = filterLogBySession([{ order: 1, frame: {}, sessionId: 'A' }], null);
    assert(noDrivenId.pauses.length === 1 && noDrivenId.belongsToDriven === true, 'with no driven id (older extension), every line is kept');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail ? 'RESULT: FAILURES ABOVE' : 'RESULT: ALL CHECKS PASSED'} (${pass} passed, ${fail} failed)`);
process.exitCode = fail ? 1 : 0;
