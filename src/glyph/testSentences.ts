// Shared "one sentence, not A-Z order" preset text for Test Lab AND the
// Production Preview bar (BottomBar's "Preview" toggle). Kept in its own
// module — separate from Test Lab's SpecimenPanel.tsx, which is lazy-loaded
// only when the Test Lab overlay opens — so the always-mounted preview bar
// doesn't have to pull in the rest of the (much heavier) Test Lab bundle
// just to read these strings.

// Straight A-Z / a-z ordering never puts two letters next to each other the
// way real words do, so it can't reveal spacing or kerning problems. This
// is a from-scratch pangram (not the usual "lazy dog" / "liquor jugs" ones
// every font tool reuses) that still covers every letter at least once and
// deliberately strings together WA / AV / TO / LY — the tightest pairs a
// designer usually needs to eyeball.
export const UPPER_TEST = "THE WAVY FOX QUICKLY JAZZED MY BRAVE ZEBRA INTO SIX PROUD KINGDOMS.";
export const LOWER_TEST = "the wavy fox quickly jazzed my brave zebra into six proud kingdoms.";

// Same idea for digits: a raw "0123456789" run never shows how digits sit
// next to each other in real use. This reads like an actual date/price/
// invoice line while still covering every digit at least once.
export const NUMBERS_TEST = "08:47 \u2014 27/11/2026 \u2014 $1,250.75 \u2014 #9163 \u2014 (60%)";

// Punctuation and symbols can't form a literal sentence, so instead of a
// flat space-joined dump of the character set, each mark appears once
// inside ordinary-looking usage so it's easier to judge in context. Every
// character in PUNCT / SYMBOLS (see glyph/defaultGlyphs.ts) appears here at
// least once — update both together if that character set ever changes.
export const PUNCTUATION_TEST =
  '"Wait\u2014really?" she asked, laughing: "Yes! Of course; that\'s #1."\n' +
  "Save 50% (limited-time) [Terms apply] {no returns} \u2014 see pages 10\u201312 & item A/B @desk_1 *bonus* \u2014 don't forget: C:\\Data.";
export const SYMBOL_TEST =
  "5 + 3 = 8, and 5 < 10 but 20 > 15 \u2014 x^2 rises ~10\u00b0 warmer than usual.\n" +
  "Priced at $99 / \u20ac89 / \u00a379 / \u00a512,000, \u00a9 2026 Studio\u2122 \u00ae all rights | \u00a7 terms apply.";

