#!/usr/bin/env node
// Pasang build web DesignSeru yang SUDAH JADI (tanpa source, mis. designseru-pages/dist 1.69.0) sebagai Mode Design di
// public/design. Pakai ini bila DesignSeru hanya tersedia sebagai hasil build; bila source-nya ada, pakai build-design.sh.
//
//   node scripts/design-patches/embed-build.mjs "/path/ke/designseru-pages/dist"
//
// Tambalan khusus FontSeru (setiap pola harus cocok, kalau tidak skrip berhenti tanpa mengubah public/design):
//  - tab Font / Design / Motion di bar atas, tepat di kanan logo (mengirim "fontseru:set-mode" ke FontSeru)
//  - aset pustaka (ikon, bendera, tekstur, dll.) dimuat relatif dari /design/, bukan dari akar situs
//  - service worker DesignSeru tidak didaftarkan (FontSeru punya service worker sendiri di akar situs)
//  - pengingat sholat DesignSeru dimatikan di dalam FontSeru (sudah ada di FontSeru); menu "Pengingat sholat…" membuka
//    pengaturan milik FontSeru
//  - salinan Design juga dikirim ke tab Font lewat postMessage ("seru:clip"), jadi Tempel di Font tidak butuh izin clipboard
import fs from "node:fs";
import path from "node:path";

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(path.join(SRC, "index.html"))) {
  console.error("Pakai: node scripts/design-patches/embed-build.mjs <folder dist DesignSeru>");
  process.exit(1);
}
const OUT = path.join(HERE, "public/design");
const TMP = path.join(HERE, "public/.design-new");
fs.rmSync(TMP, { recursive: true, force: true });
fs.cpSync(SRC, TMP, { recursive: true });

// berkas khusus Cloudflare Pages
for (const f of ["_headers", "_routes.json", "ai/parts", "sw.js", "sw-manifest.json"]) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
// wasm ONNX ±27 MB dipecah di versi Cloudflare: pakai berkas utuhnya
const WASM = "ai/ort-wasm-simd-threaded.asyncify.wasm";
if (!fs.existsSync(path.join(TMP, WASM))) {
  const from = [path.join(SRC, "..", "..", ".work/asar/dist", WASM), path.join(OUT, WASM)].find((p) => fs.existsSync(p));
  if (!from) throw new Error(`${WASM} tidak ditemukan`);
  fs.copyFileSync(from, path.join(TMP, WASM));
}

