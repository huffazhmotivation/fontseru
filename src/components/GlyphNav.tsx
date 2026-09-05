import { useMemo, useRef, useState, type FormEvent } from "react";
import { Lock, Plus, Search, X, Zap, Globe } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { FONT_STYLES, MAX_CUSTOM_FAMILIES, hasOutline } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";
import { GlyphThumbnail } from "./GlyphThumbnail";

// Bold/Italic keep these reserved ids (see the store's defaultCustomFamilies)
// so they can stay PRO-gated like before, even though they're now ordinary
// entries in `customFamilies` rather than permanent built-ins.
function isReservedStyleId(id: string): id is "bold" | "italic" {
  return id === "bold" || id === "italic";
}

export function GlyphNav() {
  const [query, setQuery] = useState("");
  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const setActiveChar = useAppStore((s) => s.setActiveChar);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const setFontStyle = useAppStore((s) => s.setFontStyle);
  const customFamilies = useAppStore((s) => s.customFamilies);
  const addCustomFamily = useAppStore((s) => s.addCustomFamily);
  const removeCustomFamily = useAppStore((s) => s.removeCustomFamily);
  const generateFromRegular = useAppStore((s) => s.generateFromRegular);
  const openProModal = useAppStore((s) => s.openProModal);
  const addMultilingualGlyphs = useAppStore((s) => s.addMultilingualGlyphs);
  const closeMobilePanels = useAppStore((s) => s.closeMobilePanels);
  const { isPro } = useAuth();
  const [multilingualStatus, setMultilingualStatus] = useState<string | null>(null);
  const [addingFamily, setAddingFamily] = useState(false);
  const [newFamilyName, setNewFamilyName] = useState("");
  const newFamilyInputRef = useRef<HTMLInputElement>(null);

  const canAddFamily = customFamilies.length < MAX_CUSTOM_FAMILIES;

  const startAddFamily = () => {
    if (!isPro) { openProModal("family"); return; }
    if (!canAddFamily) return;
    setNewFamilyName("");
    setAddingFamily(true);
    window.setTimeout(() => newFamilyInputRef.current?.focus(), 0);
  };

  const cancelAddFamily = () => {
    setAddingFamily(false);
    setNewFamilyName("");
  };

  const submitAddFamily = (event: FormEvent) => {
    event.preventDefault();
    const created = addCustomFamily(newFamilyName);
    if (created) cancelAddFamily();
  };

  const deleteFamily = (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This removes its tab and all drawn glyphs, and cannot be undone.`)) return;
    removeCustomFamily(id);
  };

  const runAddMultilingual = () => {
    const result = addMultilingualGlyphs();
    const parts: string[] = [];
    if (result.created > 0) parts.push(`${result.created} glyph${result.created === 1 ? "" : "s"} added`);
    const markSlots = result.markSlotsAdded + result.symbolSlotsAdded;
    if (markSlots > 0) parts.push(`${markSlots} accent mark${markSlots === 1 ? "" : "s"} ready to draw`);
    if (result.letterSlotsAdded > 0) {
      parts.push(`${result.letterSlotsAdded} letter${result.letterSlotsAdded === 1 ? "" : "s"} ready to draw`);
    }
    setMultilingualStatus(parts.length > 0 ? parts.join(" · ") : "Nothing new — draw more accent marks first");
    window.setTimeout(() => setMultilingualStatus(null), 4000);
  };

  const totalCount = Object.keys(glyphs).length;
  const doneCount = useMemo(
    () => Object.values(glyphs).filter(hasOutline).length,
    [glyphs]
  );

  const filteredGroups = useMemo(() => {
    const baseChars = new Set(GLYPH_GROUPS.flatMap((g) => g.chars));
    const extrasByCategory = new Map<string, string[]>();
    for (const [ch, glyph] of Object.entries(glyphs)) {
      if (baseChars.has(ch)) continue;
      const arr = extrasByCategory.get(glyph.category) ?? [];
      arr.push(ch);
      extrasByCategory.set(glyph.category, arr);
    }
    const groups = GLYPH_GROUPS.map((g) => ({
      ...g,
      chars: [...g.chars.filter((ch) => Boolean(glyphs[ch])), ...(extrasByCategory.get(g.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode)],
    })).filter((g) => g.chars.length > 0);
    const assigned = new Set(groups.flatMap((g) => g.chars));
    const remaining = Object.keys(glyphs).filter((ch) => !assigned.has(ch)).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
    const allGroups = remaining.length ? [...groups, { id: "symbols" as const, label: "Imported", chars: remaining }] : groups;
    if (!query.trim()) return allGroups;
    const q = query.trim().toLowerCase();
    return allGroups.map((g) => ({
      ...g,
      chars: g.chars.filter((ch) => {
        if (ch.toLowerCase() === q) return true;
        const info = glyphs[ch];
        return info ? unicodeHex(info.unicode).toLowerCase().includes(q) || (info.name ?? "").toLowerCase().includes(q) : false;
      }),
    })).filter((g) => g.chars.length > 0);
  }, [query, glyphs]);

  return (
    <div className="fm-glyphnav" data-testid="glyph-nav">
      <div className="fm-glyphnav-head">
        <div className="fm-glyphnav-eyebrow-row">
          <span className="fm-panel-eyebrow">Glyphs</span>
          <span
            className="fm-glyph-count-badge"
            title={`${doneCount} dari ${totalCount} glyph sudah digambar`}
            data-testid="glyph-done-count"
          >
            {doneCount}/{totalCount}
          </span>
        </div>

        <div className="fm-family-tabs" role="tablist" aria-label="Font family style" data-testid="family-tabs">
          {/* Regular is the only permanent tab — always free, never removable. */}
          {FONT_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              role="tab"
              aria-selected={fontStyle === style.id}
              className={fontStyle === style.id ? "active" : ""}
              onClick={() => setFontStyle(style.id)}
              data-testid={`family-tab-${style.id}`}
            >
              {style.label}
            </button>
          ))}
          {customFamilies.map((family) => {
            // Bold/Italic keep their PRO gate even though they're just
            // regular family entries now: locked tabs stay visible (dimmed
            // + lock icon) and tapping opens the ProUpsellModal instead of
            // switching styles — the actual switch is also blocked at the
            // store level (setFontStyle) so this is UI polish, not the
            // only line of defense. Any other custom family was already
            // PRO-gated at creation time, so it never needs this here.
            const locked = isReservedStyleId(family.id) && !isPro;
            return (
              <button
                key={family.id}
                type="button"
                role="tab"
                aria-selected={fontStyle === family.id}
                className={`fm-family-tab-custom ${fontStyle === family.id ? "active" : ""} ${locked ? "fm-family-tab-locked" : ""}`}
                onClick={() => (locked ? openProModal("family") : setFontStyle(family.id))}
                title={locked ? `${family.name} (PRO)` : family.name}
                data-testid={`family-tab-${family.id}`}
              >
                <span className="fm-family-tab-custom-label">{family.name}</span>
                {locked && <Lock size={10} className="fm-lock-badge-inline" />}
                {!locked && (
                  <span
                    className="fm-family-tab-remove"
                    role="button"
                    tabIndex={0}
                    title={`Remove ${family.name}`}
                    onClick={(event) => { event.stopPropagation(); deleteFamily(family.id, family.name); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.stopPropagation();
                        event.preventDefault();
                        deleteFamily(family.id, family.name);
                      }
                    }}
                    data-testid={`family-tab-remove-${family.id}`}
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {addingFamily ? (
          <form className="fm-family-add-form" onSubmit={submitAddFamily} data-testid="add-family-form">
            <input
              ref={newFamilyInputRef}
              value={newFamilyName}
              onChange={(e) => setNewFamilyName(e.target.value)}
              placeholder="Family name…"
              maxLength={40}
              spellCheck={false}
              data-testid="add-family-input"
            />
            <button type="submit" className="fm-family-add-confirm" disabled={!newFamilyName.trim()} title="Create family" data-testid="add-family-confirm">
              <Plus size={13} />
            </button>
            <button type="button" className="fm-family-add-cancel" onClick={cancelAddFamily} title="Cancel" data-testid="add-family-cancel">
              <X size={13} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            className={`fm-action-btn fm-family-add-btn ${!isPro || !canAddFamily ? "fm-action-btn-locked" : ""}`}
            onClick={startAddFamily}
            title={
              !isPro
                ? "Add Family (PRO)"
                : !canAddFamily
                  ? `Maximum ${MAX_CUSTOM_FAMILIES} custom families`
                  : "Add a new Glyph tab"
            }
            data-testid="add-family-btn"
          >
            <Plus size={14} />
            <span>Add Family</span>
            {!isPro && <Lock size={12} className="fm-lock-badge-inline" />}
          </button>
        )}

        {fontStyle !== "regular" && (
          <button
            type="button"
            className={`fm-action-btn accent fm-family-generate ${!isPro ? "fm-action-btn-locked" : ""}`}
            onClick={() => (isPro ? generateFromRegular() : openProModal("family"))}
            data-testid="generate-from-regular"
          >
            <Zap size={15} fill="currentColor" />
            <span>Generate From Regular</span>
            {!isPro && <Lock size={12} className="fm-lock-badge-inline" />}
          </button>
        )}

        <div className="fm-search">
          <Search size={14} />
          <input
            placeholder="Search glyph or U+…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            data-testid="glyph-search"
          />
        </div>
      </div>
      <div className="fm-glyphlist">
        {filteredGroups.map((g) => (
          <div key={g.id}>
            <div className="fm-group-label">{g.label}</div>
            <div className="fm-grid">
              {g.chars.map((ch) => {
                const info = glyphs[ch];
                if (!info) return null;
                const done = hasOutline(info);
                return (
                  <button
                    key={ch}
                    className={`fm-tile ${activeChar === ch ? "active" : ""} ${done ? "done" : ""}`}
                    onClick={() => { setActiveChar(ch); closeMobilePanels(); }}
                    title={`${ch === " " ? "Space" : ch} — ${unicodeHex(info.unicode)}`}
                    data-testid={`glyph-tile-${ch}`}
                  >
                    {done && <span className="fm-tile-dot" />}
                    <span className="fm-tile-thumb"><GlyphThumbnail glyph={info} /></span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {filteredGroups.length === 0 && (
          <div className="fm-hint" style={{ padding: "10px 4px" }}>No glyph matches “{query}”.</div>
        )}
      </div>
      <div className="fm-glyphnav-foot">
        <button
          type="button"
          className="fm-action-btn accent"
          onClick={runAddMultilingual}
          title="Compose accented letters (É, ü, ñ…) from glyphs you've already drawn"
          data-testid="add-multilingual-btn"
        >
          <Globe size={14} /> + Multilingual Glyphs
        </button>
        {multilingualStatus && (
          <div className="fm-hint" style={{ padding: "6px 4px 0" }} data-testid="add-multilingual-status">
            {multilingualStatus}
          </div>
        )}
      </div>
    </div>
  );
}
