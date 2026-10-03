import * as path from 'node:path';

/**
 * Pure, vscode-free helpers for the click-to-open-source feature so the host's
 * `openSource` and the Findings `where` parsing are unit-testable in plain Node.
 *
 * The live bug had two root causes this module addresses:
 *   1. The capture only kept a basename ("server.js"), forcing a fragile
 *      recursive findFiles glob by filename that could resolve the wrong file
 *      or none. `resolveOpenSourceTarget` classifies the incoming `file` so the host can
 *      open an absolute/relative path DIRECTLY and only glob as a last resort.
 *   2. Findings `where` strings that are not plain `file:line` (e.g. "process",
 *      "n/a", or an absolute Windows path with a drive-letter colon) silently
 *      failed a `^(.*):(\d+)$` regex and became a no-op. `parseWhere` tolerates
 *      drive-letter colons and reports non-locatable wheres so the caller can
 *      surface a visible message instead of doing nothing.
 */

export type OpenSourceTarget =
    | { kind: 'absolute'; fsPath: string }
    | { kind: 'relative'; fsPath: string }
    | { kind: 'glob'; basename: string }
    | { kind: 'unresolvable'; reason: string };

/** True for POSIX ("/x") and Windows ("C:\x" / "C:/x") absolute paths. */
export function isAbsolutePath(file: string): boolean {
    return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
}

/**
 * Decide how the host should turn a webview-supplied `file` into an editor URI.
 * - absolute path  -> open directly (no glob).
 * - path with a separator (relative) -> resolve against the workspace root.
 * - bare basename  -> needs a workspace glob to locate.
 * - empty / junk   -> unresolvable (caller shows an info, never a silent no-op).
 */
export function resolveOpenSourceTarget(
    file: string,
    workspaceRoot: string | undefined
): OpenSourceTarget {
    const f = (file ?? '').trim();
    if (!f) return { kind: 'unresolvable', reason: 'no file given' };
    if (isAbsolutePath(f)) return { kind: 'absolute', fsPath: path.normalize(f) };
    if (f.includes('/') || f.includes('\\')) {
        if (!workspaceRoot) return { kind: 'unresolvable', reason: `no workspace to resolve ${f}` };
        return { kind: 'relative', fsPath: path.normalize(path.join(workspaceRoot, f)) };
    }
    return { kind: 'glob', basename: f };
}

/**
 * Parse a Findings `where` string into a locatable { file, line }.
 * Accepts:
 *   - "server.js:50"                       -> { file: "server.js", line: 50 }
 *   - "/Users/me/app/server.js:50"         -> absolute POSIX + line
 *   - "C:\\app\\server.js:50"              -> absolute Windows (keeps drive colon)
 *   - "/Users/me/app/server.js"            -> file only (line defaults to 1)
 * Rejects (returns null) non-locatable labels like "process" or "n/a" so the
 * caller can show a visible info instead of a silent no-op.
 */
export function parseWhere(where: string): { file: string; line: number } | null {
    const w = (where ?? '').trim();
    if (!w) return null;

    // Split a trailing ":<digits>" as the line, allowing the file portion to
    // contain its own colons (drive letters / absolute Windows paths).
    const m = /^(.*?):(\d+)$/.exec(w);
    if (m) {
        const file = m[1].trim();
        const line = Number(m[2]);
        if (file && isLocatable(file)) return { file, line: line > 0 ? line : 1 };
        return null;
    }

    // No trailing line. Treat as a file if it LOOKS like one (has a path
    // separator or a dotted extension); otherwise it's a bare label we can't open.
    if (isLocatable(w) && (w.includes('/') || w.includes('\\') || /\.[A-Za-z0-9]+$/.test(w))) {
        return { file: w, line: 1 };
    }
    return null;
}

/** A where/file is locatable only if it is not an obvious non-file label. */
function isLocatable(file: string): boolean {
    const f = file.trim().toLowerCase();
    if (!f) return false;
    // Known non-file placeholders emitted by inferState findings.
    if (f === 'process' || f === 'n/a' || f === 'na' || f === 'unknown') return false;
    return true;
}
