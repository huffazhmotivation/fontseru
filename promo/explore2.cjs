module.exports = async ({ go, ev, shot, sleep }) => {
  await go('app://local/index.html?tablet=1', 1180, 820);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html?tablet=1', 1180, 820);
  await sleep(1500);
  await ev(`document.querySelector('[data-testid="tool-brush"]').click(); true`);
  await sleep(600);
  const r = await ev(`JSON.stringify([...document.querySelectorAll('.fm-canvas-area *')].filter(e=>e.children.length===0 && /^(Cap Height|Baseline|x-Height|Ascender|Descender)$/.test(e.textContent.trim())).map(e=>{const b=e.getBoundingClientRect();return [e.textContent.trim(),Math.round(b.x),Math.round(b.y)]}))`);
  console.log(r);
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('.fm-canvas-area *')].filter(e=>e.children.length===0 && /LSB|Advance/.test(e.textContent)).map(e=>{const b=e.getBoundingClientRect();return [e.textContent.trim(),Math.round(b.x),Math.round(b.y),Math.round(b.width)]}))`));
  await shot('x-tab-brush');
};
