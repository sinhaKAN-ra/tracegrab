# Tracegrab — Brand Assets

Runtime verification for AI coding agents. The mark is a **call-flow verified**:
three nodes + connecting line = the Call Map (controller → service → DB); the
green checkmark cutting through = the proof/verdict.

## Files

| File | Use |
|------|-----|
| `icon.svg` | Primary full-color app / repo / Marketplace icon (96×96 master) |
| `favicon.svg` | Simplified mark for small sizes (16–32px); larger nodes, bolder check |
| `icon-mono.svg` | Single-color mark via `currentColor` — CLI banners, stamps, embossing |
| `wordmark-dark.svg` | Icon + "Tracegrab" for dark backgrounds (site header, slides) |
| `wordmark-light.svg` | Icon + "Tracegrab" for light backgrounds |
| `og-card.svg` | 1200×630 social / Open Graph link-preview card (HN, X) |

## Colors

| Token | Hex | Use |
|-------|-----|-----|
| Trust blue | `#1b6fe0` | Icon background, brand primary |
| Node light | `#bfe0ff` | Call-flow nodes & connectors |
| Proof green | `#2fd47a` | Checkmark / verdict accent |
| Ink | `#15223a` | Wordmark text on light |
| OG gradient | `#0d1b2e → #13294a` | Social card background |

Corner radius: 20/84 of the icon width (≈ 24%).

## Rasterizing to PNG / ICO

The masters are SVG. Generate the raster sizes the Marketplace and browsers need:

```bash
cd media/brand

# needs: npm i -g sharp-cli   (or use rsvg-convert / Inkscape)

# VS Code Marketplace icon (128 + 256 retina)
sharp -i icon.svg -o icon-128.png resize 128 128
sharp -i icon.svg -o icon-256.png resize 256 256

# Repo / social PNG
sharp -i icon.svg -o icon-512.png resize 512 512

# Favicon PNGs
sharp -i favicon.svg -o favicon-16.png resize 16 16
sharp -i favicon.svg -o favicon-32.png resize 32 32

# OG card PNG (link previews require a raster)
sharp -i og-card.svg -o og-card.png

# .ico (needs ImageMagick): bundle 16+32+48
magick favicon-16.png favicon-32.png icon-128.png favicon.ico
```

## Notes

- `icon-mono.svg` inherits color via `currentColor`; set `color:` on its container or pass `fill`/`stroke` when inlining.
- The VS Code extension icon is `media/brand/icon-128.png` (wired in `package.json`),
  rasterized from `icon.svg` via `sharp`. If you edit `icon.svg`, regenerate the PNGs
  with the commands above (VS Code requires a **PNG**, 128×128 — it does not accept SVG).
- Name/clearance note: "Tracegrab" cleared the availability gauntlet on 2026-10-02 — npm, PyPI, VS Code Marketplace, and `tracegrab.com`/`.dev`/`.io` all free, no exact-name competitor. Register the domains and the npm/Marketplace publisher IDs before any public signal goes out. (The tool name is Tracegrab; the company/org brand is still to be decided.)
