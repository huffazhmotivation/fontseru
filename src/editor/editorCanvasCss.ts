/**
 * Scale-aware CSS for the vector editing surfaces.
 *
 * Every stroke width, dash length and font size here is divided by `sc`
 * (screen px per font unit) because the whole canvas is drawn in FONT
 * UNITS — without that division a 1px hairline would balloon as you zoom
 * in. It lives in its own module so BOTH editing surfaces (the
 * single-glyph GlyphCanvas and the multi-glyph edit canvas) render nodes,
 * handles, guides and ink with byte-identical styling, and so a tweak to
 * a node size or a guide colour can never apply to one surface and not
 * the other.
 */
export function editorCanvasCss(sc: number): string {
  return `
          .cursor-pen { cursor: crosshair; } .cursor-node { cursor: default; }
          .cursor-shape { cursor: crosshair; }
          .cursor-pencil { cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMGEwYTBhIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4gPHBhdGggZD0iTTE1LjYgMi42bDUuOCA1LjgtMTEuNCAxMS40LTcuMiAxLjQgMS40LTcuMnoiIGZpbGw9IiNmZmZmZmYiLz4gPHBhdGggZD0iTTEyLjkgNS4zbDUuOCA1LjgiIC8+IDxwYXRoIGQ9Ik0zLjkgMjAuMWwxLjEtNS42IiAvPiA8L2c+IDwvc3ZnPg==') 3 20, crosshair; }
          .cursor-hand { cursor: grab; } .cursor-zoom { cursor: zoom-in; }
          .cursor-brush { cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMGEwYTBhIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj4gPHBhdGggZD0iTTEyIDQuNGMzLjEgMCA1LjQgMi40IDUuNCA1LjYgMCAyLjEtMS4xIDMuNi0yLjggNC44TDEyIDIxLjZsLTIuNi02LjhDNy43IDEzLjYgNi42IDEyLjEgNi42IDEwYzAtMy4yIDIuMy01LjYgNS40LTUuNnoiIGZpbGw9IiNmZmZmZmYiLz4gPGNpcmNsZSBjeD0iMTIiIGN5PSI5LjYiIHI9IjIuNiIgZmlsbD0iIzBhMGEwYSIgc3Ryb2tlPSJub25lIi8+IDwvZz4gPC9zdmc+') 12 21, crosshair; } .cursor-select { cursor: default; }
          .cursor-nwse { cursor: nwse-resize; } .cursor-nesw { cursor: nesw-resize; }
          .cursor-ns { cursor: ns-resize; } .cursor-ew { cursor: ew-resize; } .cursor-rot { cursor: crosshair; }
          .cursor-skew-x { cursor: ew-resize; } .cursor-skew-y { cursor: ns-resize; }
          .grid-line { stroke: var(--grid); stroke-width: ${1 / sc}; }
          .grid-major { stroke: var(--grid-major); stroke-width: ${1 / sc}; }
          .guide-line { stroke: var(--guide); stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide { opacity: 0.72; transition: opacity 120ms ease; }
          .metric-guide .metric-guide-line { stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide.metric-ascender .metric-guide-line { stroke: var(--m-ascender); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-cap .metric-guide-line { stroke: var(--m-cap); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-xheight .metric-guide-line { stroke: var(--m-xheight); stroke-width: ${1.3 / sc}; stroke-dasharray: ${2 / sc} ${4 / sc}; }
          .metric-guide.metric-baseline .metric-guide-line { stroke: var(--accent); stroke-width: ${1.5 / sc}; }
          .metric-guide.metric-descender .metric-guide-line { stroke: var(--m-descender); }
          /* Each metric now carries its own hue (see --m-* tokens above), so
             every guide is legible at a glance instead of reading as "one
             faint gray line" the way a shared --guide/--guide-2 did. */
          .metric-guide { opacity: 0.85; }
          .metric-guide:hover, .metric-guide.active { opacity: 1; }
          .metric-guide:hover .metric-guide-line, .metric-guide.active .metric-guide-line { stroke-width: ${2 / sc}; }
          .metric-guide-hit { stroke: transparent; stroke-width: ${12 / sc}; cursor: ns-resize; pointer-events: stroke; }
          .metric-guide.locked { opacity: 0.5; }
          .metric-guide.locked .metric-guide-hit { pointer-events: none; cursor: default; }
          .metric-guide-value-bg { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.96; }
          .metric-guide-value { fill: var(--text); font-size: ${11 / sc}px; font-family: var(--mono); font-weight: 600; }
          .lsb-line, .rsb-line { stroke: var(--sb); stroke-width: ${1.1 / sc}; opacity: 0.85; }
          .glyph-metric-guide-line { stroke: var(--sb); stroke-width: ${1.1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; opacity: 0.85; }
          .glyph-metric-guide-line.advance { stroke: var(--accent); stroke-width: ${1.4 / sc}; }
          .glyph-metric-handle { fill: var(--canvas); stroke: var(--sb); stroke-width: ${1.25 / sc}; cursor: ew-resize; }
          .glyph-metric-handle.locked { opacity: 0.55; pointer-events: none; cursor: default; }
          .glyph-metric-handle.advance { stroke: var(--accent); }
          .glyph-metric-handle.active { fill: var(--sb-soft); stroke: var(--sb); stroke-width: ${1.7 / sc}; }
          .glyph-metric-handle.advance.active { fill: var(--accent-soft); stroke: var(--accent); }
          .glyph-metric-handle.auto { fill: var(--auto-soft); stroke: var(--auto-2); }
          .glyph-metric-label { fill: var(--text); font-size: ${10.5 / sc}px; font-family: var(--mono); font-weight: 600; pointer-events: none; }
          .glyph-metric-auto-dot { fill: var(--auto-2); }
          .guide-label { fill: var(--text-dim); font-size: ${11 / sc}px; font-family: var(--mono); }
          /* Origin (x=0): the left boundary every LSB value is measured
             from. Drawn as a solid, brighter line (never dashed, never
             draggable) with its own "0" flag so it can never be mistaken
             for the LSB guide sitting right next to it. */
          .origin-line { stroke: var(--origin); stroke-width: ${1.4 / sc}; opacity: 0.9; }
          .origin-tick { stroke: var(--origin); stroke-width: ${1.4 / sc}; }
          .origin-flag-bg { fill: var(--origin-soft); stroke: var(--origin); stroke-width: ${1 / sc}; }
          .origin-flag-label { fill: var(--origin); font-size: ${10 / sc}px; font-family: var(--mono); font-weight: 700; pointer-events: none; }
          .obj-fill { fill: var(--ink); fill-rule: nonzero; stroke: none; }
          /* FontLab/Glyphs-style "semi-fill": in Node mode the shape being
             actively edited renders at reduced opacity by default — their
             True Fill toggle is what gives the solid/opaque version — so
             nodes and handles read clearly against it instead of vanishing
             into a solid dark silhouette. */
          .obj-fill.semi-fill { opacity: 0.62; }
          .obj-fill-overlap { fill: var(--overlap-canvas); opacity: 0.88; }
          .obj-fill-preview-outline { fill: none; stroke: var(--ink); stroke-width: ${1.25 / sc}; opacity: 0.85; }
          .obj-stroke { fill: none; stroke: var(--ink); }
          .obj-stroke-overlap { stroke: var(--overlap-canvas); opacity: 0.88; }
          .obj-sel-outline { fill: none; stroke: var(--accent); stroke-width: ${1.5 / sc}; opacity: 0.9; }
          .brush-preview { fill: none; stroke: var(--accent); opacity: 0.85; }
          .pencil-preview { fill: none; stroke: var(--accent); opacity: 0.9; }
          .pencil-preview-fill { fill: var(--accent); opacity: 0.16; }
          .rubber-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${4 / sc} ${3 / sc}; }
          .handle-line { stroke: var(--handle-line); stroke-width: ${1.5 / sc}; }
          .handle-line.dim { opacity: 0.4; }
          .handle-dot { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.3 / sc}; opacity: 0.85; }
          .handle-dot.active { opacity: 1; }
          .handle-dot.dim { opacity: 0.3; }
          .handle-snap-line { stroke: var(--accent); stroke-width: ${1 / sc}; stroke-dasharray: ${4 / sc} ${4 / sc}; opacity: 0.75; }
          .handle-snap-dot { fill: var(--accent); opacity: 0.9; }
          .node-shape { stroke-width: ${1.3 / sc}; }
          .node-shape.corner { fill: var(--node-corner); stroke: var(--canvas); }
          .node-shape.smooth { fill: var(--node-smooth); stroke: var(--canvas); }
          .node-shape.symmetric { fill: var(--node-symmetric); stroke: var(--canvas); }
          .node-shape.selected { fill: var(--accent); stroke: var(--canvas); }
          .node-shape.guide { opacity: 0.6; }
          .skeleton-guide-path { fill: none; stroke: var(--accent); stroke-width: ${1 / sc}; stroke-dasharray: ${3 / sc} ${3 / sc}; opacity: 0.4; }
          .skeleton-guide-path.active { stroke: #000; stroke-dasharray: none; stroke-width: ${1.25 / sc}; opacity: 0.85; }
          .close-ring { fill: none; stroke: var(--accent); stroke-width: ${1.8 / sc}; }
          /* Ruler-dragged guides: high-contrast magenta, thicker, and a
             long-dash/short-gap pattern (not the 5:5 or 6:4 rhythm used by
             metric guides) so they read as clearly distinct at a glance
             against the existing metric guides (purple/blue/green/orange). */
          .ruler-guide-line { stroke: var(--ruler-guide); stroke-width: ${1.8 / sc}; stroke-dasharray: ${11 / sc} ${3 / sc}; opacity: 1; }
          .ruler-guide-endcap { fill: var(--ruler-guide); opacity: 1; }
          .marquee-rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.5; }
          .sel-box { fill: none; stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${5 / sc} ${4 / sc}; }
          .sel-handle { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.5 / sc}; }
          .sel-skew-handle { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1.25 / sc}; }
          .sel-skew-guide { stroke: color-mix(in srgb, var(--accent) 55%, transparent); stroke-width: ${1 / sc}; stroke-dasharray: ${2 / sc} ${3 / sc}; }
          .sel-rot-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; }
          .corner-radius-handle { fill: var(--accent); stroke: var(--panel-bg, #1e1e1e); stroke-width: ${1.4 / sc}; opacity: 0.95; }
          .corner-radius-handle.rounded { fill: var(--accent); opacity: 1; }
        `;
}
