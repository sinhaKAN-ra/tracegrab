/**
 * Standalone trace collector — records a trace with NO IDE.
 *
 * This file is language-agnostic: it owns the settle-loop, noise filtering,
 * secret redaction, and NDJSON writing, and knows nothing about CDP or DAP.
 * Everything protocol-specific lives in one driver file per language under
 * cli/collectors/ — see cli/collectors/driver.md for the contract and for
 * what adding a new language actually costs (usually zero new dependencies:
 * dapClient.mjs is already generic DAP, so any DAP-speaking debugger — Go's
 * delve, Java's java-debug, debugpy — is "write one driver file").
 *
 * Output is the SAME `.flow-debugger/captures/log.ndjson` the extension
 * writes, so the call-tree builder, diagnosis, FlowTrace, report, diff and
 * contracts all work unchanged regardless of source language.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactValue } from './redactLite.mjs';
import { NodeCdpDriver } from './collectors/nodeCdpDriver.mjs';
import { PythonDapDriver } from './collectors/pythonDapDriver.mjs';

const DRIVERS = {
    node: NodeCdpDriver,
    python: PythonDapDriver,
};

const NOISE_NAME = /_\d+$/;
function isNoise(name, value) {
    if (name === 'this' && /^(undefined|null)$/.test(String(value))) return true;
    if (NOISE_NAME.test(name)) return true;
    if (/^(IncomingMessage|ServerResponse|Socket|Timeout|TLSSocket)\b/.test(String(value))) return true;
    if (/^(exports|module|require|__dirname|__filename|globalThis|self|__class__)$/.test(name)) return true;
    return false;
}

/** Which languages this collector can drive, and whether each is ready right now. */
export function availableDrivers(opts = {}) {
    return Object.fromEntries(Object.entries(DRIVERS).map(([lang, D]) => [lang, D.isAvailable(opts)]));
}

/**
 * Run a headless collection.
 * @returns {Promise<{pauses:number, logPath:string, boundBreakpoints:Array, adapterErrors:string[], programOutput:string}>}
 */
export async function collect(opts) {
    const {
        language = 'node',
        program,
        args = [],
        cwd = process.cwd(),
        env = {},
        breakpoints = [],       // [{ file, line, condition? }]
        workspace = process.cwd(),
        maxPauses = 500,
        settleMs = 2000,
        totalMs = 60000,
        onPause,
        redact = process.env.FLOW_NO_REDACT !== '1',
        pythonPath,             // python driver only
    } = opts;

    const Driver = DRIVERS[language];
    if (!Driver) {
        throw new Error(`unsupported language "${language}" (available: ${Object.keys(DRIVERS).join(', ')})`);
    }
    const avail = Driver.isAvailable({ pythonPath });
    if (!avail.ok) throw new Error(avail.reason);
    if (!program) throw new Error('program is required');

    const captureDir = path.join(workspace, '.flow-debugger', 'captures');
    fs.mkdirSync(captureDir, { recursive: true });
    const logPath = path.join(captureDir, 'log.ndjson');
    fs.writeFileSync(logPath, '');
    const write = fs.createWriteStream(logPath, { flags: 'a' });

    const driver = new Driver();
    let seq = 0, pauses = 0, lastPauseAt = Date.now(), finished = false;
    let queue = Promise.resolve(); // serialize pause handling without ever dropping one
    // (a multi-threaded target — e.g. Python — can report two paused threads in a
    // burst; each must still get its own resume(), or that thread hangs forever)

    driver.on('terminated', () => { finished = true; });
    driver.on('paused', (raw) => {
        queue = queue.then(async () => {
            try {
                seq += 1;
                const state = await driver.captureState(raw);
                const vars = (state.vars ?? [])
                    .filter((v) => !isNoise(v.name, v.value))
                    .map((v) => {
                        const red = redact ? redactValue(v.name, String(v.value)) : { value: v.value };
                        return { name: v.name, value: red.value, type: v.type };
                    });
                const record = {
                    seq, at: new Date().toISOString(), reason: state.reason,
                    frame: state.frame, stackDepth: state.stackDepth,
                    vars, heapUsed: state.heapUsed, exception: state.exception,
                };
                write.write(JSON.stringify(record) + '\n');
                lastPauseAt = Date.now();
                pauses += 1;
                onPause?.(record);
                if (pauses < maxPauses) await driver.resume();
                else finished = true;
            } catch {
                try { await driver.resume(); } catch { /* give up on this pause */ }
            }
        });
    });

    await driver.connect({ program, args, cwd, env, pythonPath });
    const absBreakpoints = breakpoints.map((bp) => ({
        ...bp, file: path.isAbsolute(bp.file) ? bp.file : path.resolve(cwd, bp.file),
    }));
    const bound = await driver.setBreakpoints(absBreakpoints);
    await driver.run();

    const started = Date.now();
    while (Date.now() - started < totalMs) {
        await new Promise((r) => setTimeout(r, 150));
        if (finished) break;
        if (pauses > 0 && Date.now() - lastPauseAt > settleMs) break;
        if (driver.exited) break;
    }

    const adapterErrors = driver.adapterErrors ?? [];
    const programOutput = driver.programOutput ?? '';
    driver.close();
    await new Promise((r) => write.end(r));

    for (const b of bound) if (b.verified === undefined) b.verified = driver.isResolved(b.id);

    return { pauses, logPath, boundBreakpoints: bound, adapterErrors, programOutput };
}