const htmlPath = path.join(TMP, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
const entry = /<script type="module" crossorigin src="\.\/assets\/(index-[\w-]+\.js)"><\/script>/.exec(html)?.[1];
if (!entry) throw new Error("script utama tidak ditemukan di index.html");
const jsPath = path.join(TMP, "assets", entry);
let js = fs.readFileSync(jsPath, "utf8");

const once = (label, from, to) => {
  const n = js.split(from).length - 1;
  if (n !== 1) throw new Error(`pola "${label}" ditemukan ${n}x (harus 1x) — build DesignSeru berbeda, sesuaikan skrip ini`);
  js = js.replace(from, () => to);
};

// 1) tab mode di kanan logo
const header = /(u\.jsxs\("header",\{className:"ds-topbar[^"]*",children:\[)u\.jsx\((\w+),\{\}\),/.exec(js);
if (!header) throw new Error('bar atas ("ds-topbar") tidak ditemukan');
const ICONS = {
  font: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  design:
    '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>',
  motion:
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};
const modeSwitch = `function __fsModeSwitch(){if(typeof window>"u"||window.parent===window)return null;const go=m=>window.parent.postMessage({type:"fontseru:set-mode",mode:m},location.origin),ts={height:30,padding:"0 13px",gap:7,fontSize:12.5,letterSpacing:"-0.01em",borderRadius:8,lineHeight:1},b="inline-flex items-center whitespace-nowrap border font-semibold",idle=b+" border-transparent transition-colors text-muted hover:text-ink",on=b+" border-line bg-panel text-ink shadow-sm",ic=(d,c)=>u.jsx("svg",{width:15,height:15,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",className:c,"aria-hidden":!0,dangerouslySetInnerHTML:{__html:d}}),tab=(k,label,d,active)=>u.jsxs("button",{type:"button",role:"tab","aria-selected":active,className:active?on:idle,style:ts,onClick:active?void 0:()=>go(k),children:[ic(d,active?"text-accent":"opacity-80"),u.jsx("span",{children:label})]},k);return u.jsxs("div",{role:"tablist","aria-label":"Mode editor",className:"mx-1.5 flex shrink-0 items-center border border-line bg-field",style:{padding:3,gap:3,borderRadius:11},children:[tab("font","Font",${JSON.stringify(ICONS.font)},!1),tab("design","Design",${JSON.stringify(ICONS.design)},!0),tab("motion","Motion",${JSON.stringify(ICONS.motion)},!1)]})}`;
once("bar atas", header[0], `${header[1]}u.jsx(${header[2]},{}),u.jsx(__fsModeSwitch,{}),`);
js += `\n${modeSwitch}\n`;

// 2) aset pustaka relatif terhadap /design/
let assetCount = 0;
js = js.replace(/`\/(doodleart|emoji|flags|flat|icons|kuliner|objectart|ornamen|siluet|tekstur|textures|undraw)\//g, (_m, dir) => {
  assetCount++;
  return "`${window.__DS_BASE__||\"/\"}" + dir + "/";
});
if (!assetCount) throw new Error("URL aset pustaka tidak ditemukan");

// 3) service worker
once(
  "service worker",
  `"serviceWorker"in navigator&&(location.protocol==="https:"||location.hostname==="localhost")&&window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}))`,
  "void 0",
);

// 4) pengingat sholat: mati di dalam FontSeru, menu membuka pengaturan FontSeru
const prayerStore = /(\w+)=an\(\(\)=>\(\{enabled:!0,place:null,method:"auto"/.exec(js);
if (!prayerStore) throw new Error("store pengingat sholat tidak ditemukan");
once("sholat: default", prayerStore[0], prayerStore[0].replace("enabled:!0", "enabled:window.parent===window"));
once("sholat: tersimpan", "enabled:t.enabled!==!1,place:t.place", "enabled:window.parent===window&&t.enabled!==!1,place:t.place");
once("sholat: deteksi lokasi", "let e=!1;const t=async()=>{const o=Ht.getState(),i=Date.now()-o.detectedAt;".replaceAll("Ht", prayerStore[1]), `if(window.parent!==window)return()=>{};let e=!1;const t=async()=>{const o=${prayerStore[1]}.getState(),i=Date.now()-o.detectedAt;`);
const settings = /const (\w+)=\(\)=>(\w+)\(\{settingsOpen:!0\}\);/.exec(js);
if (!settings) throw new Error("menu pengingat sholat tidak ditemukan");
once("sholat: menu", settings[0], `const ${settings[1]}=()=>{if(window.parent!==window){try{window.parent.postMessage({type:"fontseru:prayer-settings"},location.origin)}catch{}return}${settings[2]}({settingsOpen:!0})};`);

fs.writeFileSync(jsPath, js);

// index.html: latar gelap sebelum CSS termuat + basis aset + jembatan salin ke tab Font
const embed = `<script>
      // FontSeru: aset pustaka dimuat relatif dari folder ini (/design/)
      window.__DS_BASE__ = new URL("./", document.baseURI).href;
      // FontSeru: salinan SVG Design juga dikirim ke tab Font, supaya Tempel di Font tidak butuh izin baca clipboard
      (function () {
        if (window.parent === window) return;
        var c = navigator.clipboard;
        var send = function (t) {
          if (typeof t !== "string" || t.indexOf("<svg") < 0) return;
          var m = /<!--\\s*designseru-clip:([a-z0-9]+)\\s*-->/.exec(t.slice(0, 4096));
          try { window.parent.postMessage({ type: "seru:clip", from: "design", id: m ? m[1] : "d" + Date.now().toString(36), ts: Date.now(), svg: t }, location.origin); } catch (e) {}
        };
        if (c && c.write) {
          var w = c.write.bind(c);
          c.write = function (items) {
            try {
              var it = items && items[0];
              if (it && it.types && it.types.indexOf("text/plain") >= 0) it.getType("text/plain").then(function (b) { return b.text(); }).then(send, function () {});
            } catch (e) {}
            return w(items);
          };
        }
        if (c && c.writeText) {
          var wt = c.writeText.bind(c);
          c.writeText = function (t) { send(t); return wt(t); };
        }
      })();
    </script>
    `;
const theme = /(<meta name="theme-color"[^>]*>)/;
if (!theme.test(html)) throw new Error("meta theme-color tidak ditemukan");
html = html.replace(theme, "$1<style>html{background:#0b0b0b}</style>");
html = html.replace(/<script type="module" crossorigin src=/, (m) => embed + m);
fs.writeFileSync(htmlPath, html);

fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(TMP, OUT);
console.log(`OK: public/design diganti dari ${SRC} (${entry}, ${assetCount} URL aset dibuat relatif)`);
