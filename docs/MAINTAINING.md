# Maintaining this project

How to keep the project healthy and moving forward after open-sourcing.

## Release rhythm

- **Versioning:** semver in `package.json`. Bump on every published `.vsix`.
- **Changelog:** keep `CHANGELOG.md` (Keep-a-Changelog format); one entry per release.
- **Build → package → publish:**
  ```bash
  npm run build && npm test
  npx vsce package
  # then publish to the VS Marketplace and Open VSX
  ```
- **Two registries:** publish to both the **VS Marketplace** (`vsce publish`) and
  **Open VSX** (`ovsx publish`) so Cursor/Windsurf/VSCodium users get it too.

## Keeping it secure (supply chain)

- **`npm audit` on every PR** (wire into CI); no merge with a known high/critical.
- **Pin CI actions by SHA**, not by floating tag.
- **Dependabot / Renovate** for `package.json` + `webview-ui/package.json`.
- **Least dependencies:** the MCP server is intentionally zero-dependency — keep
  it that way; it's the most-exposed surface.
- **Secret scanning** enabled on the repo (GitHub secret scanning / gitleaks in CI).
- Re-run the SECURITY.md hardening checklist on any PR touching values/mutation.

## CI (recommended `.github/workflows/ci.yml`)

```yaml
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build
      - run: (cd webview-ui && npx oxlint src)
      - run: npm test
      - run: npm audit --audit-level=high
```

## Roadmap discipline

- The source of truth is [ROADMAP_BEHAVIORAL_PROOF.md](./ROADMAP_BEHAVIORAL_PROOF.md).
  Every item has ☐/◐/☑ and an acceptance criterion — flip the marker in the PR
  that lands it.
- **Open-core boundary (two repos).** This public repo (`tracegrab`, MIT) holds the
  extension, MCP server, CLI, and all local single-developer verification. The
  commercial org layer — shared registry, CI policy enforcement, history/trends,
  SSO/RBAC/audit, hosted dashboard, billing — lives in a **separate private repo**
  (`tracegrab-org`, BSL). The dependency arrow points one way only: the private repo
  depends on this one, never the reverse.
- **The tier map is injected, not stored here.** `src/entitlements.ts` ships only the
  *mechanism* (`Feature` type, `gate()`, `isEnabled()`, `resolveTier()`); the
  feature→tier map is injected at runtime via `License.featureTiers` (absent = every
  feature free). The real map and pricing live in `tracegrab-org`. Never commit a
  populated tier map or roadmap codenames to this repo — `npm run lint:boundaries`
  (part of `npm test` and CI) fails the build if you do.

## Triage & community

- **Labels:** `bug`, `security`, `feature`, `good-first-issue`, `needs-repro`,
  `language:<x>`.
- **`good-first-issue`:** adding a language memory-probe, a new redaction pattern,
  a new `inferState` finding — all self-contained.
- **Response SLA (aspirational):** security within 72h; other issues within a week.
- **Discussions** for design proposals before large PRs (esp. new MCP tools or
  changes to the FlowTrace schema, which is a compatibility surface).

## Compatibility surfaces (don't break lightly)

1. **MCP tool names + shapes** — agents depend on them; deprecate, don't rename.
2. **FlowTrace schema** — bump `schemaVersion` and keep a reader for the prior one.
3. **Scenario JSON** — documented in AGENT_AUTOMATION.md; additive changes only.

## Health signals to watch

- Test count trending up with features (never merge a feature with no test).
- oxlint stays at 0.
- `.vsix` size (currently ~170 KB) — a jump means something unwanted got bundled;
  check `.vscodeignore`.
- Time-to-first-diagnosis in `auto_debug` — the core UX metric.