// One line per language/accent family so every character the "+ Multilingual
// Glyphs" composer can produce (glyph/multilingual.ts: every RECIPES entry,
// every MULTILINGUAL_LETTER_SLOTS / MULTILINGUAL_SYMBOL_SLOTS char, and every
// bare MULTILINGUAL_MARK_SLOTS mark) shows up at least once, mostly inside
// real or near-real words rather than a flat sorted dump. The last two lines
// are a deliberate "reference chart" (case pairs, then the bare marks alone)
// for the handful of Latin Extended-A letters that don't have a natural
// carrier word — update this alongside multilingual.ts if that recipe table
// ever changes, or a newly-added character will silently go untested here.
export const MULTILINGUAL_TEST_LINES = [
  "O\u00f9 est le caf\u00e9 tr\u00e8s \u00e9l\u00e9gant, mon gar\u00e7on na\u00eff\u202f? No\u00ebl approche\u00a0: on ira au ch\u00e2teau, " +
    "pr\u00e8s de la for\u00eat, \u00e0 c\u00f4t\u00e9 de l'\u00eele, avec une cr\u00eape br\u00fbl\u00e9e bien s\u00fbr \u2014 c'est d\u00e9j\u00e0 l'h\u00f4tel.",
  "El ni\u00f1o so\u00f1\u00f3 con pi\u00f1a en S\u00e3o Paulo; su hermano Jos\u00e9 tom\u00f3 caf\u00e9 con az\u00facar y un poco " +
    "de g\u00fcisqui, mientras cantaban una canci\u00f3n alegre bajo el sol.",
  "\u00c1ngel visit\u00f3 M\u00e1laga, \u00darsula pint\u00f3 un \u00cddolo, \u00d3scar ley\u00f3 un s\u00edmbolo antiguo, " +
    "y \u00c9bano, \u00cc\u00f1igo as\u00ed como \u00d9nica pasearon cerca del r\u00edo m\u00e1s fr\u00edo del pa\u00eds.",
  "\u00dcber Z\u00fcrich weht ein k\u00fchler F\u00f6hn \u2014 \u00c4rger, \u00d6konomie, \u00dcbermut, \u00c4hnlichkeit, " +
    "\u00d6sterreich und \u00c4ngste stehen f\u00fcr sch\u00f6ne \u00dcbersetzungen; sogar ein B\u00e4r tanzt Walzer.",
  "\u00c7a alors \u2014 \u00c0lvaro re\u00e7ut une le\u00e7on sur la fa\u00e7on dont na\u00eet un r\u00eave, tr\u00e8s \u00e9mu, " +
    "presque na\u00eff comme un ch\u00e9rubin pr\u00e8s d'\u00dbz\u00e8s.",
  "Il pi\u00f9 bello universit\u00e0 \u00e8 cos\u00ec, \u00c8lia \u2014 perch\u00e9 non and\u00f2 gi\u00e0, per\u00f2 rest\u00f2 l\u00ec " +
    "vicino a \u00ccschia, e chiese scusa con un caff\u00e8.",
  "\u010c\u00edslo p\u011btadvacet zn\u011blo divn\u011b \u2014 \u0158eho\u0159, \u017dofie a \u0160\u00e1rka \u0161eptali o \u010derven\u00e9m aut\u011b; " +
    "\u010f\u00e1bl\u00edk, \u0165ulpas a \u013dubo\u0161ova dc\u00e9ra \u013dudmila hr\u00e1li s h\u00e1\u010dky a apostrofy: \u010f, \u0165, \u013e.",
  "Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 ja\u017a\u0144 \u2014 \u0141\u00f3d\u017a, \u0106ma, \u017baba a \u0104bramek \u015bpiewali piosenk\u0119 pe\u0142n\u0105 ogonk\u00f3w: " +
    "\u0105, \u0119 i kropek nad literami: \u010b, \u0117, \u0121, \u017c.",
  "K\u0101p\u0113c l\u0101\u010dpl\u0113sis dzied\u0101ja \u0100da\u017eos g\u0101rdu dziesmu R\u012bg\u0101, kam\u0113r \u0112valds un \u012azaks " +
    "klaus\u012bj\u0101s l\u0113n\u0101m \u2014 \u016adens un \u014cga krita p\u0101r ozolu me\u017e\u0101 visi klus\u0101m.",
  "\u0150r\u00fclt gy\u0171r\u0171 \u2014 Cs\u00e1rd\u00e1s, k\u00f6rt\u00e9k \u00e9s t\u00fck\u00f6r csillogtak a h\u0171v\u00f6s est\u00e9n, m\u00edg \u0170 " +
    "\u00e9s \u0150 bet\u0171k mutatt\u00e1k a h\u0171s\u00e9ges kutya nev\u00e9t a h\u00e1zban.",
  "\u0100whio noa te k\u014drero m\u014d te reo M\u0101ori \u2014 he tino pai te ao h\u014du, e k\u012b ana r\u0101tou.",
  "Bj\u00f8rn sk\u00f8yter p\u00e5 \u00c5land mens s\u00f8te p\u00e6rer og tr\u00e6r st\u00e5r gr\u00f8nne \u2014 \u00c6g og \u00f8l p\u00e5 " +
    "bordet \u00c6rlig talt, det er en fin dag i \u00d8stfold med \u00d8 og \u00c6 over alt.",
  "\u00de\u00e6tta er \u00cdslenskur texti me\u00f0 \u00de\u00f3r, \u00d3\u00f0inn og \u00c6gir \u2014 \u00d0\u00edsa og I\u00f0a fljota um " +
    "eins og \u00f6ldur \u00e1 V\u00edk, en ekki gleyma \u00dd og \u0178 \u00ed \u00e6vint\u00fdrinu.",
  "\u0130stanbul'da g\u00fcne\u015fli bir g\u00fcn: ku\u015f, \u00f6\u011fretmen ve \u0130nci \u00e7i\u00e7ek b\u00fcy\u00fctt\u00fc, " +
    "di\u015fli \u00e7ark\u0131 d\u00f6nd\u00fcrd\u00fc \u2014 \u0131s\u0131k \u00e7alan \u00e7ocuklar g\u00fcl\u00fcyordu.",
  "\u0110\u00e2u \u0111\u00f3 \u1edf \u0110\u00e0 L\u1ea1t, m\u1ed9t chi\u1ebfc thuy\u1ec1n nh\u1ecf tr\u00f4i \u00eam \u0111\u1ec1m \u2014 \u0142\u0105ka i wielko\u015b\u0107 " +
    "po\u0142\u0105czone z \u0110\u1ee9c, \u0141ukasz i \u0152dipus czytaj\u0105 razem o c\u0153ur fran\u00e7ais, \u0152 i \u0153 obok siebie.",
  "\u201eCena wynosi 10\u201320 z\u0142\u201d, powiedzia\u0142a ona \u2014 \u00bbIch wei\u00df es nicht\u00ab, 'on nie wie', " +
    "\u2018quizás\u2019, \u201eprzyk\u0142ad\u201a pokazu\u201d, \u201canother style\u201d \u2014 \u00bfverdad? \u00a1Claro que s\u00ed! \u00c7a co\u00fbte " +
    "5 \u00d7 3 = 15 \u00f7 5, soit \u00a2 ou \u00a3, d'accord? Voir \u00a7 III \u2022 catatan \u2020 dan titik tengah \u00b7 " +
    "sebelum tanda kutip \u00ab\u00bb.",
  "Referensi pasangan huruf tambahan: \u00c2 \u00e2 \u00c3 \u00e3 \u00ca \u00ea \u00cb \u00eb \u00ce \u00ee \u00cf \u00ef \u00d1 \u00f1 \u00d2 \u00f2 \u00d4 \u00f4 \u00d5 \u00f5 " +
    "\u00de \u00fe \u0178 \u00ff \u0102 \u0103 \u010a \u010b \u0116 \u0117 \u0118 \u0119 \u011a \u011b \u0120 \u0121 \u0147 \u0148 \u0150 \u0151 \u016a \u016b.",
  "Bentuk dasar tanda ini sendiri \u2014 akut \u00b4, grave `, diaeresis \u00a8, cedilla \u00b8, " +
    "caron \u02c7, ogonek \u02db, macron \u00af, breve \u02d8, titik atas \u02d9, dan akut ganda \u02dd \u2014 " +
    "adalah slot yang perlu digambar dulu sebelum semua kombinasi di atas muncul.",
];
export const MULTILINGUAL_TEST = MULTILINGUAL_TEST_LINES.join("\n");

/**
 * Picks the most relevant one-line preset for whatever glyph category is
 * currently focused in the editor — used by the Production Preview bar so
 * switching between drawing an uppercase letter and a digit automatically
 * shows the sentence that actually contains it. Falls back to the
 * uppercase pangram (a safe default that reads fine either way) for
 * categories with no natural single-sentence form (spacing, feature glyphs).
 */
export function sentenceForCategory(category: string | undefined): string {
  switch (category) {
    case "upper": return UPPER_TEST;
    case "lower": return LOWER_TEST;
    case "digits": return NUMBERS_TEST;
    case "punct": return PUNCTUATION_TEST;
    case "symbols": return SYMBOL_TEST;
    case "multilingual": return MULTILINGUAL_TEST;
    default: return UPPER_TEST;
  }
}
