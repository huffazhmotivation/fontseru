const setVal = (expr, v) => `(()=>{const el=${expr}; if(!el) return 'missing'; const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'})()`;
const btn = (txt) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(txt)})`;
const esc = `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`;
module.exports = async ({ go, ev, files, shot, sleep, key }) => {
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await ev(`window.confirm=()=>true; true`);
  await files('input[type=file]', __dirname + '/Ravager.fs');
  await sleep(9000);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-R"]').click(); true`);
  await sleep(1000);
  await shot('r-select');
  await key('n', 'KeyN'); await sleep(700);
  await shot('r-node');
  await key('v', 'KeyV'); await sleep(300);
  // test lab
  await ev(`document.querySelector('[data-testid="test-lab-btn"]').click(); true`); await sleep(2000);
  await ev(`${btn('Pangrams')}.click(); true`); await sleep(1500); await shot('r-pangram');
  await ev(`${btn('Feature')}.click(); true`); await sleep(1500); await shot('r-labfeature');
  await ev(esc); await ev(`document.querySelector('[title^="Close"]')?.click(); true`); await sleep(800);
  // feature builder
  await ev(`document.querySelector('[data-testid="feature-builder-btn"]').click(); true`); await sleep(1500);
  await shot('r-feat');
  await ev(`document.querySelector('[data-testid="feature-builder-close"]').click(); true`); await sleep(600);
  // family
  await ev(`document.querySelector('[data-testid="family-btn"]').click(); true`); await sleep(2000);
  await shot('r-f0');
  await ev(`document.querySelector('[data-testid="auto-bold-btn"]').click(); true`);
  for (let i = 1; i <= 4; i++) { await sleep(300); await shot('r-fbp' + i); }
  await sleep(4000);
  await shot('r-f1');
  await ev(`[...document.querySelectorAll('[data-testid^=generate-family-tab-]')].pop().click(); true`); await sleep(800);
  await shot('r-f2');
  await ev(`document.querySelector('[data-testid="family-auto-close"]').click(); true`); await sleep(600);
  // multilingual
  const sc = `[...document.querySelectorAll('.fm-glyphnav *')].find(e=>e.scrollHeight>e.clientHeight+20 && getComputedStyle(e).overflowY!=='visible')`;
  await ev(`document.querySelector('[data-testid="glyph-tile-a"]').click(); true`); await sleep(500);
  console.log('count before', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`));
  await ev(`(${sc}).scrollTop=99999; true`); await sleep(500);
  await shot('r-ml0');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Multilingual Glyphs')).click(); true`); await sleep(1200);
  await shot('r-ml1');
  console.log('count after', await ev(`document.querySelector('.fm-glyphnav').innerText.match(/\\d+\\/\\d+/)?.[0]`), await ev(`document.querySelector('.fm-glyphnav').innerText.split('\\n').slice(-2).join(' | ')`));
  // export dialog + real TTF export (for Motion)
  await ev(`window.showSaveFilePicker = undefined; document.querySelector('.fm-filemenu-wrap button').click(); true`); await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Export Font')).click(); true`); await sleep(1500);
  await shot('r-export');
  await ev(`${btn('TTF')}?.click(); true`); await sleep(300);
  await ev(`[...document.querySelectorAll('button')].find(b=>/^Export /.test(b.textContent.trim()) && !b.textContent.includes('Font'))?.click(); true`);
  await sleep(8000);
  await ev(esc); await sleep(600);
  console.log('after export');
};
