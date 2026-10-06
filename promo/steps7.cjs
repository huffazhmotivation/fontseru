const btn = (txt) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(txt)})`;
module.exports = async ({ go, ev, files, shot, sleep, win }) => {
  const dbg = win.webContents.debugger;
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: 'left', buttons: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
  };
  await go('app://local/index.html', 1680, 1050);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html', 1680, 1050);
  await files('input[type=file]', __dirname + '/StackSansNotch.ttf');
  await sleep(4500);
  await ev(`document.querySelectorAll('[class*=toast] button').forEach(b=>b.click()); true`);
  for (const [ch, d] of [['A', 140], ['V', 160], ['T', -70], ['o', 120], ['W', -60], ['a', 110], ['Y', 150], ['L', 120]]) {
    await ev(`document.querySelector('[data-testid="glyph-tile-${ch}"]').click(); true`);
    await sleep(400);
    await ev(`document.querySelector('[data-testid=tool-home]')?.click(); true`); await sleep(300);
    const r = await ev(`(()=>{document.querySelector('[data-testid=spacing-mode-manual]')?.click(); const el=document.querySelector('input[data-testid=rsb]'); if(!el) return 'no-rsb'; const v=+el.value + ${d}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(v)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); el.blur(); return v})()`);
    await sleep(300);
    console.log(ch, r, await ev(`document.querySelector('input[data-testid=rsb]')?.value`));
  }
  await ev(`document.querySelector('[data-testid="test-lab-btn"]').click(); true`);
  await sleep(1500);
  await ev(`${btn('Kerning Pairs')}.click(); true`);
  await sleep(1000);
  await shot('k2-0');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Auto Kerning')).click(); true`);
  for (let i = 1; i <= 8; i++) { await sleep(400); await shot('k2-p' + i); }
  for (let i = 0; i < 120; i++) { const t = await ev(`[...document.querySelectorAll('button')].find(b=>/Auto Kerning|Kerning…/.test(b.textContent))?.textContent`); if (i % 10 === 0) console.log(t); if (/^\s*Auto Kerning/.test(t)) break; await sleep(500); }
  await sleep(800);
  await shot('k2-1');
};
