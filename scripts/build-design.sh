#!/bin/sh
# Rebuild the embedded DesignSeru app (Mode Design) into public/design.
# Usage: scripts/build-design.sh /path/to/designserupro   (repo DesignSeru; TIDAK diubah — build dilakukan di salinan sementara)
# Menyalin scripts/design-patches/src/* ke salinan sumber DesignSeru (sub-path aset relatif, tab Font/Design/Motion di top bar,
# jembatan salin-tempel SVG Font <-> Design, URL ilustrasi relatif), memakai ../design.env sebagai .env.production (kunci Pexels), lalu build.
# Catatan: berkas patch adalah salinan penuh dari DesignSeru + patch (terakhir dirapikan terhadap DesignSeru 1.63.0, commit 6105746).
# Bila DesignSeru berubah di berkas yang sama (main.tsx, ui/TopBar.tsx, ui/TabletModifiers.tsx, ui/CanvasView.tsx, engine/commands.ts, ...),
# gabungkan perubahannya ke scripts/design-patches/src lebih dulu: git merge-file <patch> <versi-lama-di-DesignSeru> <versi-baru>.
# Pengingat sholat: ui/PrayerReminder.tsx & lib/prayer/scheduler.ts di patch adalah STUB (popup/penjadwal sholat ada di FontSeru).
# Salin-tempel: clipboard sistem ditulis mesin Design sendiri (lib/syscopy.ts); jembatan (lib/seruBridge.ts) hanya mengirim SVG
# outline ke tab Font lewat postMessage dan menempel SVG kiriman Font.
# Perbaikan export iPad & bar bawah Design kini bawaan DesignSeru — tidak ada lagi tambalan pada bundle hasil build.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?path ke folder proyek DesignSeru}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude 'desktop/dist' --exclude 'desktop/release' --exclude 'desktop/node_modules' "$SRC/" "$WORK/"
ln -s "$SRC/node_modules" "$WORK/node_modules"
cp -R "$HERE/scripts/design-patches/src/." "$WORK/src/"
cp "$HERE/design.env" "$WORK/.env.production"
(cd "$WORK" && node scripts/prepare-assets.mjs && npx vite build --base=./ --outDir dist)
rm -rf "$HERE/public/design"
cp -R "$WORK/dist" "$HERE/public/design"
# PWA DesignSeru tidak dipakai di dalam FontSeru (lihat patch main.tsx)
rm -f "$HERE/public/design/sw.js" "$HERE/public/design/sw-manifest.json"
perl -0pi -e 's|(<meta name="theme-color"[^>]*>)|$1<style>html{background:#0b0b0b}</style>|' "$HERE/public/design/index.html"
# Font Google jangan memblokir render (layar putih bila fonts.googleapis.com lambat)
perl -0pi -e 's|<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)"\s*/?>|<link rel="stylesheet" href="$1" media="print" onload="this.media=\x27all\x27" />|' "$HERE/public/design/index.html"
echo "OK: public/design diperbarui"
