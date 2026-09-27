# Ghost-reference font

`ghost-sans.ttf` / `ghost-sans-bold.ttf` are the fonts FontSeru's **sample
ghost mode** draws from — see `src/editor/ghostFont.ts`.

## Why this exists

Before this fix, the sample ghost was an SVG `<text>` element with
`fontFamily="'Inter', system-ui, sans-serif"`. That is a *request*, not a
guarantee: if the page's Google-Fonts `<link>` (see `index.html`) hasn't
finished loading yet, or the device blocks/misses it (slow tablet network,
offline PWA use, a corporate proxy, some Android/iOS browser quirks) the
browser silently falls back to whatever the OS ships as `system-ui` /
`sans-serif`. That fallback varies per device and often lacks correct
precomposed Vietnamese glyphs (hook-above / dot-below stacks like
ẩ ẫ ậ ặ ệ ổ ỗ ộ ...), which is exactly the "ghost glyph broken on some
devices" bug.

The fix: never ask the browser to render text at all for the ghost.
`ghostFont.ts` fetches this font file, parses it with `opentype.js`
(already a project dependency), and extracts the real vector outline for
the requested character. `GhostGlyph.tsx` draws that outline as a plain
SVG `<path>`. There is no `<text>`, no CSS `font-family`, no dependency on
whatever fonts happen to be installed on the viewer's PC or tablet — the
ghost looks identical everywhere the app runs, online or offline.

## Current font

Shipped here is **Bricolage Grotesque** (Regular + Bold), a SIL Open Font
License (OFL) typeface from Google Fonts, chosen as the placeholder
because:
- OFL license — free to embed and redistribute in the app.
- Full coverage of the Vietnamese precomposed set (hook-above, dot-below,
  and every tone-mark combination), verified against the 26-character
  Vietnamese stress set used while building this fix.
- Small (~90 KB per weight), so it does not meaningfully add to load time.

`ghost-sans-OFL.txt` is its license text — keep it alongside the font
files if you redistribute the app.

## Swapping in real Noto Sans (or any other font)

The loader in `src/editor/ghostFont.ts` doesn't care what family it's
given — it just needs a valid `.ttf`/`.otf` with the Unicode coverage you
want. To switch to actual Noto Sans:

1. Download `NotoSans-Regular.ttf` and `NotoSans-Bold.ttf` from Google
   Fonts / the Noto Fonts project (this sandbox has no internet access,
   which is the only reason it isn't already the file sitting here).
2. Replace `ghost-sans.ttf` and `ghost-sans-bold.ttf` in this folder with
   them (keep the same file names, or update `GHOST_FONT_URL` /
   `GHOST_FONT_BOLD_URL` in `ghostFont.ts` if you rename them).
3. Swap this README's license note and `ghost-sans-OFL.txt` for Noto's
   own OFL file.
4. If Noto Sans's cap-height proportions render visibly bigger/smaller
   than Bricolage Grotesque, nudge `GHOST_FONT_SIZE_SCALE` in
   `ghostFont.ts` (a single constant) — everything else keeps working
   unchanged.

No other code changes are required.
