// Cache-busting setelah bundle Design ditambal. /design/assets/* disajikan "immutable, 1 tahun" (vercel.json),
// jadi isi bundle yang berubah TANPA nama baru tidak akan pernah sampai ke perangkat yang sudah menyimpannya
// (iPad Home Screen). Skrip ini memberi akhiran nama baru pada bundle utama + semua chunk yang (transitif)
// mengimpornya, lalu menulis ulang semua rujukannya (js, css, index.html). Idempotent per tag.
// usage: node bump-assets.mjs <public/design> <tag>   (mis. r2)
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const tag = process.argv[3];
if (!root || !tag) { console.error("usage: node bump-assets.mjs <public/design> <tag>"); process.exit(1); }
const dir = path.join(root, "assets");
const entryOld = fs.readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f))
  .find((f) => fs.readFileSync(path.join(dir, f), "utf8").includes('"designseru:exportdir"'));
if (!entryOld) { console.warn("[bump-assets] PERINGATAN: bundle utama tidak ditemukan"); process.exit(0); }
if (entryOld.endsWith(`-${tag}.js`)) { console.log("[bump-assets] sudah memakai tag", tag); process.exit(0); }

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
const changed = new Set([entryOld]);
for (let grew = true; grew;) {
  grew = false;
  for (const f of files) {
    if (changed.has(f)) continue;
    for (const c of changed) if (text[f].includes(c)) { changed.add(f); grew = true; break; }
  }
}
const rename = new Map([...changed].map((f) => [f, f.replace(/\.js$/, `-${tag}.js`)]));
const targets = [
  ...files.map((f) => path.join(dir, f)),
  ...fs.readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => path.join(dir, f)),
  path.join(root, "index.html"),
];
for (const t of targets) {
  let s = fs.readFileSync(t, "utf8"); const before = s;
  for (const [o, n] of rename) s = s.split(o).join(n);
  if (s !== before) fs.writeFileSync(t, s);
}
for (const [o, n] of rename) fs.renameSync(path.join(dir, o), path.join(dir, n));
console.log(`[bump-assets] ${rename.size} berkas diberi tag -${tag}`);
