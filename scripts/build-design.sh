#!/bin/sh
# Rebuild the embedded DesignSeru app (Mode Design) into public/design.
# Usage: scripts/build-design.sh /path/to/designserupro-main
# Menyalin scripts/design-patches/src/* ke sumber DesignSeru (sub-path aset relatif, tab Font/Design/Motion di top bar,
# jembatan salin-tempel SVG Font <-> Design, URL ilustrasi relatif), memakai ../design.env sebagai .env.production (kunci Pexels), lalu build.
# Catatan: berkas patch adalah salinan penuh dari DesignSeru (v1.49.1, commit fc78498) + patch; bila DesignSeru berubah di
# berkas yang sama, terapkan ulang perubahan tersebut ke scripts/design-patches/src terlebih dulu.
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
echo "OK: public/design diperbarui"
