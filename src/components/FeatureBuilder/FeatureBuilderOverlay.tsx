import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Eye, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { hasOutline, type GlyphMap } from "@/types/glyph";
import { getOrderedChars } from "@/glyph/defaultGlyphs";
import { GlyphThumbnail } from "@/components/GlyphThumbnail";
import {
  suggestLigatureName,
  suggestAlternateName,
  suggestSwashName,
} from "@/types/opentypeFeatures";

/** Label shown for a glyph key in pickers/lists — mirrors the "SP" special
 * case already used elsewhere (e.g. Family Auto Generate) for the space
 * glyph, and otherwise just shows the key as-is (works fine for both plain
 * chars like "a" and Feature-Builder-created keys like "a.alt1"). */
function glyphLabel(key: string): string {
  return key === " " ? "SP" : key;
}

function GlyphPicker({
  value,
  onChange,
  chars,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  chars: string[];
  placeholder: string;
}) {
  return (
    <select
      className="fm-feature-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {chars.map((ch) => (
        <option key={ch} value={ch}>
          {glyphLabel(ch)}
        </option>
      ))}
    </select>
  );
}

function RuleGlyph({ char, glyphs }: { char: string; glyphs: GlyphMap }) {
  const glyph = glyphs[char];
  return (
    <div className="fm-feature-thumb" title={char}>
      {glyph && hasOutline(glyph) ? <GlyphThumbnail glyph={glyph} /> : <span className="fm-feature-thumb-empty">{glyphLabel(char)}</span>}
    </div>
  );
}

