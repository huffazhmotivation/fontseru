const btn = (txt) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(txt)})`;
module.exports = async ({ go, ev, files, shot, sleep }) => {
  /* ---------- multilingual (Ravager tanpa huruf beraksen) ---------- */
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await files('input[type=file]', __dirname + '/Ravager-basic.fs');
  await sleep(9000);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-a"]').click(); true`);
  await sleep(600);
  const sc = `[...document.querySelectorAll('.fm-glyphnav *')].find(e=>e.scrollHeight>e.clientHeight+20 && getComputedStyle(e).overflowY!=='visible')`;
  await ev(`(${sc}).scrollTop=99999; true`); await sleep(500);
  await shot('rm-0');
  console.log('before', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`));
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Multilingual Glyphs')).click(); true`); await sleep(1200);
  await shot('rm-1');
  console.log('after', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`), await ev(`document.querySelector('.fm-glyphnav').innerText.split('\\n').slice(-1)[0]`));
  const H = await ev(`(()=>{const e=${sc}; return [e.scrollTop,e.scrollHeight,e.clientHeight]})()`);
  const from = H[0], to = H[1] - H[2];
  for (let i = 1; i <= 16; i++) { await ev(`(${sc}).scrollTop=${Math.round(from + ((to - from) * i) / 16)}; true`); await sleep(150); await shot('rm-s' + String(i).padStart(2, '0')); }
  await ev(`document.querySelector('[data-testid="glyph-tile-Ö"]')?.click(); true`); await sleep(800);
  await shot('rm-2');
  await ev(`document.querySelector('[data-testid="glyph-view-multi"]').click(); true`); await sleep(2000);
  await shot('rm-3');
  await ev(`document.querySelector('[data-testid="glyph-view-single"]').click(); true`); await sleep(500);

  /* ---------- kerning (Ravager penuh) ---------- */
  await go('app://local/index.html', 1680, 1050);
  await ev(`window.confirm=()=>true; true`);
  await files('input[type=file]', __dirname + '/Ravager.fs');
  await sleep(9000);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); true`);
  for (const [ch, d] of [['A', 120], ['V', 140], ['T', -60], ['o', 100], ['W', -50], ['a', 90], ['Y', 130], ['L', 110]]) {
    await ev(`document.querySelector('[data-testid="glyph-tile-${ch}"]').click(); true`); await sleep(400);
    await ev(`document.querySelector('[data-testid=tool-home]')?.click(); true`); await sleep(300);
    console.log(ch, await ev(`(()=>{document.querySelector('[data-testid=spacing-mode-manual]')?.click(); const el=document.querySelector('input[data-testid=rsb]'); if(!el) return 'no'; const v=+el.value + ${d}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(v)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); el.blur(); return v})()`));
    await sleep(300);
  }
  await ev(`document.querySelector('[data-testid=tool-select]')?.click(); true`);
  await ev(`document.querySelector('[data-testid="test-lab-btn"]').click(); true`); await sleep(2000);
  await ev(`${btn('Kerning Pairs')}.click(); true`); await sleep(1500);
  await shot('rk-0');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Auto Kerning')).click(); true`);
  const t0 = Date.now(); let n = 0;
  for (let i = 0; i < 600; i++) {
    const t = await ev(`[...document.querySelectorAll('button')].find(b=>/Auto Kerning|Kerning…/.test(b.textContent))?.textContent`);
    if (i % 3 === 0 && n < 8) { await shot('rk-p' + (++n)); }
    if (/^\s*Auto Kerning/.test(t) && i > 2) break;
    await sleep(700);
  }
  console.log('kern secs', (Date.now() - t0) / 1000);
  await sleep(1000);
  await shot('rk-1');
};
