import opentype from '../node_modules/opentype.js/dist/opentype.module.js';
import fs from 'fs';
const b=fs.readFileSync('StackSansNotch.ttf');const f=opentype.parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
const keep=new Set();
for(let c=0x20;c<=0x7e;c++) keep.add(c);
for(const c of [0xB4,0x60,0xA8,0x2C6,0x2DC,0x2C7,0xB8,0x2DB,0x2D8,0x2DA,0x2D9,0x2DD,0xAF]) keep.add(c);
for(let c=0x300;c<=0x328;c++) keep.add(c);
const glyphs=[f.glyphs.get(0)];
for(let i=1;i<f.glyphs.length;i++){const g=f.glyphs.get(i); if(g.unicode!==undefined && keep.has(g.unicode)) glyphs.push(g);}
const nf=new opentype.Font({familyName:'Stack Sans Notch',styleName:'Regular',unitsPerEm:f.unitsPerEm,ascender:f.ascender,descender:f.descender,glyphs});
fs.writeFileSync('StackSansBasic.ttf',Buffer.from(nf.toArrayBuffer()));
console.log('glyphs',glyphs.length);
