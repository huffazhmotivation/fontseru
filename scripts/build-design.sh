#!/bin/sh
# Rebuild the embedded DesignSeru app (Mode Design) into public/design.
# Usage: scripts/build-design.sh /path/to/Optimized_Design_WebApp_Production
# Copies scripts/design-patches/* over the design source first (sub-path asset
# URLs + the Font/Design/Motion tabs in its top bar) and uses ../design.env
# as its .env.production (Pexels key).
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?path ke folder proyek DesignSeru}"
cp "$HERE/scripts/design-patches/TopBar.tsx" "$SRC/src/ui/TopBar.tsx"
cp "$HERE/scripts/design-patches/decor.ts" "$SRC/src/lib/decor.ts"
cp "$HERE/scripts/design-patches/App.tsx" "$SRC/src/App.tsx"
cp "$HERE/design.env" "$SRC/.env.production"
(cd "$SRC" && npm install --no-audit --no-fund && node scripts/prepare-assets.mjs && npx vite build --base=./ --outDir dist)
rm -rf "$HERE/public/design"
cp -R "$SRC/dist" "$HERE/public/design"
perl -0pi -e 's|(<meta name="theme-color"[^>]*>)|$1<style>html{background:#0b0b0b}</style>|' "$HERE/public/design/index.html"
echo "OK: public/design diperbarui"
