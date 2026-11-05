import {
  nextFeatureRuleId,
  isValidFeatureTag,
  type AlternateRule,
  type FeatureBuilderConfig,
  type LigatureRule,
  type SubstitutionRule,
  type SwashRule,
} from "@/types/opentypeFeatures";

/**
 * Feature Builder config <-> OpenType feature code (.fea, a practical subset).
 *
 * Glyph tokens: a glyph whose key is a valid name (A-Z a-z 0-9 _ . , not
 * starting with a digit) is written as-is ("a", "a.alt1", "f_f"); any other
 * key (digits, punctuation, accented letters …) is written as uniXXXX, which
 * is also how the exported font names such glyphs.
 *
 * Supported statements inside `feature tag { … } tag;`
 *   sub a by a.sc;                 single substitution  → smcp, onum, ss01 …
 *   sub f f by f_f;                ligature             → liga, dlig, clig, rlig
 *   sub a from [a.alt1 a.alt2];    alternates           → salt
 *   sub b' c by b.alt;             contextual (calt) — one marked (') glyph,
 *   sub a b' by b.alt;             optionally one glyph before and/or after
 * Comments start with #.
 */

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function glyphToken(key: string): string {
  if (VALID_NAME.test(key)) return key;
  const cps = [...key].map((c) => c.codePointAt(0)!);
  if (cps.length === 1) return `uni${cps[0].toString(16).toUpperCase().padStart(4, "0")}`;
  return key.replace(/[^A-Za-z0-9_.]/g, "_");
}

export function configToFea(config: FeatureBuilderConfig): string {
  const byTag = new Map<string, string[]>();
  const add = (tag: string, line: string) => byTag.set(tag, [...(byTag.get(tag) ?? []), `  ${line}`]);
  const t = glyphToken;
  for (const r of config.ligatures) add(r.feature || "liga", `sub ${r.components.map(t).join(" ")} by ${t(r.target)};`);
  for (const r of config.alternates) add("salt", `sub ${t(r.base)} from [${r.alternates.map(t).join(" ")}];`);
  for (const r of config.swashes) add("swsh", `sub ${t(r.base)} by ${t(r.swash)};`);
  for (const r of config.substitutions ?? []) {
    const left = `${r.before ? `${t(r.before)} ` : ""}${t(r.from)}${r.before || r.after ? "'" : ""}${r.after ? ` ${t(r.after)}` : ""}`;
    add(r.feature, `sub ${left} by ${t(r.to)};`);
  }
  const tags = [...byTag.keys()].sort();
  if (!tags.length) return "# Belum ada aturan fitur.\n# Contoh:\n# feature smcp {\n#   sub a by a.sc;\n# } smcp;\n";
  return tags.map((tag) => `feature ${tag} {\n${byTag.get(tag)!.join("\n")}\n} ${tag};`).join("\n\n") + "\n";
}

export interface FeaParseResult {
  config: FeatureBuilderConfig | null;
  errors: string[];
}

