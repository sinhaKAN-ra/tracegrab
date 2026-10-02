import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MockSet } from './protocol.js';

/**
 * File-backed store for shared mock sets. Lives under
 *   <workspace>/.flow-debugger/mocks/<name>.json
 * The same MockSet format is hand-written, imported from a unit-test fixture,
 * or captured from a live run.
 */
export class MockStore {
    constructor(private baseDir: string) {}

    private dir(): string {
        return path.join(this.baseDir, '.flow-debugger', 'mocks');
    }

    private ensureDir(): void {
        fs.mkdirSync(this.dir(), { recursive: true });
    }

    list(): string[] {
        try {
            return fs
                .readdirSync(this.dir())
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.replace(/\.json$/, ''));
        } catch {
            return [];
        }
    }

    load(name: string): MockSet | undefined {
        try {
            const raw = fs.readFileSync(path.join(this.dir(), `${name}.json`), 'utf8');
            return normalizeMockSet(JSON.parse(raw), name);
        } catch {
            return undefined;
        }
    }

    save(mockSet: MockSet): void {
        this.ensureDir();
        const safe = normalizeMockSet(mockSet, mockSet.name);
        fs.writeFileSync(
            path.join(this.dir(), `${safe.name}.json`),
            JSON.stringify(safe, null, 2),
            'utf8'
        );
    }
}

/** Coerce arbitrary JSON into a valid MockSet (never throws). */
export function normalizeMockSet(raw: unknown, fallbackName: string): MockSet {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const overridesRaw =
        obj.variableOverrides && typeof obj.variableOverrides === 'object'
            ? (obj.variableOverrides as Record<string, unknown>)
            : {};
    const variableOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(overridesRaw)) {
        variableOverrides[k] = String(v);
    }
    const boundaryMocks = Array.isArray(obj.boundaryMocks)
        ? obj.boundaryMocks
              .filter((m) => m && typeof m === 'object' && typeof (m as Record<string, unknown>).match === 'string')
              .map((m) => {
                  const mm = m as Record<string, unknown>;
                  return { match: String(mm.match), returns: mm.returns };
              })
        : [];
    return {
        name: typeof obj.name === 'string' && obj.name ? sanitizeName(obj.name) : sanitizeName(fallbackName),
        language: typeof obj.language === 'string' ? obj.language : 'node',
        variableOverrides,
        boundaryMocks,
    };
}

/** Filesystem-safe mock set name. */
export function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'mock';
}