/**
 * Build the normalized/filtered/redacted pause record from a driver's raw
 * captureState output. Shared by collect() and collectInteractive() so both
 * paths produce byte-identical records.
 */
function buildRecord(seq, state, redact) {
    const vars = (state.vars ?? [])
        .filter((v) => !isNoise(v.name, v.value))
        .map((v) => {
            const red = redact ? redactValue(v.name, String(v.value)) : { value: v.value };
            return { name: v.name, value: red.value, type: v.type };
        });
    return {
        seq, at: new Date().toISOString(), reason: state.reason,
        frame: state.frame, stackDepth: state.stackDepth,
        vars, heapUsed: state.heapUsed, exception: state.exception,
    };
}

/**
 * Interactive, NON-RESUMING collection (roadmap: interactive headless debugging).
 *
 * Unlike collect(), this does NOT auto-resume on each pause. It PARKS at every
 * pause, hands the record to onPaused(record, driver), then polls an injected
 * command source and dispatches each new command to the driver's interactive
 * primitives — advancing execution only on an explicit continue/step command.
 *
 * The caller injects the command channel so this file stays free of
 * .flow-debugger path logic and MCP coupling:
 *   - onPaused(record, driver): called once per pause, before parking.
 *   - command.read(): returns the latest command object `{id, action, ...}` or
 *     null. Deduped here by id, so returning the same command repeatedly is safe.
 *   - command.ack({ id, ok, result?, message? }): called once per dispatched command.
 *   - shouldStop(): returns true to break out of the park loop (terminate/kill).
 *
 * Command actions dispatched to the driver:
 *   continue                      -> driver.resume()            (advances; breaks park)
 *   stepOver | stepIn | stepOut   -> driver.step('over'|'in'|'out') (advances; breaks park)
 *   setVariable {variablesReference,name,value} -> driver.setVariable(...)
 *   evaluate   {expression,context?,frameId?}   -> driver.evaluate(...)
 *   stackTrace {threadId?}        -> driver.stackTrace(...)
 *   scopes     {frameId}          -> driver.scopes(...)
 *   variables  {variablesReference} -> driver.variables(...)
 *   pauseInfo                     -> no-op ack (ok:true)
 *
 * @returns {Promise<{pauses:number, logPath:string, boundBreakpoints:Array, adapterErrors:string[], programOutput:string}>}
 */
