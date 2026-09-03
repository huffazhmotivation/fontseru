import type { BrushSettings } from "./brush";
import type { FontInfo, FontMetrics } from "./font";
import type { CustomFamily, FontStyle, GlyphFamily, GlyphMap } from "./glyph";
import type { KerningManualFlags, KerningPairs, KerningOverridesByStyle, KerningOverrideManualByStyle, WordSpacingOverridesByStyle, KerningClasses } from "./kerning";
import type { FeatureBuilderConfig } from "./opentypeFeatures";

export const FONTSERU_PROJECT_FORMAT = "fontseru-project" as const;
export const FONTSERU_PROJECT_VERSION = 1 as const;

export interface FontSeruProjectV1 {
  format: typeof FONTSERU_PROJECT_FORMAT;
  version: typeof FONTSERU_PROJECT_VERSION;
  appVersion: string;
  savedAt: string;
  font: {
    name: string;
    info: FontInfo;
    metrics: FontMetrics;
    /** Regular glyph map kept for backward compatibility with older .fs files. */
    glyphs: GlyphMap;
    glyphsByStyle?: GlyphFamily;
    /** Custom Glyph tabs beyond Regular/Bold/Italic. Optional so older .fs files without this field still open fine. */
    customFamilies?: CustomFamily[];
    kerningPairs: KerningPairs;
    kerningManual: KerningManualFlags;
    /** Optional additive family-kerning fields keep v1 projects backward compatible. */
    kerningOverridesByStyle?: KerningOverridesByStyle;
    kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
    /** Optional sparse per-style word spacing layer; absent means every
     * style still inherits the shared metrics.wordSpacing. Optional so
     * older .fs files without this field still open fine. */
    wordSpacingOverridesByStyle?: WordSpacingOverridesByStyle;
    /** Kerning Classes ("groups") and their class-pair values. Optional so
     * older .fs files without this field still open fine — their kerning
     * stays exactly as a flat kerningPairs table with no groups defined. */
    kerningClasses?: KerningClasses;
    classKerningPairs?: Record<string, number>;
    /** OpenType Feature Builder config. Optional so older .fs files without
     * this field still open fine. */
    featureConfig?: FeatureBuilderConfig;
  };
  editor: {
    activeChar: string;
    fontStyle?: FontStyle;
    gridSize: number;
    showGrid: boolean;
    showGuides: boolean;
    /** Optional so older .fs files without this field still open fine. */
    snapEnabled?: boolean;
    ghost: { enabled: boolean; mode?: "sample" | "family" | "image"; opacity: number; scale: number; offsetX: number; offsetY: number; imageSrc?: string | null; imageAspect?: number };
    brush: BrushSettings;
  };
}

export type FontSeruProject = FontSeruProjectV1;
