const setVal = (expr, v) => `(()=>{const el=${expr}; if(!el) return 'missing'; const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'})()`;
const btn = (txt, root = 'document') => `[...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(txt)})`;
module.exports = async ({ go, ev, files, shot, sleep }) => {
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await ev(`window.confirm=()=>true; window.alert=()=>{}; true`);
  await files('input[type=file]', __dirname + '/StackSansNotch.ttf');
  await sleep(4500);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); document.querySelector('[data-testid="glyph-tile-a"]').click(); true`);
  await sleep(500);

  /* ---- auto kerning ---- */
  await ev(`document.querySelector('[data-testid="test-lab-btn"]').click(); true`);
  await sleep(1500);
  await ev(`${btn('Kerning Pairs')}.click(); true`);
  await sleep(800);
  await ev(`window.confirm=()=>true; ${btn('Clear All')}?.click(); true`);
  await sleep(1000);
  await shot('kern-0');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Auto Kerning')).click(); true`);
  for (let i = 1; i <= 6; i++) { await sleep(250); await shot('kern-p' + i); }
  await sleep(2500);
  await shot('kern-1');
  await ev(`document.querySelector('.fm-lab-close, [title^="Close"]')?.click(); true`);
  await sleep(300);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
  await sleep(800);

  /* ---- multilingual ---- */
  await shot('ml-0');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Multilingual Glyphs')).click(); true`);
  await sleep(1500);
  await shot('ml-1');
  await ev(`document.querySelector('[data-testid="glyph-view-multi"]').click(); true`);
  await sleep(1200);
  console.log('filters', await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=glyph-view-filter] option')].map(o=>o.value+':'+o.textContent))`));
  await ev(setVal(`document.querySelector('[data-testid=glyph-view-filter]')`, 'multilingual'));
  await sleep(1200);
  await shot('ml-2');
  await ev(`document.querySelector('[data-testid="glyph-view-single"]').click(); true`);
  await sleep(600);

  /* ---- custom family + auto family ---- */
  await ev(`document.querySelector('.fm-family-add-btn').click(); true`);
  await sleep(400);
  console.log('addfam', await ev(setVal(`document.querySelector('[data-testid=add-family-form] input')`, 'Black')));
  await sleep(200);
  await ev(`document.querySelector('[data-testid=add-family-confirm]').click(); true`);
  await sleep(600);
  await ev(`document.querySelector('[data-testid="family-btn"]').click(); true`);
  await sleep(1500);
  await shot('fam-0');
  await ev(`document.querySelector('[data-testid="auto-bold-btn"]').click(); true`);
  for (let i = 1; i <= 4; i++) { await sleep(300); await shot('fam-bp' + i); }
  await sleep(2500);
  await shot('fam-1');
  await ev(`document.querySelector('[data-testid="generate-family-tab-italic"]').click(); true`);
  await sleep(600);
  await ev(`document.querySelector('[data-testid="auto-italic-btn"]').click(); true`);
  await sleep(3500);
  await shot('fam-2');
  console.log('tabs', await ev(`JSON.stringify([...document.querySelectorAll('[data-testid^=generate-family-tab-]')].map(b=>b.dataset.testid))`));
  await ev(`[...document.querySelectorAll('[data-testid^=generate-family-tab-]')].pop().click(); true`);
  await sleep(600);
  await ev(`(()=>{const rs=[...document.querySelectorAll('[data-testid^=generate-panel-] input[type=range]')]; window.__w=rs[0]; window.__s=rs[1]; return rs.length})()`);
  await ev(setVal('window.__w', '110'));
  await ev(setVal('window.__s', '10'));
  await sleep(800);
  await shot('fam-3');
  await ev(`document.querySelector('[data-testid^=auto-generate-][data-testid$=-btn]').click(); true`);
  await sleep(3500);
  await ev(`document.querySelector('[data-testid=family-panel-previews]').scrollTop=9999; true`);
  await sleep(600);
  await shot('fam-4');
  await ev(`document.querySelector('[data-testid="family-auto-close"]').click(); true`);
  await sleep(600);

  /* ---- feature builder ---- */
  await ev(`document.querySelector('[data-testid="feature-builder-btn"]').click(); true`);
  await sleep(1200);
  const sels = `[...document.querySelectorAll('[data-testid=feature-builder-overlay] select')]`;
  console.log('opts', await ev(`JSON.stringify(${sels}[0] && [...${sels}[0].options].slice(0,5).map(o=>o.value))`));
  console.log(await ev(setVal(`${sels}[0]`, 'f')), await ev(setVal(`${sels}[1]`, 'i')));
  await sleep(300);
  console.log(await ev(setVal(`document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-input')[0]`, 'ﬁ')));
  await sleep(400);
  await ev(`[...document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-section')][0].querySelectorAll('button').forEach(b=>{if(b.textContent.includes('Preview'))b.click()}); true`);
  await sleep(600);
  await shot('feat-1');
  await ev(`[...[...document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-section')][0].querySelectorAll('button')].find(b=>b.textContent.trim()==='Add')?.click(); true`);
  await sleep(500);
  console.log(await ev(setVal(`${sels}[2]`, 'a')));
  await sleep(300);
  console.log(await ev(setVal(`document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-input')[1]`, 'ɑ')));
  await sleep(400);
  await ev(`[...document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-section')][1].querySelectorAll('button').forEach(b=>{if(b.textContent.includes('Preview'))b.click()}); true`);
  await sleep(600);
  await shot('feat-2');
  await ev(`[...[...document.querySelectorAll('[data-testid=feature-builder-overlay] .fm-feature-section')][1].querySelectorAll('button')].find(b=>b.textContent.trim()==='Add')?.click(); true`);
  await sleep(800);
  await shot('feat-3');
};
