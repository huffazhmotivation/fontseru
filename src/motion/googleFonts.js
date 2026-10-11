/* Font bawaan dari Google Fonts untuk Mode Motion (daftar sama dengan Mode Design).
 * CSS-nya dimuat sesuai kebutuhan (satu <link> per family); berkas font baru diunduh
 * saat hurufnya benar-benar dipakai. Perlu koneksi internet saat pertama dipakai. */
export const GOOGLE_FONTS = [
  { family: "Inter", category: "Sans-serif", css: "Inter:wght@400;500;600;700" },
  { family: "Plus Jakarta Sans", category: "Sans-serif", css: "Plus+Jakarta+Sans:wght@400;500;600;700" },
  { family: "Poppins", category: "Sans-serif", css: "Poppins:wght@400;500;600;700" },
  { family: "Montserrat", category: "Sans-serif", css: "Montserrat:wght@400;500;600;700" },
  { family: "DM Sans", category: "Sans-serif", css: "DM+Sans:wght@400;500;700" },
  { family: "Playfair Display", category: "Serif", css: "Playfair+Display:wght@400;600;700" },
  { family: "Lora", category: "Serif", css: "Lora:wght@400;600;700" },
  { family: "DM Serif Display", category: "Serif", css: "DM+Serif+Display" },
  { family: "Bebas Neue", category: "Display", css: "Bebas+Neue" },
  { family: "Space Mono", category: "Monospace", css: "Space+Mono:wght@400;700" },
  { family: "Caveat", category: "Tulisan tangan", css: "Caveat:wght@400;600;700" },
  { family: "Pacifico", category: "Tulisan tangan", css: "Pacifico" },
  { family: "Cairo", category: "Arab", css: "Cairo:wght@400;500;600;700" },
  { family: "Tajawal", category: "Arab", css: "Tajawal:wght@400;500;700" },
  { family: "Amiri", category: "Arab", css: "Amiri:wght@400;700" },
  { family: "Noto Naskh Arabic", category: "Arab", css: "Noto+Naskh+Arabic:wght@400;500;600;700" },
  { family: "Roboto", category: "Sans-serif", css: "Roboto:wght@300;400;500;700;900" },
  { family: "Open Sans", category: "Sans-serif", css: "Open+Sans:wght@300;400;500;600;700;800" },
  { family: "Lato", category: "Sans-serif", css: "Lato:wght@300;400;700;900" },
  { family: "Nunito", category: "Sans-serif", css: "Nunito:wght@300;400;600;700;800;900" },
  { family: "Raleway", category: "Sans-serif", css: "Raleway:wght@300;400;500;600;700;800" },
  { family: "Rubik", category: "Sans-serif", css: "Rubik:wght@300;400;500;600;700;800" },
  { family: "Work Sans", category: "Sans-serif", css: "Work+Sans:wght@300;400;500;600;700" },
  { family: "Manrope", category: "Sans-serif", css: "Manrope:wght@300;400;500;600;700;800" },
  { family: "Outfit", category: "Sans-serif", css: "Outfit:wght@300;400;500;600;700;800" },
  { family: "Urbanist", category: "Sans-serif", css: "Urbanist:wght@300;400;500;600;700;800" },
  { family: "Sora", category: "Sans-serif", css: "Sora:wght@300;400;500;600;700;800" },
  { family: "Lexend", category: "Sans-serif", css: "Lexend:wght@300;400;500;600;700" },
  { family: "Figtree", category: "Sans-serif", css: "Figtree:wght@300;400;500;600;700;800" },
  { family: "Barlow", category: "Sans-serif", css: "Barlow:wght@300;400;500;600;700;800" },
  { family: "Quicksand", category: "Sans-serif", css: "Quicksand:wght@300;400;500;600;700" },
  { family: "Mulish", category: "Sans-serif", css: "Mulish:wght@300;400;600;700;800" },
  { family: "Josefin Sans", category: "Sans-serif", css: "Josefin+Sans:wght@300;400;600;700" },
  { family: "Kanit", category: "Sans-serif", css: "Kanit:wght@300;400;500;600;700;800" },
  { family: "Space Grotesk", category: "Sans-serif", css: "Space+Grotesk:wght@300;400;500;600;700" },
  { family: "Noto Sans", category: "Sans-serif", css: "Noto+Sans:wght@300;400;500;600;700;800" },
  { family: "Merriweather", category: "Serif", css: "Merriweather:wght@300;400;700;900" },
  { family: "Libre Baskerville", category: "Serif", css: "Libre+Baskerville:wght@400;700" },
  { family: "Cormorant Garamond", category: "Serif", css: "Cormorant+Garamond:wght@300;400;500;600;700" },
  { family: "EB Garamond", category: "Serif", css: "EB+Garamond:wght@400;500;600;700;800" },
  { family: "PT Serif", category: "Serif", css: "PT+Serif:wght@400;700" },
  { family: "Bitter", category: "Serif", css: "Bitter:wght@300;400;500;600;700;800" },
  { family: "Fraunces", category: "Serif", css: "Fraunces:wght@300;400;500;600;700;800" },
  { family: "Noto Serif", category: "Serif", css: "Noto+Serif:wght@400;500;600;700" },
  { family: "Oswald", category: "Display", css: "Oswald:wght@300;400;500;600;700" },
  { family: "Anton", category: "Display", css: "Anton" },
  { family: "Archivo Black", category: "Display", css: "Archivo+Black" },
  { family: "Abril Fatface", category: "Display", css: "Abril+Fatface" },
  { family: "Righteous", category: "Display", css: "Righteous" },
  { family: "Bungee", category: "Display", css: "Bungee" },
  { family: "Lilita One", category: "Display", css: "Lilita+One" },
  { family: "Fredoka", category: "Display", css: "Fredoka:wght@300;400;500;600;700" },
  { family: "Luckiest Guy", category: "Display", css: "Luckiest+Guy" },
  { family: "Titan One", category: "Display", css: "Titan+One" },
  { family: "Alfa Slab One", category: "Display", css: "Alfa+Slab+One" },
  { family: "JetBrains Mono", category: "Monospace", css: "JetBrains+Mono:wght@300;400;500;600;700;800" },
  { family: "Fira Code", category: "Monospace", css: "Fira+Code:wght@300;400;500;600;700" },
  { family: "IBM Plex Mono", category: "Monospace", css: "IBM+Plex+Mono:wght@300;400;500;600;700" },
  { family: "Roboto Mono", category: "Monospace", css: "Roboto+Mono:wght@300;400;500;600;700" },
  { family: "Dancing Script", category: "Tulisan tangan", css: "Dancing+Script:wght@400;500;600;700" },
  { family: "Great Vibes", category: "Tulisan tangan", css: "Great+Vibes" },
  { family: "Satisfy", category: "Tulisan tangan", css: "Satisfy" },
  { family: "Kaushan Script", category: "Tulisan tangan", css: "Kaushan+Script" },
  { family: "Permanent Marker", category: "Tulisan tangan", css: "Permanent+Marker" },
  { family: "Shadows Into Light", category: "Tulisan tangan", css: "Shadows+Into+Light" },
  { family: "Indie Flower", category: "Tulisan tangan", css: "Indie+Flower" },
  { family: "Sacramento", category: "Tulisan tangan", css: "Sacramento" },
  { family: "Allura", category: "Tulisan tangan", css: "Allura" },
  { family: "Amatic SC", category: "Tulisan tangan", css: "Amatic+SC:wght@400;700" },
  { family: "Patrick Hand", category: "Tulisan tangan", css: "Patrick+Hand" },
];

