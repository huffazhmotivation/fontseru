// Tambalan UI kecil untuk bundle Design hasil build (idempotent; peringatan keras bila pola tidak cocok).
// Bar bawah Design: tombol Snap / Penggaris / Grid dulu disembunyikan ke menu zoom bila lebar KANVAS < 700px.
// Di iPad, panel kiri+kanan Design menyempitkan kanvas sampai < 700px walau layarnya lebar (1024px+), sehingga
// ketiga tombol itu "hilang" dari bar. Sekarang yang diukur lebar JENDELA (HP saja yang memakai menu ringkas).
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node patch-ui.mjs <public/design/assets>"); process.exit(1); }
const file = fs.readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f)).map((f) => path.join(dir, f))
  .find((f) => fs.readFileSync(f, "utf8").includes('"designseru:exportdir"'));
if (!file) { console.warn("[patch-ui] PERINGATAN: bundle utama tidak ditemukan"); process.exit(0); }
let s = fs.readFileSync(file, "utf8");
if (s.includes("/*fs-bottombar*/")) { console.log("[patch-ui] sudah terpasang:", path.basename(file)); process.exit(0); }
const re = /(function \w+\(\)\{const \w+=\w+\(\w+=>\w+\.toolOpts\),\w+=\w+\(\w+=>\w+\.camera\.zoom\),\w+=\w+\()(\w+)=>\2\.viewport\.w<700\)/;
if (!re.test(s)) { console.warn("[patch-ui] PERINGATAN: pola bar bawah tidak cocok — tambalan perlu disesuaikan"); process.exit(0); }
s = s.replace(re, (m, head, v) => `${head}${v}=>(${v}.viewport.w,window.innerWidth<600)/*fs-bottombar*/)`);
fs.writeFileSync(file, s);
console.log("[patch-ui] bar bawah Design: tombol Snap/Penggaris/Grid selalu tampil di layar ≥ 600px");
