/**
 * ROOT-CAUSE FIX for the recurring OTF/WOFF export failure:
 *
 *   Error: Name table entry "en" does not exist, see nameTableNames for
 *   complete list.  (opentype.js  →  makeNameTable / fontToSfntTable)
 *
 * WHY IT HAPPENS
 * --------------
 * opentype.js (1.3.4) builds the sfnt `name` table with plain `for…in`
 * loops:
 *
 *     for (var n in font.names)  { … }          // sfnt.js  (copy names)
 *     for (var key in names)     { … }          // name.js  (encode names)
 *
 * `for…in` walks the ENTIRE prototype chain, so if ANYTHING on the page has
 * added an enumerable property to `Object.prototype` (classic "prototype
 * pollution" — a stray locale key such as `en` from an extension, an ad/
 * analytics script, a polyfill, or another library), that key shows up in
 * EVERY object. opentype then treats `en` as a name-record key, fails to map
 * it to a numeric nameID, and throws — aborting the whole export.
 *
 * This is invisible to `Object.keys()` (own keys only), never reproduces in a
 * clean Node test, and cannot be fully prevented from application code because
 * the offending loop iterates opentype's OWN internal object, not ours.
 *
 * THE FIX
 * -------
 * Rewrite those specific loops to iterate OWN enumerable keys only
 * (`Object.keys(obj)`), which is exactly what the name-table writer intends.
 * The output for a clean environment is byte-for-byte identical; the only
 * behavioural change is that inherited/polluted keys can no longer leak in.
 *
 * This script patches the shipped dist bundles in node_modules so the fix
 * survives a fresh `npm install` (it runs from the "postinstall" hook) and is
 * baked into the production build. It is idempotent and never fails the
 * install — if opentype's layout ever changes, it logs a warning and exits 0.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// The four (readable) dist bundles opentype ships. Vite loads the ESM
// `opentype.module.js`; Node loads the CJS `opentype.js`; the rest are patched
// too for completeness. Minified names differ, so the .min bundle is handled
// with its own patterns.
function resolveOpentypeDir() {
  try {
    const pkg = require.resolve("opentype.js/package.json");
    return path.dirname(pkg);
  } catch {
    return null;
  }
}

/** Readable bundles: `for (var X in Y)` → `for (var X of Object.keys(Y))`. */
const READABLE_REPLACEMENTS = [
  ["for (var key in dict) {", "for (var key of Object.keys(dict)) {"],
  ["for (var key in names) {", "for (var key of Object.keys(names)) {"],
  ["for (var lang in translations) {", "for (var lang of Object.keys(translations)) {"],
  ["for (var n in font.names) {", "for (var n of Object.keys(font.names)) {"],
  ["for (var nameKey in names) {", "for (var nameKey of Object.keys(names)) {"],
  // Some builds emit `let`/`const` instead of `var`.
  ["for (let key in dict) {", "for (let key of Object.keys(dict)) {"],
  ["for (let key in names) {", "for (let key of Object.keys(names)) {"],
  ["for (let lang in translations) {", "for (let lang of Object.keys(translations)) {"],
  ["for (let n in font.names) {", "for (let n of Object.keys(font.names)) {"],
  ["for (let nameKey in names) {", "for (let nameKey of Object.keys(names)) {"],
];

function patchReadable(file) {
  let src = readFileSync(file, "utf8");
  let changed = 0;
  for (const [from, to] of READABLE_REPLACEMENTS) {
    if (src.includes(from)) {
      src = src.split(from).join(to);
      changed++;
    }
  }
  if (changed > 0) writeFileSync(file, src);
  return changed;
}

/**
 * Minified bundle: variable names are single letters, so target the two loops
 * that actually build the name table by their iterated expression. We only
 * rewrite `for(<id> in <id>.names)` (the font.names copy) and the name-encode
 * loop, both matched conservatively with a regex that requires the `for…in`
 * shape and rewrites just that clause. Safe no-op if patterns aren't found.
 */
function patchMinified(file) {
  let src = readFileSync(file, "utf8");
  const before = src;
  // for(x in y.names) -> for(const x of Object.keys(y.names))
  src = src.replace(
    /for\((?:var |let )?([A-Za-z_$][\w$]*) in ([A-Za-z_$][\w$]*\.names)\)/g,
    "for(const $1 of Object.keys($2))",
  );
  if (src !== before) writeFileSync(file, src);
  return src !== before ? 1 : 0;
}

function main() {
  const dir = resolveOpentypeDir();
  if (!dir) {
    console.warn("[patch-opentype] opentype.js not found — skipping (this is fine if it isn't installed yet).");
    return;
  }
  const readable = ["dist/opentype.module.js", "dist/opentype.js"];
  const minified = ["dist/opentype.min.js"];

  let total = 0;
  for (const rel of readable) {
    const f = path.join(dir, rel);
    if (existsSync(f)) total += patchReadable(f);
  }
  for (const rel of minified) {
    const f = path.join(dir, rel);
    if (existsSync(f)) total += patchMinified(f);
  }

  if (total > 0) {
    console.info(`[patch-opentype] Applied ${total} name-table pollution-immunity edit(s) to opentype.js.`);
  } else {
    console.info("[patch-opentype] opentype.js already patched (or nothing to patch).");
  }
}

try {
  main();
} catch (error) {
  // Never break `npm install` over this best-effort hardening.
  console.warn("[patch-opentype] Non-fatal: could not patch opentype.js —", error?.message ?? error);
}
