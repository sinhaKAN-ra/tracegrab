# Screenshots & visual proof

Reference images of the **API Flow Test Debugger** UI, used for documentation and
as visual proof that each build renders correctly.

## Files

| File | What it shows |
|------|---------------|
| `callmap.png` | The Call Map view rendered by the **real built webview bundle** (`webview-ui/dist`) driven by a scripted DAP pause stream. Shows: nested method boxes (Controller → Service → DB), inferred data-in/out on each hop, loop `×N` badge, mutation diffs (`var old→new`), `⚠ N+1` detection, per-method heap-delta badges, the live heap **sparkline** in the toolbar, per-call **selection** (checkbox + disabled/struck-through row + "Run selected (N)"), and the Mermaid export button. |
| `index.html` | The standalone demo page that produced the screenshot. **Open it in any browser / new tab** for a clean full-screen view of the Call Map outside the cramped editor panel. Self-contained (bundle + CSS inlined). Not shipped in the `.vsix`. |

## Regenerating

The harness inlines the built bundle plus a scripted pause stream (fan-out,
N+1 loop, mutation, error, rising/falling heap, one disabled call), so it
exercises the actual `App.tsx` reducer and `CallMap` render path — genuine
proof, not a static mock.

```bash
npm run build --prefix webview-ui   # ensure webview-ui/dist is fresh
node verify/make-demo.mjs           # writes docs/screenshots/index.html
node verify/make-demo.mjs --open    # also open the demo in your browser
node verify/make-demo.mjs --shot    # also screenshot via headless Chrome (uses --no-sandbox)

# or via npm scripts:
npm run demo         # build webview + open the demo page in a browser
npm run demo:shot    # build webview + write callmap.png
```

The screenshot step uses whichever of Google Chrome / Chromium / Edge is
installed (headless, no extra npm dependency). If none is present, the harness
prints the `file://` URL to open manually.
