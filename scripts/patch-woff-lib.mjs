/**
 * FIX for broken WOFF2 exports (woff-lib 0.0.3).
 *
 * Two bugs in the encoder made FontSeru's .woff2 files unusable while the
 * .ttf/.woff next to them were fine:
 *
 * 1. Point "triplets" (glyf transform). WOFF2 stores each outline point as a
 *    flag byte plus 1–4 data bytes; the flag is a base value PLUS the high
 *    bits of the deltas (spec §5.2; Google's reference `WriteTriplet` in
 *    woff2/src/transform.cc). woff-lib combined three of those with bitwise
 *    OR. The bases (10, 20, 84) already have some of those bits set, so OR
 *    lost them and decoders put points up to 256 units off — nearly every
 *    glyph came out distorted (2,490 of 2,692 in an Arial test).
 *
 * 2. Padding. A WOFF2 file must be padded to a multiple of 4 bytes; Google's
 *    decoder (Chrome, Firefox, Safari) rejects it otherwise with "Failed to
 *    convert WOFF 2.0 font to SFNT". woff-lib wrote the exact length, so
 *    roughly three out of four exported files did not load at all.
 *
 * Both are rewritten to match the reference encoder. Idempotent; never fails
 * the install (it only warns if woff-lib's code layout ever changes).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("node_modules/woff-lib/dist");
const files = ["woff2-encode.js", "woff2-encode.cjs", "encode.js", "encode.cjs", "index.js", "index.cjs"];
const replacements = [
  ["onCurveBit | 10 | absDx >> 7 & 14 | xSign", "onCurveBit + 10 + (absDx >> 7 & 14) + xSign"],
  [
    "onCurveBit | 20 | absDx - 1 & 48 | (absDy - 1 & 48) >> 2 | xySign",
    "onCurveBit + 20 + (absDx - 1 & 48) + ((absDy - 1 & 48) >> 2) + xySign",
  ],
  [
    "onCurveBit | 84 | (absDx - 1 >> 8) * 12 | absDy - 1 >> 6 & 12 | xySign",
    "onCurveBit + 84 + (absDx - 1 >> 8) * 12 + (absDy - 1 >> 6 & 12) + xySign",
  ],
  [
    "const totalSize = 48 + tableDirectorySize + compressed.byteLength;",
    "const totalSize = 48 + tableDirectorySize + compressed.byteLength + 3 & -4 /* fontseru: 4-byte padding */;",
  ],
  [
    "\toutput.writeBytes(compressed);\n\treturn output.getBytes();",
    "\toutput.writeBytes(compressed);\n\twhile (output.offset < totalSize) output.writeU8(0) /* fontseru: 4-byte padding */;\n\treturn output.getBytes();",
  ],
];

let patched = 0;
for (const name of files) {
  const file = path.join(dir, name);
  if (!existsSync(file)) continue;
  let src = readFileSync(file, "utf8");
  if (!src.includes("function writeTriplet")) continue;
  let changed = false;
  for (const [from, to] of replacements) {
    if (src.includes(to)) continue;
    if (src.includes(from)) {
      src = src.split(from).join(to);
      changed = true;
    } else {
      console.warn(`[patch-woff-lib] ${name}: expected code not found; part of the WOFF2 fix not applied.`);
    }
  }
  if (changed) {
    writeFileSync(file, src);
    patched++;
  }
}
console.log(`[patch-woff-lib] patched ${patched} file(s).`);
