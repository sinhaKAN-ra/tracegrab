import type { ApiCall, Scenario, CallResult } from './protocol.js';

export type FetchLike = (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

/** Resolve a very small subset of JSONPath: $.a.b, $.a[0].b */
export function extractPath(obj: unknown, path: string): unknown {
    if (!path.startsWith('$')) return undefined;
    const parts = path
        .slice(1)
        .split(/\.|(\[\d+\])/)
        .filter((p): p is string => Boolean(p) && p !== '.');
    let cur: unknown = obj;
    for (const raw of parts) {
        if (cur == null) return undefined;
        const arr = /^\[(\d+)\]$/.exec(raw);
        if (arr) {
            cur = Array.isArray(cur) ? cur[Number(arr[1])] : undefined;
        } else {
            cur = (cur as Record<string, unknown>)[raw];
        }
    }
    return cur;
}

/** Replace ${name} placeholders in a string using the vars map. */
export function interpolate(input: string, vars: Record<string, string>): string {
    return input.replace(/\$\{(\w+)\}/g, (_m, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : `\${${name}}`
    );
}

function applyVars(call: ApiCall, vars: Record<string, string>): ApiCall {
    return {
        ...call,
        url: interpolate(call.url, vars),
        body: call.body ? interpolate(call.body, vars) : undefined,
        headers: call.headers
            ? Object.fromEntries(
                  Object.entries(call.headers).map(([k, v]) => [k, interpolate(v, vars)])
              )
            : undefined,
    };
}

export interface RunHooks {
    /** Called immediately before this HTTP call starts — used to attribute every
     * debugger pause during the await to the correct call. */
    onCallStart?: (call: ApiCall, index: number) => void;
    onCallResult?: (r: CallResult) => void;
    /** Called after result/pause-count finalization, even for timeout/cancel. */
    onCallEnd?: (r: CallResult, index: number) => void;
    /** Returns the number of debugger pauses observed while this call ran. */
    pauseCountFor?: (callId: string) => number;
    /** Cancels the current call and prevents later calls from starting. */
    signal?: AbortSignal;
    /** Per-call timeout. Undefined/0 preserves the old unlimited behavior. */
    timeoutMs?: number;
}

/**
 * Run fetch with a timeout and parent cancellation even when a test FetchLike
 * ignores AbortSignal. The real global fetch also receives the derived signal,
 * so its underlying socket is cancelled rather than merely ignored.
 */
function controlledFetch(
    fetchImpl: FetchLike,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    signal?: AbortSignal,
    timeoutMs?: number
): Promise<{ status: number; ok: boolean; text: () => Promise<string> }> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onCancel);
        };
        const succeed = (v: { status: number; ok: boolean; text: () => Promise<string> }) => {
            if (settled) return;
            settled = true; cleanup(); resolve(v);
        };
        const fail = (e: unknown) => {
            if (settled) return;
            settled = true; cleanup(); reject(e);
        };
        const onCancel = () => {
            controller.abort();
            fail(new Error('Run cancelled'));
        };
        if (signal?.aborted) { onCancel(); return; }
        signal?.addEventListener('abort', onCancel, { once: true });
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timer = setTimeout(() => {
                controller.abort();
                fail(new Error(`Timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        void fetchImpl(url, { ...init, signal: controller.signal }).then(succeed, fail);
    });
}

/**
 * Run a scenario: fire each call in order, chain extracted values forward.
 * Returns all calls that actually started. Never throws on a call failure —
 * records it. Cancellation records the in-flight call, then stops the sequence.
 */
export async function runScenario(
    scenario: Scenario,
    fetchImpl: FetchLike,
    hooks: RunHooks = {}
): Promise<CallResult[]> {
    const vars: Record<string, string> = {};
    const results: CallResult[] = [];

    for (let index = 0; index < scenario.calls.length; index++) {
        const rawCall = scenario.calls[index];
        if (rawCall.enabled === false) continue; // per-call selection: skip disabled
        if (hooks.signal?.aborted) break;
        const call = applyVars(rawCall, vars);
        const started = Date.now();
        const result: CallResult = {
            callId: call.id,
            name: call.name,
            status: null,
            ok: false,
            durationMs: 0,
            pauseCount: 0,
        };

        hooks.onCallStart?.(call, index);
        try {
            const res = await controlledFetch(fetchImpl, call.url, {
                method: call.method,
                headers: { 'Content-Type': 'application/json', ...(call.headers ?? {}) },
                body: call.method === 'GET' ? undefined : call.body,
            }, hooks.signal, hooks.timeoutMs);
            const text = await res.text();
            result.status = res.status;
            result.ok = res.ok;
            result.responseBody = text;

            // Chain: extract fields from this response into vars for later calls.
            if (rawCall.extract && text) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    parsed = undefined;
                }
                for (const [name, path] of Object.entries(rawCall.extract)) {
                    const val = extractPath(parsed, path);
                    if (val !== undefined) vars[name] = String(val);
                }
            }
        } catch (err) {
            result.error = err instanceof Error ? err.message : String(err);
        }

        result.durationMs = Date.now() - started;
        result.pauseCount = hooks.pauseCountFor?.(call.id) ?? 0;
        results.push(result);
        hooks.onCallResult?.(result);
        hooks.onCallEnd?.(result, index);
        if (hooks.signal?.aborted) break;
    }

    return results;
}
