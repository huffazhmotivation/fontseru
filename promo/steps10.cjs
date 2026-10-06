module.exports = async ({ go, ev, files, shot, sleep }) => {
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await files('input[type=file]', __dirname + '/StackSansBasic.ttf');
  await sleep(4000);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-a"]').click(); true`);
  await sleep(600);
  const sc = `[...document.querySelectorAll('.fm-glyphnav *')].find(e=>e.scrollHeight>e.clientHeight+20 && getComputedStyle(e).overflowY!=='visible')`;
  await ev(`(${sc}).scrollTop=99999; true`);
  await sleep(500);
  await shot('mlb-0');
  console.log('count before', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`));
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Multilingual Glyphs')).click(); true`);
  await sleep(900);
  await shot('mlb-1');
  console.log('count after', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`), await ev(`document.querySelector('.fm-glyphnav').innerText.split('\\n').slice(-3).join(' | ')`));
  // scroll down through the new glyphs
  const H = await ev(`(()=>{const e=${sc}; return [e.scrollTop,e.scrollHeight,e.clientHeight]})()`);
  console.log('scroll', H);
  const from = H[0], to = H[1] - H[2];
  for (let i = 1; i <= 14; i++) { await ev(`(${sc}).scrollTop=${Math.round(from + ((to - from) * i) / 14)}; true`); await sleep(120); await shot('mlb-s' + String(i).padStart(2, '0')); }
  await ev(`(()=>{const t=[...document.querySelectorAll('[data-testid^=glyph-tile-]')].find(b=>b.dataset.testid==='glyph-tile-Ș'||b.dataset.testid==='glyph-tile-Ă'||b.dataset.testid==='glyph-tile-É'); t&&t.click(); return t&&t.dataset.testid})()`).then(console.log);
  await sleep(800);
  await shot('mlb-2');
  await ev(`document.querySelector('[data-testid="glyph-view-multi"]').click(); true`);
  await sleep(1500);
  await shot('mlb-3');
};