/** Parses the supported subset. Returns config=null when there are errors (nothing is half-applied). */
export function parseFea(text: string, hasGlyph: (key: string) => boolean): FeaParseResult {
  const errors: string[] = [];
  const config: FeatureBuilderConfig = { ligatures: [], alternates: [], swashes: [], substitutions: [] };

  const resolve = (token: string, line: number): string | null => {
    if (hasGlyph(token)) return token;
    const m = /^uni([0-9A-Fa-f]{4,6})$/.exec(token);
    if (m) {
      const ch = String.fromCodePoint(parseInt(m[1], 16));
      if (hasGlyph(ch)) return ch;
    }
    errors.push(`Baris ${line}: glyph "${token}" tidak ada di font.`);
    return null;
  };

  const src = text.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  let current: string | null = null;
  let braceStart = 0;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;

    const open = /^feature\s+([A-Za-z0-9]{4})\s*\{$/.exec(line);
    if (open) {
      if (current) errors.push(`Baris ${lineNo}: "feature" baru dibuka sebelum "${current}" ditutup.`);
      current = open[1];
      braceStart = lineNo;
      return;
    }
    const close = /^\}\s*([A-Za-z0-9]{4})\s*;$/.exec(line);
    if (close) {
      if (!current) errors.push(`Baris ${lineNo}: penutup "}" tanpa "feature" pembuka.`);
      else if (close[1] !== current) errors.push(`Baris ${lineNo}: penutup "${close[1]}" tidak cocok dengan "feature ${current}".`);
      current = null;
      return;
    }
    if (!current) {
      errors.push(`Baris ${lineNo}: pernyataan di luar blok feature tidak didukung: "${line}".`);
      return;
    }
    if (!isValidFeatureTag(current)) { errors.push(`Baris ${lineNo}: tag fitur "${current}" tidak valid.`); return; }

    // sub a from [a.alt1 a.alt2];
    const from = /^sub\s+(\S+)\s+from\s+\[([^\]]+)\]\s*;$/.exec(line);
    if (from) {
      if (current !== "salt") { errors.push(`Baris ${lineNo}: "from" (alternate) hanya didukung di feature salt.`); return; }
      const base = resolve(from[1], lineNo);
      const alts = from[2].trim().split(/\s+/).map((tk) => resolve(tk, lineNo));
      if (base && alts.every(Boolean)) {
        const existing = config.alternates.find((r) => r.base === base);
        if (existing) existing.alternates.push(...(alts as string[]));
        else config.alternates.push({ id: nextFeatureRuleId("alt"), base, alternates: alts as string[] } as AlternateRule);
      }
      return;
    }

    const by = /^sub\s+(.+?)\s+by\s+(\S+)\s*;$/.exec(line);
    if (!by) { errors.push(`Baris ${lineNo}: pernyataan tidak dikenali: "${line}".`); return; }
    const leftTokens = by[1].trim().split(/\s+/);
    const marked = leftTokens.filter((tk) => tk.endsWith("'"));
    const to = resolve(by[2], lineNo);

    if (marked.length > 1) { errors.push(`Baris ${lineNo}: hanya satu glyph bertanda ' yang didukung.`); return; }
    if (marked.length === 1) {
      const idx = leftTokens.findIndex((tk) => tk.endsWith("'"));
      if (leftTokens.length > 3 || idx > 1 || (leftTokens.length - idx - 1) > 1) {
        errors.push(`Baris ${lineNo}: konteks hanya mendukung maksimal satu glyph sebelum dan satu sesudah.`);
        return;
      }
      const fromKey = resolve(marked[0].slice(0, -1), lineNo);
      const before = idx === 1 ? resolve(leftTokens[0], lineNo) : null;
      const after = leftTokens.length - idx - 1 === 1 ? resolve(leftTokens[idx + 1], lineNo) : null;
      if (fromKey && to && (idx !== 1 || before) && (leftTokens.length - idx - 1 !== 1 || after)) {
        const rule: SubstitutionRule = { id: nextFeatureRuleId("sub"), feature: current, from: fromKey, to };
        if (before) rule.before = before;
        if (after) rule.after = after;
        config.substitutions!.push(rule);
      }
      return;
    }

    const lefts = leftTokens.map((tk) => resolve(tk, lineNo));
    if (!to || !lefts.every(Boolean)) return;
    const keys = lefts as string[];
    if (keys.length >= 2) {
      const rule: LigatureRule = { id: nextFeatureRuleId("liga"), components: keys, target: to };
      if (current !== "liga") rule.feature = current;
      config.ligatures.push(rule);
    } else if (current === "swsh") {
      config.swashes.push({ id: nextFeatureRuleId("swsh"), base: keys[0], swash: to } as SwashRule);
    } else {
      config.substitutions!.push({ id: nextFeatureRuleId("sub"), feature: current, from: keys[0], to });
    }
  });

  if (current) errors.push(`Blok "feature ${current}" (mulai baris ${braceStart}) belum ditutup.`);
  return errors.length ? { config: null, errors } : { config, errors: [] };
}
