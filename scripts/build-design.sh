#!/bin/sh
# Rebuild the embedded DesignSeru app (Mode Design) into public/design.
# Usage: scripts/build-design.sh /path/to/Optimized_Design_WebApp_Production
# Needs two small patches in the design source so it works under a sub-path
# (already applied in the shipped build): TopBar.tsx favicon and decor.ts
# textures must resolve via document.baseURI instead of "/...".
set -e
SRC="${1:?path ke folder proyek DesignSeru}"
(cd "$SRC" && npm install --no-audit --no-fund && node scripts/prepare-assets.mjs && npx vite build --base=./ --outDir dist)
rm -rf "$(dirname "$0")/../public/design"
cp -R "$SRC/dist" "$(dirname "$0")/../public/design"
echo "OK: public/design diperbarui"