export async function collectInteractive(opts) {
    const {
        language = 'node',
        program,
        args = [],
        cwd = process.cwd(),
        env = {},
        breakpoints = [],
        workspace = process.cwd(),
        maxPauses = 500,
        totalMs = 60000,
        redact = process.env.FLOW_NO_REDACT !== '1',
        pythonPath,
        onPaused,
        command = { read: () => null, ack: () => {} },
        shouldStop = () => false,
        pollMs = 120,
    } = opts;

    const Driver = DRIVERS[language];
    if (!Driver) {
        throw new Error(`unsupported language "${language}" (available: ${Object.keys(DRIVERS).join(', ')})`);
    }
    const avail = Driver.isAvailable({ pythonPath });
    if (!avail.ok) throw new Error(avail.reason);
    if (!program) throw new Error('program is required');

    const captureDir = path.join(workspace, '.flow-debugger', 'captures');
    fs.mkdirSync(captureDir, { recursive: true });
    const logPath = path.join(captureDir, 'log.ndjson');
    fs.writeFileSync(logPath, '');
    const write = fs.createWriteStream(logPath, { flags: 'a' });

    const driver = new Driver();
    let seq = 0, pauses = 0, finished = false, lastCommandId = null;
    let queue = Promise.resolve(); // serialize pause handling without ever dropping one

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Dispatch one command object to a driver primitive; returns the ack payload.
    async function dispatch(cmd) {
        const action = cmd.action ?? cmd.type;
        switch (action) {
            case 'continue':
                await driver.resume();
                return { ok: true, advanced: true };
            case 'stepOver':
                await driver.step('over');
                return { ok: true, advanced: true };
            case 'stepIn':
                await driver.step('in');
                return { ok: true, advanced: true };
            case 'stepOut':
                await driver.step('out');
                return { ok: true, advanced: true };
            case 'setVariable':
                return { ok: true, result: await driver.setVariable(cmd), advanced: false };
            case 'evaluate':
                return { ok: true, result: await driver.evaluate(cmd), advanced: false };
            case 'stackTrace':
                return { ok: true, result: await driver.stackTrace(cmd), advanced: false };
            case 'scopes':
                return { ok: true, result: await driver.scopes(cmd), advanced: false };
            case 'variables':
                return { ok: true, result: await driver.variables(cmd), advanced: false };
            case 'pauseInfo':
                return { ok: true, advanced: false };
            default:
                return { ok: false, message: `unknown command action "${action}"`, advanced: false };
        }
    }

    driver.on('terminated', () => { finished = true; });
    driver.on('paused', (raw) => {
        queue = queue.then(async () => {
            try {
                seq += 1;
                const state = await driver.captureState(raw);
                const record = buildRecord(seq, state, redact);
                write.write(JSON.stringify(record) + '\n');
                pauses += 1;
                await onPaused?.(record, driver);

                if (pauses >= maxPauses) { finished = true; await driver.resume(); return; }

                // PARK: wait for an advancing command, servicing read-only ones in place.
                for (;;) {
                    if (shouldStop() || finished || driver.exited) return;
                    const cmd = command.read();
                    if (cmd && cmd.id !== lastCommandId) {
                        lastCommandId = cmd.id;
                        let ack;
                        try { ack = await dispatch(cmd); }
                        catch (e) { ack = { ok: false, message: e.message, advanced: false }; }
                        const { advanced, ...rest } = ack;
                        command.ack({ id: cmd.id, ...rest });
                        if (advanced) return; // execution advances to the next pause
                    }
                    await sleep(pollMs);
                }
            } catch {
                try { await driver.resume(); } catch { /* give up on this pause */ }
            }
        });
    });

    await driver.connect({ program, args, cwd, env, pythonPath });
    const absBreakpoints = breakpoints.map((bp) => ({
        ...bp, file: path.isAbsolute(bp.file) ? bp.file : path.resolve(cwd, bp.file),
    }));
    const bound = await driver.setBreakpoints(absBreakpoints);
    await driver.run();

    const started = Date.now();
    while (Date.now() - started < totalMs) {
        await sleep(pollMs);
        if (finished) break;
        if (shouldStop()) break;
        if (driver.exited) break;
    }

    await queue; // let any in-flight pause settle before teardown
    const adapterErrors = driver.adapterErrors ?? [];
    const programOutput = driver.programOutput ?? '';
    driver.close();
    await new Promise((r) => write.end(r));

    for (const b of bound) if (b.verified === undefined) b.verified = driver.isResolved(b.id);

    return { pauses, logPath, boundBreakpoints: bound, adapterErrors, programOutput };
}
