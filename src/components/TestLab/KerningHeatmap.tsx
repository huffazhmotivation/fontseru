import { useMemo, useState } from "react";
import { kerningKey, type KerningPairs } from "@/types/kerning";
import { hasOutline, type GlyphMap } from "@/types/glyph";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");

type CharSet = "upper" | "lower" | "mixed";

export interface KerningPairRef {
  left: string;
  right: string;
}

interface KerningHeatmapProps {
  glyphs: GlyphMap;
  kerningPairs: KerningPairs;
  activePair: KerningPairRef | null;
  onSelectPair: (pair: KerningPairRef) => void;
  bg: "dark" | "light";
}

function charsForSet(set: CharSet, glyphs: GlyphMap): string[] {
  const pool = set === "upper" ? UPPER : set === "lower" ? LOWER : [...UPPER, ...LOWER];
  return pool.filter((ch) => glyphs[ch] && hasOutline(glyphs[ch]));
}

/**
 * Grid overview of every kerning pair in the current character set, colored
 * by magnitude so pairs that stand out from the rest of the font are easy
 * to spot at a glance instead of stepping through pairs one at a time in
 * the specimen stage. Clicking a cell hands the pair to the same precision
 * editor the Single/Family tests use, so it stays a jumping-off point for
 * fine adjustment rather than a separate read-only view.
 */
export function KerningHeatmap({ glyphs, kerningPairs, activePair, onSelectPair, bg }: KerningHeatmapProps) {
  const [charSet, setCharSet] = useState<CharSet>("upper");
  const chars = useMemo(() => charsForSet(charSet, glyphs), [charSet, glyphs]);

  const values = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of chars) {
      for (const r of chars) {
        map.set(kerningKey(l, r), kerningPairs[kerningKey(l, r)] ?? 0);
      }
    }
    return map;
  }, [chars, kerningPairs]);

  const maxAbs = useMemo(() => {
    let m = 1;
    for (const v of values.values()) m = Math.max(m, Math.abs(v));
    return m;
  }, [values]);

  const colorFor = (v: number): string => {
    if (v === 0) return "transparent";
    const t = Math.min(1, Math.abs(v) / maxAbs);
    // Negative (tighter) reads warm, positive (looser) reads cool — the
    // same convention as the live-drag ruler elsewhere in this panel.
    return v < 0 ? `rgba(239, 68, 68, ${0.12 + t * 0.68})` : `rgba(20, 184, 166, ${0.12 + t * 0.68})`;
  };

  if (chars.length === 0) {
    return (
      <div className={`fm-kern-heatmap-empty ${bg}`} data-testid="kern-heatmap-empty">
        Draw some {charSet === "mixed" ? "uppercase or lowercase" : charSet} glyphs first to see their kerning heatmap.
        <div className="fm-tab-select" data-testid="kern-heatmap-charset">
          <button className={charSet === "upper" ? "active" : ""} onClick={() => setCharSet("upper")}>Uppercase</button>
          <button className={charSet === "lower" ? "active" : ""} onClick={() => setCharSet("lower")}>Lowercase</button>
          <button className={charSet === "mixed" ? "active" : ""} onClick={() => setCharSet("mixed")}>Mixed</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`fm-kern-heatmap ${bg}`} data-testid="kern-heatmap">
      <div className="fm-kern-heatmap-controls">
        <div className="fm-tab-select" data-testid="kern-heatmap-charset">
          <button className={charSet === "upper" ? "active" : ""} onClick={() => setCharSet("upper")}>Uppercase</button>
          <button className={charSet === "lower" ? "active" : ""} onClick={() => setCharSet("lower")}>Lowercase</button>
          <button className={charSet === "mixed" ? "active" : ""} onClick={() => setCharSet("mixed")}>Mixed</button>
        </div>
        <div className="fm-kern-heatmap-legend">
          <span className="fm-kern-legend-swatch negative" />
          <span>Tighter</span>
          <span className="fm-kern-legend-swatch positive" />
          <span>Looser</span>
        </div>
      </div>

      <div className="fm-kern-heatmap-scroll">
        <table className="fm-kern-heatmap-table">
          <thead>
            <tr>
              <th className="fm-kern-heatmap-corner" />
              {chars.map((r) => (
                <th key={r} className="fm-kern-heatmap-colhead">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chars.map((l) => (
              <tr key={l}>
                <th className="fm-kern-heatmap-rowhead">{l}</th>
                {chars.map((r) => {
                  const key = kerningKey(l, r);
                  const v = values.get(key) ?? 0;
                  const isActive = activePair?.left === l && activePair?.right === r;
                  return (
                    <td
                      key={r}
                      className={`fm-kern-heatmap-cell ${isActive ? "active" : ""}`}
                      style={{ backgroundColor: colorFor(v) }}
                      title={`${l}${r}: ${v}`}
                      onClick={() => onSelectPair({ left: l, right: r })}
                      data-testid={`kern-heatmap-cell-${l}${r}`}
                    >
                      {v !== 0 ? v : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
