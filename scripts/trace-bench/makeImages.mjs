// Trace bench — test image generator.
//
// Renders hard letterforms from real fonts into PNG/JPG test images and
// stores the exact vector outline each image was rendered from (ground
// truth), so the tracer can be scored objectively: how far the traced
// outline sits from the true one (px), and how many nodes it needed
// compared with the type designer's own drawing.
//
// Usage: node scripts/trace-bench/makeImages.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";

const OUT = process.argv[2] || "trace-bench-out";
fs.mkdirSync(path.join(OUT, "images"), { recursive: true });

const SUP = "/System/Library/Fonts/Supplemental";
const USER = `${process.env.HOME}/Library/Fonts`;

// Hard cases on purpose: swashes that cross themselves (Zapfino), hairline
// serifs (Big Caslon), connected script, a rough textured face
// (Chalkduster), stencil-like gaps, and a line of mixed marks for the
// letter-grouping check (dots, accents, %, ?, !).
const CASES = [
  { id: "zapfino-g", font: `${SUP}/Zapfino.ttf`, text: "g" },
  { id: "zapfino-Q", font: `${SUP}/Zapfino.ttf`, text: "Q" },
  { id: "caslon-amp", font: `${SUP}/BigCaslon.ttf`, text: "&" },
  { id: "caslon-Rg", font: `${SUP}/BigCaslon.ttf`, text: "Rg" },
  { id: "timesbi-amp", font: `${SUP}/Times New Roman Bold Italic.ttf`, text: "&" },
  { id: "brush-word", font: `${SUP}/Brush Script.ttf`, text: "Fontseru" },
  { id: "chancery-Ag", font: `${SUP}/Apple Chancery.ttf`, text: "Ag" },
  { id: "chalk-R", font: `${SUP}/Chalkduster.ttf`, text: "R" },
  { id: "trattatello-M", font: `${SUP}/Trattatello.ttf`, text: "M" },
  { id: "herculanum-W", font: `${SUP}/Herculanum.ttf`, text: "W" },
  { id: "allura-S", font: `${USER}/Allura-Regular.ttf`, text: "S" },
  { id: "georgia-at", font: `${SUP}/Georgia Bold Italic.ttf`, text: "@" },
  { id: "luminari-K", font: `${SUP}/Luminari.ttf`, text: "K" },
  { id: "times-marks", font: `${SUP}/Times New Roman.ttf`, text: "jiÄé%?!" },
  { id: "georgia-B8", font: `${SUP}/Georgia.ttf`, text: "B8" },
];

// clean: crisp anti-aliased export. small: a low-res upload.
// photo: blurred + noisy + JPEG + off-white paper, like a phone photo.
const VARIANTS = [
  { id: "clean", em: 700, blur: 0, noise: 0, jpeg: 0, paper: 255 },
  { id: "small", em: 150, blur: 0, noise: 0, jpeg: 0, paper: 255 },
  { id: "photo", em: 600, blur: 1.1, noise: 9, jpeg: 62, paper: 232 },
];

function pathToD(commands) {
  return commands
    .map((c) => {
      if (c.type === "M") return `M${c.x.toFixed(3)} ${c.y.toFixed(3)}`;
      if (c.type === "L") return `L${c.x.toFixed(3)} ${c.y.toFixed(3)}`;
      if (c.type === "Q") return `Q${c.x1.toFixed(3)} ${c.y1.toFixed(3)} ${c.x.toFixed(3)} ${c.y.toFixed(3)}`;
      if (c.type === "C") return `C${c.x1.toFixed(3)} ${c.y1.toFixed(3)} ${c.x2.toFixed(3)} ${c.y2.toFixed(3)} ${c.x.toFixed(3)} ${c.y.toFixed(3)}`;
      return "Z";
    })
    .join("");
}

// On-curve point count of the original drawing (what a type designer
// placed), for the "how many nodes vs. the original" comparison.
function onCurveNodes(commands) {
  let n = 0;
  let contours = 0;
  let pendingStart = null;
  for (const c of commands) {
    if (c.type === "M") { contours++; pendingStart = c; n++; }
    else if (c.type === "Z") { pendingStart = null; }
    else {
      // a closing segment that lands exactly on the start point is not a new node
      n++;
    }
  }
  // Remove duplicate closing points (L/Q/C back onto the M point).
  let dup = 0;
  let start = null;
  let last = null;
  for (const c of commands) {
    if (c.type === "M") start = c;
    if (c.type === "Z" && start && last && Math.abs(last.x - start.x) < 1e-6 && Math.abs(last.y - start.y) < 1e-6 && last !== start) dup++;
    if (c.type !== "Z") last = c;
  }
  return { nodes: n - dup, contours };
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const manifest = [];
for (const c of CASES) {
  if (!fs.existsSync(c.font)) { console.warn("skip (font missing):", c.font); continue; }
  const font = opentype.loadSync(c.font);
  for (const v of VARIANTS) {
    const p0 = font.getPath(c.text, 0, 0, v.em);
    const bb = p0.getBoundingBox();
    const margin = Math.round(v.em * 0.08) + 4;
    const w = Math.ceil(bb.x2 - bb.x1) + margin * 2;
    const h = Math.ceil(bb.y2 - bb.y1) + margin * 2;
    const dx = margin - bb.x1;
    const dy = margin - bb.y1;
    const p = font.getPath(c.text, dx, dy, v.em);
    const d = pathToD(p.commands);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="rgb(${v.paper},${v.paper},${Math.max(0, v.paper - 6)})"/><path d="${d}" fill="#111"/></svg>`;
    let img = sharp(Buffer.from(svg));
    if (v.blur > 0) img = img.blur(v.blur);
    let { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    if (v.noise > 0) {
      const rnd = mulberry(w * 31 + h);
      for (let i = 0; i < data.length; i++) {
        if (info.channels === 4 && i % 4 === 3) continue;
        const g = (rnd() + rnd() + rnd() - 1.5) * v.noise * 1.4;
        data[i] = Math.max(0, Math.min(255, data[i] + g));
      }
    }
    const raw = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const ext = v.jpeg ? "jpg" : "png";
    const file = `${c.id}--${v.id}.${ext}`;
    if (v.jpeg) await raw.jpeg({ quality: v.jpeg }).toFile(path.join(OUT, "images", file));
    else await raw.png().toFile(path.join(OUT, "images", file));
    const gt = onCurveNodes(p.commands);
    manifest.push({ id: `${c.id}--${v.id}`, file: `images/${file}`, width: w, height: h, d, gtNodes: gt.nodes, gtContours: gt.contours, text: c.text, variant: v.id });
  }
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`wrote ${manifest.length} images to ${OUT}`);
