/**
 * A dynamic ESM import that survives TypeScript's `module: "commonjs"` emit.
 *
 * Under `module: commonjs`, `tsc` rewrites every `import(x)` expression into a
 * `require(x)` call. `require()` cannot load an ES module (an `.mjs` file such as
 * `mcp/callmap.mjs`), so the call throws `Cannot find module` at runtime and every
 * caller (session.json projection, the call-map builder, the report/diff logic)
 * silently fails under its best-effort try/catch — breakpoints pause but the call
 * map never populates.
 *
 * Wrapping the import in a `Function` constructor hides it from the compiler, so
 * the emitted JS keeps a genuine native dynamic `import()`. Node then resolves the
 * `file://` ESM URL correctly. This is the single indirection every dynamic import
 * of `callmap.mjs` must go through.
 */
const nativeImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string
) => Promise<unknown>;

/** Dynamically import an ES module by URL/specifier without a CJS `require()` downlevel. */
export function esmImport<T = unknown>(specifier: string): Promise<T> {
    return nativeImport(specifier) as Promise<T>;
}
