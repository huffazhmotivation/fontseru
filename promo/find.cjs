// cari posisi (fraksi) elemen kunci langsung di aplikasi, pada ukuran 1680x1050
module.exports = async ({ go, ev, files, sleep }) => {
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await files('input[type=file]', __dirname + '/Ravager.fs');
  await sleep(9000);
  const box = (expr) => ev(`(()=>{const e=${expr}; if(!e) return null; const b=e.getBoundingClientRect(); return [+((b.x+b.width/2)/1680).toFixed(4), +((b.y+b.height/2)/1050).toFixed(4)]})()`);
  console.log('mlbtn', await box(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Multilingual Glyphs'))`));
  console.log('tabs', await box(`document.querySelector('[data-testid=mode-tab-font]')`), await box(`document.querySelector('[data-testid=mode-tab-design]')`), await box(`document.querySelector('[data-testid=mode-tab-motion]')`));
  await ev(`document.querySelector('[data-testid="glyph-tile-R"]').click(); true`); await sleep(800);
  console.log('glyphR', await box(`document.querySelector('.fm-canvas-area svg path[fill]:not([fill=none])')`));
  await ev(`document.querySelector('[data-testid="family-btn"]').click(); true`); await sleep(1500);
  console.log('autobold', await box(`document.querySelector('[data-testid=auto-bold-btn]')`));
  console.log('famtabs', JSON.stringify(await ev(`[...document.querySelectorAll('[data-testid^=generate-family-tab-]')].map(e=>{const b=e.getBoundingClientRect(); return [e.textContent.trim(), +((b.x+b.width/2)/1680).toFixed(3), +((b.y+b.height/2)/1050).toFixed(3)]})`)));
  await ev(`document.querySelector('[data-testid="family-auto-close"]').click(); true`); await sleep(500);
  await ev(`document.querySelector('[data-testid="test-lab-btn"]').click(); true`); await sleep(1500);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Kerning Pairs').click(); true`); await sleep(800);
  console.log('autokern', await box(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Auto Kerning'))`));
};
