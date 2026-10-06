import opentype from '../node_modules/opentype.js/dist/opentype.module.js';
import fs from 'fs';
const b=fs.readFileSync('StackSansNotch.ttf');const f=opentype.parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
const out={};
for (const ch of ['S','F','a','g','R']) {
  const p=f.getPath(ch,0,0,1000); const bb=p.getBoundingBox();
  const q=f.getPath(ch,-bb.x1,-bb.y1,1000);
  out[ch]={d:q.toPathData(1),w:Math.round(bb.x2-bb.x1),h:Math.round(bb.y2-bb.y1)};
}
fs.writeFileSync('glyphs.json',JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).map(([k,v])=>[k,[v.w,v.h,v.d.length]])));
