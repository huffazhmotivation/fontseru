#!/bin/sh
# Rebuild the embedded DesignSeru app (Mode Design) into public/design.
# Usage: scripts/build-design.sh /path/to/designserupro-main
# Menyalin scripts/design-patches/src/* ke sumber DesignSeru (sub-path aset relatif, tab Font/Design/Motion di top bar,
# jembatan salin-tempel SVG Font <-> Design, URL ilustrasi relatif), memakai ../design.env sebagai .env.production (kunci Pexels), lalu build.
# Catatan: berkas patch adalah salinan penuh dari DesignSeru (v1.51.1, commit b227cef) + patch; bila DesignSeru berubah di
# berkas yang sama, terapkan ulang perubahan tersebut ke scripts/design-patches/src terlebih dulu.
# Pengingat sholat: ui/PrayerReminder.tsx & lib/prayer/scheduler.ts di patch adalah STUB (popup/penjadwal sholat ada di FontSeru,
# src/prayer, supaya tidak dobel dan memakai gaya FontSeru); menu DesignSeru hanya mengirim pesan ke FontSeru untuk membuka pengaturan.
# Undo-Pen kini bawaan DesignSeru (smartUndo), jadi penUndo.ts tidak lagi dipakai.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?path ke folder proyek DesignSeru}"
cp -R "$HERE/scripts/design-patches/src/." "$SRC/src/"
cp "$HERE/design.env" "$SRC/.env.production"
(cd "$SRC" && npm install --no-audit --no-fund && node scripts/prepare-assets.mjs && npx vite build --base=./ --outDir dist)
rm -rf "$HERE/public/design"
cp -R "$SRC/dist" "$HERE/public/design"
# PWA DesignSeru tidak dipakai di dalam FontSeru (lihat patch main.tsx)
rm -f "$HERE/public/design/sw.js" "$HERE/public/design/sw-manifest.json"
perl -0pi -e 's|(<meta name="theme-color"[^>]*>)|$1<style>html{background:#0b0b0b}</style>|' "$HERE/public/design/index.html"
# Font Google jangan memblokir render (layar putih bila fonts.googleapis.com lambat)
perl -0pi -e 's|<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)"\s*/?>|<link rel="stylesheet" href="$1" media="print" onload="this.media=\x27all\x27" />|' "$HERE/public/design/index.html"
# Perbaikan export iPad/iOS: ios-export.js + tambalan bundle
cp "$HERE/scripts/design-patches/ios-export.js" "$HERE/public/design/ios-export.js"
perl -0pi -e 's|(<script type="module" crossorigin src="\./assets/index-)|<script src="./ios-export.js"></script>\n    $1|' "$HERE/public/design/index.html"
node "$HERE/scripts/design-patches/patch-export.mjs" "$HERE/public/design/assets"
echo "OK: public/design diperbarui"
