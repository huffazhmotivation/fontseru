// Menerapkan perbaikan export iOS ke bundle Design hasil build (lihat ios-export.js untuk penjelasan masalahnya).
// Idempotent: aman dijalankan berulang. Jika DesignSeru di-build ulang dan nama variabel minify berubah,
// pola di bawah tidak akan cocok — skrip memberi peringatan keras (build tidak gagal) dan patch perlu disesuaikan.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node patch-export.mjs <public/design/assets>"); process.exit(1); }
const file = fs.readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f)).map((f) => path.join(dir, f))
  .find((f) => fs.readFileSync(f, "utf8").includes('"designseru:exportdir"'));
if (!file) { console.warn("[patch-export] PERINGATAN: bundle utama tidak ditemukan"); process.exit(0); }
let s = fs.readFileSync(file, "utf8");
if (s.includes("__dsIosSave")) { console.log("[patch-export] sudah terpasang:", path.basename(file)); process.exit(0); }

const edits = [
  [/if\((\w+)\(\)&&\/\\\.\(seru\|pulpen\)\$\/i\.test\((\w+)\)\)try\{const (\w+)=new File\(\[(\w+)\],\2,\{type:(\w+)\}\)/,
    (m, ios, name, _f, data) => `if(${ios}()&&window.__dsIosSave)return window.__dsIosSave(${name},${data});${m}`],
  [/\{x:0,y:0,w:1,h:1\},(\w+)=document\.createElement\("canvas"\);\1\.width=Math\.max\(1,Math\.ceil\((\w+)\.w\*(\w+)\)\)/g,
    (m, cv, box, sc) => `{x:0,y:0,w:1,h:1};${sc}=window.__dsClampScale?window.__dsClampScale(${box}.w,${box}.h,${sc}):${sc};const ${cv}=document.createElement("canvas");${cv}.width=Math.max(1,Math.ceil(${box}.w*${sc}))`],
  [/(return\{blob:await \w+\((\w+),\w+\.format==="png"\?"image\/png":"image\/jpeg",\.92\),ext:\w+\.format\}\}finally\{ds\(null\))\}/,
    (m, head, cv) => `${head};${cv}.width=${cv}.height=0}`],
  [/const\{blob:(\w+),ext:(\w+),flattened:(\w+)\}=await (\w+)\((\w+),(\w+)\.ids,(\w+),(\w+)\.name\);/,
    (m, g, y, x, r3, doc, p, opt, p2) => `let __r;try{__r=await ${r3}(${doc},${p}.ids,${opt},${p}.name)}catch(__e){window.__dsFlush&&window.__dsFlush();oe("Ekspor gagal: gambar terlalu besar untuk perangkat ini. Turunkan skala (mis. 1x) atau ekspor lebih sedikit objek.","err");return}const{blob:${g},ext:${y},flattened:${x}}=__r;window.__dsIsIOS&&await new Promise(__t=>setTimeout(__t,60));`],
  [/(\w+)&&oe\(\((\w+)\.length>1\?`\$\{\1\} file diekspor`:"File diekspor"\)/,
    (m, c, r) => `window.__dsFlush&&window.__dsFlush(),${c}&&oe((${r}.length>1?\`\${${c}} file \${xv()?"siap disimpan":"diekspor"}\`:xv()?"File siap disimpan":"File diekspor")`],
];
let ok = 0;
for (const [re, fn] of edits) {
  const before = s;
  s = s.replace(re, fn);
  if (s !== before) ok++; else console.warn("[patch-export] PERINGATAN: pola tidak cocok:", String(re).slice(0, 70));
}
fs.writeFileSync(file, s);
console.log(`[patch-export] ${ok}/${edits.length} tambalan diterapkan ke ${path.basename(file)}`);
