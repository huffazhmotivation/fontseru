module.exports = async ({ go, ev, files, shot, sleep }) => {
  const W = 1920, H = 1200, D = 1.75;
  await go('app://local/index.html', W, H, D);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', W, H, D);
  await files('input[type=file]', __dirname + '/Ravager.fs');
  await sleep(9000);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-R"]').click(); true`);
  await sleep(800);
  await ev(`document.querySelector('[data-testid="family-btn"]').click(); true`); await sleep(2000);
  const box = (expr) => ev(`(()=>{const e=${expr}; if(!e) return null; const b=e.getBoundingClientRect(); return [+((b.x+b.width/2)/${W}).toFixed(4), +((b.y+b.height/2)/${H}).toFixed(4), Math.round(b.height)]})()`);
  // scroll the overlay body so the Auto Bold button is on screen
  await ev(`(()=>{const b=document.querySelector('[data-testid=auto-bold-btn]'); b.scrollIntoView({block:'end'}); return true})()`); await sleep(500);
  console.log('autobold', await box(`document.querySelector('[data-testid=auto-bold-btn]')`), 'boldrow', await box(`document.querySelector('[data-testid=family-auto-preview-bold]')`));
  await shot('rf-0');
  await ev(`document.querySelector('[data-testid="auto-bold-btn"]').click(); true`);
  for (let i = 1; i <= 4; i++) { await sleep(350); await shot('rf-p' + i); }
  await sleep(4000);
  await shot('rf-1');
  const tabs = await ev(`JSON.stringify([...document.querySelectorAll('[data-testid^=generate-family-tab-]')].map(e=>{const b=e.getBoundingClientRect(); return [e.textContent.trim(), +((b.x+b.width/2)/${W}).toFixed(3), +((b.y+b.height/2)/${H}).toFixed(3)]}))`);
  console.log('tabs', tabs);
  await ev(`[...document.querySelectorAll('[data-testid^=generate-family-tab-]')].pop().click(); true`); await sleep(900);
  await ev(`document.querySelector('[data-testid^=auto-generate-][data-testid$=-btn]')?.scrollIntoView({block:'end'}); true`); await sleep(400);
  await shot('rf-2');
};
