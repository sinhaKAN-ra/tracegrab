import * as vscode from 'vscode';
import type { Breakpoint } from './protocol.js';
import { resolveBreakpointPath, bpKey } from './breakpointPath.js';

export { resolveBreakpointPath, bpKey };

/**
 * Manages the breakpoints this extension owns. Only touches breakpoints it
 * added (tracked by key), so it never clobbers a user's hand-set breakpoints.
 */
export class BreakpointManager {
    /** key -> the vscode.Breakpoint we created, so we can remove exactly ours. */
    private owned = new Map<string, vscode.Breakpoint>();

    constructor(private workspaceRoot: string) {}

    /**
     * Apply a set of scenario breakpoints. Replaces any previously-owned ones.
     * Returns the normalized list actually applied (enabled reflects success).
     */
    apply(breakpoints: Breakpoint[]): Breakpoint[] {
        this.clear();
        const toAdd: vscode.Breakpoint[] = [];
        const applied: Breakpoint[] = [];

        for (const bp of breakpoints) {
            if (bp.enabled === false) {
                applied.push({ ...bp, enabled: false });
                continue;
            }
            const abs = resolveBreakpointPath(bp.file, this.workspaceRoot);
            // B3: content-addressed resolution — find the line by statement text or
            // function name so the breakpoint survives edits above it. Falls back
            // to bp.line when there's no match.
            const resolved = resolveLine(abs, bp);
            const location = new vscode.Location(
                vscode.Uri.file(abs),
                new vscode.Position(Math.max(0, resolved.line - 1), 0) // DAP/VS Code Position is 0-based
            );
            const vsbp = new vscode.SourceBreakpoint(location, true, bp.condition || undefined);
            this.owned.set(bpKey(abs, resolved.line), vsbp);
            toAdd.push(vsbp);
            applied.push({ ...bp, line: resolved.line, enabled: true, label: resolved.note ?? bp.label });
        }

        if (toAdd.length > 0) {
            vscode.debug.addBreakpoints(toAdd);
        }
        return applied;
    }

    /** Remove only the breakpoints this manager added. */
    clear(): void {
        const mine = [...this.owned.values()];
        if (mine.length > 0) {
            vscode.debug.removeBreakpoints(mine);
        }
        this.owned.clear();
    }

    count(): number {
        return this.owned.size;
    }

    /** Keys ("abs/path:line") of the breakpoints THIS tool created, so the panel
     *  can tell scenario/agent-set breakpoints apart from the user's own. */
    ownedKeys(): Set<string> {
        return new Set(this.owned.keys());
    }
}

/**
 * B3: resolve a content-addressed breakpoint to a line. Prefer a statement-text
 * substring match, then a function/symbol declaration, else the given line.
 * Returns the line plus a note when it re-anchored (or warns on no match).
 */
function resolveLine(
    absPath: string,
    bp: { line: number; statement?: string; function?: string }
): { line: number; note?: string } {
    if (!bp.statement && !bp.function) return { line: bp.line };
    let text: string;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        text = require('fs').readFileSync(absPath, 'utf8');
    } catch {
        return { line: bp.line, note: `content-address: file unreadable, used line ${bp.line}` };
    }
    const lines = text.split(/\r?\n/);
    if (bp.statement) {
        const needle = bp.statement.trim();
        const idx = lines.findIndex((l) => l.includes(needle));
        if (idx >= 0) return { line: idx + 1, note: `matched statement "${needle}" at line ${idx + 1}` };
    }
    if (bp.function) {
        const fn = bp.function.trim();
        // match common declaration shapes: `function foo`, `foo(`, `foo =`, `foo:`, method `foo(`
        const re = new RegExp(`(function\\s+${escapeRe(fn)}\\b|\\b${escapeRe(fn)}\\s*[=:(])`);
        const idx = lines.findIndex((l) => re.test(l));
        if (idx >= 0) return { line: idx + 1, note: `matched function "${fn}" at line ${idx + 1}` };
    }
    // No match — fall back but warn loudly so a stale line isn't trusted silently.
    return { line: bp.line, note: `⚠ content-address NOT found (statement/function); fell back to line ${bp.line}` };
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
