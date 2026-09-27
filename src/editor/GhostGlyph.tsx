import { useEffect, useState } from "react";
import * as opentype from "opentype.js";

/**
 * GHOST REFERENCE FONT — embedded, vector, device-independent
 * =============================================================
 * Fix for: sample-mode ghost glyphs rendering as the *wrong* character
 * shape (or missing Vietnamese diacritics entirely) on some PCs/tablets.
 *
 * ROOT CAUSE (what this file replaces)
 * -------------------------------------
 * The old ghost drew an SVG `<text fontFamily="'Inter', system-ui, sans-serif">`.
 * That's a request to the *browser's* text shaper, which:
 *   1. depends on index.html's Google-Fonts <link> having already loaded
 *      Inter by the time the SVG paints (racy on slow/offline connections),
 *   2. falls back to `system-ui` — a different font on every OS/device —
 *      the instant Inter isn't available, and
 *   3. inherits whatever that fallback font does or doesn't support, which
 *      is exactly how Vietnamese hook-above/dot-below stacks (ẩ ậ ặ ệ ổ ...)
 *      go missing or get substituted on some tablets.
 *
 * FIX
 * ---
 * Never ask the browser to shape text for the ghost. Fetch one embedded,
 * open-license font file ourselves, parse it with opentype.js (already a
 * project dependency, used elsewhere for font export), and pull the real
 * vector outline for the requested character directly out of its glyf
 * table. `GhostGlyph.tsx` then draws that outline as a plain SVG <path> —
 * identical bytes in, identical pixels out, on every device, online or
 * offline, regardless of what's installed on the viewer's machine.
 *
 * See public/fonts/README.md for what font ships here and how to swap it.
 */

const GHOST_FONT_URL = "/fonts/ghost-sans.ttf";
const GHOST_FONT_BOLD_URL = "/fonts/ghost-sans-bold.ttf";

/** Visual size multiplier from FontSeru's own `capHeight` metric to the
 * font-unit `fontSize` opentype.js expects.
