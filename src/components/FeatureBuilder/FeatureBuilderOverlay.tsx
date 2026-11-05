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
  SUBSTITUTION_FEATURES,
  isValidFeatureTag,
} from "@/types/opentypeFeatures";
import { configToFea, parseFea } from "@/utils/feaCode";

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
  const addSubstitutionRule = useAppStore((s) => s.addSubstitutionRule);
  const removeSubstitutionRule = useAppStore((s) => s.removeSubstitutionRule);
  const replaceFeatureConfig = useAppStore((s) => s.replaceFeatureConfig);

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

  // --- Substitution (smcp / onum / ss01 / calt …) form state ---
  const [subTag, setSubTag] = useState("smcp");
  const [subFrom, setSubFrom] = useState("");
  const [subTo, setSubTo] = useState("");
  const [subBefore, setSubBefore] = useState("");
  const [subAfter, setSubAfter] = useState("");
  const subTagOk = isValidFeatureTag(subTag.trim());
  const subContext = Boolean(subBefore || subAfter);

  // --- .fea editor state: follows the config until the user edits the text ---
  const generatedFea = useMemo(() => configToFea(config), [config]);
  const [feaText, setFeaText] = useState(generatedFea);
  const [feaDirty, setFeaDirty] = useState(false);
  const [feaErrors, setFeaErrors] = useState<string[]>([]);
  const [feaNote, setFeaNote] = useState("");
  useEffect(() => {
    if (!feaDirty) setFeaText(generatedFea);
  }, [generatedFea, feaDirty]);

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

          {/* Substitutions: smcp / onum / ss01 / calt … */}
          <section className="fm-feature-section">
            <div className="fm-section-title">Substitusi (smcp, onum, ss01, calt …)</div>
            <div className="fm-feature-form">
              <input
                className="fm-feature-input"
                style={{ width: 90 }}
                list="fm-feature-tags"
                value={subTag}
                onChange={(e) => setSubTag(e.target.value)}
                placeholder="tag"
                spellCheck={false}
                aria-label="Tag fitur OpenType"
              />
              <datalist id="fm-feature-tags">
                {SUBSTITUTION_FEATURES.map((f) => <option key={f.tag} value={f.tag}>{f.label}</option>)}
              </datalist>
              <GlyphPicker value={subBefore} onChange={setSubBefore} chars={chars} placeholder="Sebelum (opsional)" />
              <GlyphPicker value={subFrom} onChange={setSubFrom} chars={chars} placeholder="Glyph asal" />
              <GlyphPicker value={subAfter} onChange={setSubAfter} chars={chars} placeholder="Sesudah (opsional)" />
              <span className="fm-feature-arrow">→</span>
              <GlyphPicker value={subTo} onChange={setSubTo} chars={chars} placeholder="Diganti jadi" />
              <button
                className="fm-feature-btn fm-feature-btn-primary"
                disabled={!subTagOk || !subFrom || !subTo}
                onClick={() => {
                  addSubstitutionRule({ feature: subTag.trim(), from: subFrom, to: subTo, before: subBefore || undefined, after: subAfter || undefined });
                  setSubFrom(""); setSubTo(""); setSubBefore(""); setSubAfter("");
                }}
              >
                Add
              </button>
            </div>
            {!subTagOk && <div className="fm-feature-empty">Tag harus 4 karakter huruf/angka, mis. smcp atau ss01.</div>}
            {subContext && <div className="fm-feature-empty">Konteks aktif: berlaku hanya bila glyph asal berada di antara glyph sebelum/sesudah yang dipilih.</div>}
            <div className="fm-feature-rule-list">
              {(config.substitutions ?? []).length === 0 && <div className="fm-feature-empty">Belum ada substitusi.</div>}
              {(config.substitutions ?? []).map((rule) => (
                <div className="fm-feature-rule-row" key={rule.id}>
                  <span className="fm-feature-rule-label" style={{ minWidth: 48 }}>{rule.feature}</span>
                  {rule.before && <RuleGlyph char={rule.before} glyphs={glyphs} />}
                  <RuleGlyph char={rule.from} glyphs={glyphs} />
                  {rule.after && <RuleGlyph char={rule.after} glyphs={glyphs} />}
                  <span className="fm-feature-arrow">→</span>
                  <RuleGlyph char={rule.to} glyphs={glyphs} />
                  <div className="fm-spacer" />
                  <button className="fm-feature-remove" onClick={() => removeSubstitutionRule(rule.id)} title="Remove">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* .fea code editor */}
          <section className="fm-feature-section">
            <div className="fm-section-title">Kode fitur (.fea)</div>
            <textarea
              className="fm-feature-input"
              style={{ width: "100%", minHeight: 160, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
              value={feaText}
              spellCheck={false}
              aria-label="Kode fitur .fea"
              data-testid="fea-textarea"
              onChange={(e) => { setFeaText(e.target.value); setFeaDirty(true); setFeaNote(""); }}
            />
            <div className="fm-feature-form" style={{ marginTop: 8 }}>
              <button
                className="fm-feature-btn fm-feature-btn-primary"
                disabled={!feaDirty}
                data-testid="fea-apply"
                onClick={() => {
                  const res = parseFea(feaText, (k) => Boolean(glyphs[k]));
                  setFeaErrors(res.errors);
                  if (res.config) {
                    replaceFeatureConfig(res.config);
                    setFeaDirty(false);
                    setFeaNote("Kode diterapkan.");
                  } else setFeaNote("");
                }}
              >
                Terapkan
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                disabled={!feaDirty}
                onClick={() => { setFeaText(generatedFea); setFeaDirty(false); setFeaErrors([]); setFeaNote(""); }}
              >
                Batalkan perubahan
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                onClick={() => { void navigator.clipboard?.writeText(feaText).then(() => setFeaNote("Disalin."), () => setFeaNote("Gagal menyalin.")); }}
              >
                Salin
              </button>
              <button
                className="fm-feature-btn fm-feature-btn-ghost"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([feaText], { type: "text/plain" }));
                  const a = document.createElement("a");
                  a.href = url; a.download = "features.fea"; a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Unduh .fea
              </button>
            </div>
            {feaNote && <div className="fm-feature-empty" role="status">{feaNote}</div>}
            {feaErrors.length > 0 && (
              <div className="fm-feature-empty" role="alert" style={{ color: "#e5484d" }}>
                {feaErrors.slice(0, 8).map((e, i) => <div key={i}>{e}</div>)}
                {feaErrors.length > 8 && <div>… dan {feaErrors.length - 8} lainnya</div>}
              </div>
            )}
            <div className="fm-feature-empty">
              Didukung: <code>sub a by a.sc;</code> · <code>sub f f by f_f;</code> · <code>sub a from [a.alt1 a.alt2];</code> · konteks <code>sub a b' by b.alt;</code>. Glyph non-nama ditulis <code>uniXXXX</code>.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