export function FeatureBuilderOverlay() {
  const open = useAppStore((s) => s.featureBuilderOpen);
  const close = useAppStore((s) => s.closeFeatureBuilder);
  const glyphs = useAppStore((s) => s.glyphsByStyle.regular);
  const setActiveChar = useAppStore((s) => s.setActiveChar);

  const config = useAppStore((s) => s.featureConfig);
  const createFeatureGlyph = useAppStore((s) => s.createFeatureGlyph);
  const addLigatureRule = useAppStore((s) => s.addLigatureRule);
  const removeLigatureRule = useAppStore((s) => s.removeLigatureRule);
  const addAlternateOption = useAppStore((s) => s.addAlternateOption);
  const removeAlternateOption = useAppStore((s) => s.removeAlternateOption);
  const removeAlternateRule = useAppStore((s) => s.removeAlternateRule);
  const setSwashRule = useAppStore((s) => s.setSwashRule);
  const removeSwashRule = useAppStore((s) => s.removeSwashRule);

  const chars = useMemo(() => getOrderedChars(glyphs), [glyphs]);

  // --- Ligature form state ---
  const [ligA, setLigA] = useState("");
  const [ligB, setLigB] = useState("");
  const [ligTarget, setLigTarget] = useState("");
  const [ligPreview, setLigPreview] = useState(false);
  const ligComponents = [ligA, ligB].filter(Boolean);
  const ligTargetName = ligTarget || (ligComponents.length === 2 ? suggestLigatureName(ligComponents) : "");
  const ligTargetExists = Boolean(ligTargetName && glyphs[ligTargetName]);

  // --- Alternate form state ---
  const [altBase, setAltBase] = useState("");
  const [altNew, setAltNew] = useState("");
  const [altPreview, setAltPreview] = useState(false);
  const existingAltRule = config.alternates.find((r) => r.base === altBase);
  const altNewName = altNew || (altBase ? suggestAlternateName(altBase, (existingAltRule?.alternates.length ?? 0) + 1) : "");
  const altNewExists = Boolean(altNewName && glyphs[altNewName]);

  // --- Swash form state ---
  const [swashBase, setSwashBase] = useState("");
  const [swashTarget, setSwashTarget] = useState("");
  const [swashPreview, setSwashPreview] = useState(false);
  const swashTargetName = swashTarget || (swashBase ? suggestSwashName(swashBase) : "");
  const swashTargetExists = Boolean(swashTargetName && glyphs[swashTargetName]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const goEdit = (key: string) => {
    if (!glyphs[key]) return;
    setActiveChar(key);
    close();
  };

  return (
    <div
      className="fm-lab-backdrop fm-feature-backdrop"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) close();
      }}
      data-testid="feature-builder-overlay"
    >
      <div className="fm-lab-modal fm-feature-modal" role="dialog" aria-modal="true" aria-labelledby="feature-builder-title">
        <div className="fm-lab-head">
          <div className="fm-lab-title" id="feature-builder-title">
            <Wand2 size={14} />
            <span>Feature Builder</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="feature-builder-close">
            <X size={16} />
          </button>
        </div>

        <div className="fm-lab-body fm-feature-body">
          <p className="fm-feature-intro">
            Buat aturan Ligature, Alternate, dan Swash dari glyph yang sudah ada. Saat export TTF/OTF, FontSeru otomatis
            menghasilkan OpenType feature (liga, salt, swsh) — tidak perlu menulis kode FEA.
          </p>

          {/* Ligature */}
          <section className="fm-feature-section">
            <div className="fm-section-title">Ligature</div>
            <div className="fm-feature-form">
              <GlyphPicker value={ligA} onChange={setLigA} chars={chars} placeholder="Glyph 1 (mis. r)" />
              <span className="fm-feature-plus">+</span>
              <GlyphPicker value={ligB} onChange={setLigB} chars={chars} placeholder="Glyph 2 (mis. e)" />
              <span className="fm-feature-arrow">→</span>
              <input
                className="fm-feature-input"
                value={ligTargetName}
                onChange={(e) => setLigTarget(e.target.value)}
                placeholder="Nama glyph hasil (mis. re)"
                spellCheck={false}
              />
              {!ligTargetExists && ligTargetName && ligComponents.length === 2 && (
                <button
                  className="fm-feature-btn"
                  onClick={() => createFeatureGlyph(ligTargetName, "feature", ligComponents[0])}
                  title="Glyph ini belum ada — buat glyph kosong untuk digambar"
                >
                  <Sparkles size={13} /> Create Glyph
                </button>
              )}
              {ligTargetExists && (
                <button className="fm-feature-btn fm-feature-btn-ghost" onClick={() => goEdit(ligTargetName)}>
                  Edit Glyph
                </button>
              )}
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                disabled={ligComponents.length !== 2}
                onClick={() => setLigPreview((v) => !v)}
              >
                <Eye size={13} /> Preview
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-primary"
                disabled={ligComponents.length !== 2 || !ligTargetName || !ligTargetExists}
                onClick={() => {
                  addLigatureRule(ligComponents, ligTargetName);
                  setLigA(""); setLigB(""); setLigTarget(""); setLigPreview(false);
                }}
              >
                Add
              </button>
            </div>
            {ligPreview && ligComponents.length === 2 && (
              <div className="fm-feature-preview-row">
                {ligComponents.map((c) => <RuleGlyph key={c} char={c} glyphs={glyphs} />)}
                <span className="fm-feature-arrow">→</span>
                <RuleGlyph char={ligTargetName || "?"} glyphs={glyphs} />
              </div>
            )}
            <div className="fm-feature-rule-list">
              {config.ligatures.length === 0 && <div className="fm-feature-empty">Belum ada ligature.</div>}
              {config.ligatures.map((rule) => (
                <div className="fm-feature-rule-row" key={rule.id}>
                  {rule.components.map((c) => <RuleGlyph key={c} char={c} glyphs={glyphs} />)}
                  <span className="fm-feature-arrow">→</span>
                  <RuleGlyph char={rule.target} glyphs={glyphs} />
                  <span className="fm-feature-rule-label">{rule.components.join(" + ")} → {rule.target}</span>
                  <div className="fm-spacer" />
                  <button className="fm-feature-remove" onClick={() => removeLigatureRule(rule.id)} title="Remove">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Alternate */}
          <section className="fm-feature-section">
            <div className="fm-section-title">Alternate</div>
            <div className="fm-feature-form">
              <GlyphPicker value={altBase} onChange={setAltBase} chars={chars} placeholder="Base glyph (mis. a)" />
              <span className="fm-feature-arrow">→</span>
              <input
                className="fm-feature-input"
                value={altNewName}
                onChange={(e) => setAltNew(e.target.value)}
                placeholder="Nama alternate (mis. a.alt1)"
                spellCheck={false}
                disabled={!altBase}
              />
              {altBase && !altNewExists && altNewName && (
                <button
                  className="fm-feature-btn"
                  onClick={() => createFeatureGlyph(altNewName, "feature", altBase)}
                  title="Glyph ini belum ada — buat glyph kosong untuk digambar"
                >
                  <Sparkles size={13} /> Create Glyph
                </button>
              )}
              {altNewExists && (
                <button className="fm-feature-btn fm-feature-btn-ghost" onClick={() => goEdit(altNewName)}>
                  Edit Glyph
                </button>
              )}
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                disabled={!altBase || !altNewName}
                onClick={() => setAltPreview((v) => !v)}
              >
                <Eye size={13} /> Preview
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-primary"
                disabled={!altBase || !altNewName || !altNewExists}
                onClick={() => {
                  addAlternateOption(altBase, altNewName);
                  setAltNew(""); setAltPreview(false);
                }}
              >
                Add
              </button>
            </div>
            {altPreview && altBase && altNewName && (
              <div className="fm-feature-preview-row">
                <RuleGlyph char={altBase} glyphs={glyphs} />
                <span className="fm-feature-arrow">→</span>
                <RuleGlyph char={altNewName} glyphs={glyphs} />
              </div>
            )}
            <div className="fm-feature-rule-list">
              {config.alternates.length === 0 && <div className="fm-feature-empty">Belum ada alternate.</div>}
              {config.alternates.map((rule) => (
                <div className="fm-feature-rule-row fm-feature-rule-row-wrap" key={rule.id}>
                  <RuleGlyph char={rule.base} glyphs={glyphs} />
                  <span className="fm-feature-arrow">→</span>
                  {rule.alternates.map((alt) => (
                    <div key={alt} className="fm-feature-alt-chip">
                      <RuleGlyph char={alt} glyphs={glyphs} />
                      <button className="fm-feature-remove" onClick={() => removeAlternateOption(rule.id, alt)} title="Remove this alternate">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                  <span className="fm-feature-rule-label">{rule.base} → {rule.alternates.join(", ")}</span>
                  <div className="fm-spacer" />
                  <button className="fm-feature-remove" onClick={() => removeAlternateRule(rule.id)} title="Remove whole rule">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Swash */}
          <section className="fm-feature-section">
            <div className="fm-section-title">Swash</div>
            <div className="fm-feature-form">
              <GlyphPicker value={swashBase} onChange={setSwashBase} chars={chars} placeholder="Base glyph (mis. A)" />
              <span className="fm-feature-arrow">→</span>
              <input
                className="fm-feature-input"
                value={swashTargetName}
                onChange={(e) => setSwashTarget(e.target.value)}
                placeholder="Nama swash (mis. A.swash)"
                spellCheck={false}
                disabled={!swashBase}
              />
              {swashBase && !swashTargetExists && swashTargetName && (
                <button
                  className="fm-feature-btn"
                  onClick={() => createFeatureGlyph(swashTargetName, "feature", swashBase)}
                  title="Glyph ini belum ada — buat glyph kosong untuk digambar"
                >
                  <Sparkles size={13} /> Create Glyph
                </button>
              )}
              {swashTargetExists && (
                <button className="fm-feature-btn fm-feature-btn-ghost" onClick={() => goEdit(swashTargetName)}>
                  Edit Glyph
                </button>
              )}
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                disabled={!swashBase || !swashTargetName}
                onClick={() => setSwashPreview((v) => !v)}
              >
                <Eye size={13} /> Preview
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-primary"
                disabled={!swashBase || !swashTargetName || !swashTargetExists}
                onClick={() => {
                  setSwashRule(swashBase, swashTargetName);
                  setSwashTarget(""); setSwashPreview(false);
                }}
              >
                Add
              </button>
            </div>
            {swashPreview && swashBase && swashTargetName && (
              <div className="fm-feature-preview-row">
                <RuleGlyph char={swashBase} glyphs={glyphs} />
                <span className="fm-feature-arrow">→</span>
                <RuleGlyph char={swashTargetName} glyphs={glyphs} />
              </div>
            )}
            <div className="fm-feature-rule-list">
              {config.swashes.length === 0 && <div className="fm-feature-empty">Belum ada swash.</div>}
              {config.swashes.map((rule) => (
                <div className="fm-feature-rule-row" key={rule.id}>
                  <RuleGlyph char={rule.base} glyphs={glyphs} />
                  <span className="fm-feature-arrow">→</span>
                  <RuleGlyph char={rule.swash} glyphs={glyphs} />
                  <span className="fm-feature-rule-label">{rule.base} → {rule.swash}</span>
                  <div className="fm-spacer" />
                  <button className="fm-feature-remove" onClick={() => removeSwashRule(rule.id)} title="Remove">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
