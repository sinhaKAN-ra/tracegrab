import * as path from 'node:path';

/**
 * Resolve a scenario breakpoint's file to an absolute fs path.
 * Absolute paths pass through; relative paths resolve against workspaceRoot.
 * Pure + vscode-free so it is unit-testable in plain Node.
 */
export function resolveBreakpointPath(file: string, workspaceRoot: string): string {
    if (path.isAbsolute(file)) return path.normalize(file);
    return path.normalize(path.join(workspaceRoot, file));
}

/** Dedupe key so the same file:line isn't added twice. */
export function bpKey(file: string, line: number): string {
    return `${file}:${line}`;
}

/**
 * Decide which threadId to resume/step, given the thread we recorded as paused
 * and (as a fallback) the list of threads the session reports. Pure + vscode-
 * free so the continue-targeting logic is unit-testable.
 *
 * - Prefer the tracked paused thread — a `stopped` event named it explicitly.
 * - Else fall back to the first reported thread (single-threaded debuggees like
 *   a typical Node process only ever have one).
 * - Else undefined — the caller must not resume a guessed id (the old bug was
 *   hardcoding 0, which can target the wrong thread or none).
 */
export function resolveResumeThreadId(
    trackedPausedThreadId: number | undefined,
    reportedThreads: Array<{ id: number }> | undefined
): number | undefined {
    if (trackedPausedThreadId !== undefined) return trackedPausedThreadId;
    return reportedThreads?.[0]?.id;
}
