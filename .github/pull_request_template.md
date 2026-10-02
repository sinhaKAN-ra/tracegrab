# Summary

<!-- What does this change do, in plain terms? -->

## Checklist

- [ ] One logical change; diff is reviewable.
- [ ] `npm run compile` — 0 errors.
- [ ] `npm run build` — webview + host build cleanly.
- [ ] `cd webview-ui && npx oxlint src` — 0 warnings, 0 errors.
- [ ] `npm test` — all suites pass (includes `lint:boundaries`).
- [ ] No secrets, `.vsix`, or `.flow-debugger/` runtime output committed.
- [ ] If this touches captured runtime values, they go through `src/redact.ts`.
- [ ] If this adds a gateable capability, it's a named `Feature` in
      `src/entitlements.ts` (no inline flag strings; no tier assigned in source).