export const GOOGLE_FONT_CATEGORIES = ["Sans-serif", "Serif", "Display", "Monospace", "Tulisan tangan", "Arab"];

const cssRequested = new Map();

/** Muat CSS satu family, lalu tunggu berkasnya siap dipakai di canvas. */
export function loadGoogleFont(family) {
  const def = GOOGLE_FONTS.find((f) => f.family === family);
  if (!def || typeof document === "undefined") return Promise.resolve(false);
  if (cssRequested.has(family)) return cssRequested.get(family);
  const p = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${def.css}&display=swap`;
    link.onload = () => {
      const spec = `400 32px "${family}"`;
      (document.fonts?.load ? document.fonts.load(spec, "AaBbCc 123") : Promise.resolve())
        .then(() => resolve(true))
        .catch(() => resolve(false));
    };
    link.onerror = () => { cssRequested.delete(family); resolve(false); };
    document.head.appendChild(link);
  });
  cssRequested.set(family, p);
  return p;
}

/** nilai fontFamily yang disimpan di klip */
export const googleFontValue = (family) => `"${family}", sans-serif`;
export const googleFamilyOf = (value) => {
  const m = /^"([^"]+)"/.exec(value || "");
  return m && GOOGLE_FONTS.some((f) => f.family === m[1]) ? m[1] : null;
};
