module.exports = async ({ go, ev, shot, sleep, win }) => {
  const dbg = win.webContents.debugger;
  const fs = require('fs');
  let n = 0;
  const frame = async () => { await shot('brush/f' + String(n++).padStart(3, '0')); };
  const mv = (type, x, y, buttons) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force: 0.6 });
  const stroke = async (pts, every = 2) => {
    await mv('mouseMoved', pts[0][0], pts[0][1], 0);
    await mv('mousePressed', pts[0][0], pts[0][1], 1);
    for (let i = 1; i < pts.length; i++) { await mv('mouseMoved', pts[i][0], pts[i][1], 1); if (i % every === 0) await frame(); }
    await mv('mouseReleased', pts[pts.length - 1][0], pts[pts.length - 1][1], 0);
    await sleep(350); await frame(); await frame();
  };
  const line = (a, b, k = 26) => Array.from({ length: k + 1 }, (_, i) => { const t = i / k, e = t * t * (3 - 2 * t); return [a[0] + (b[0] - a[0]) * e + Math.sin(t * 3.1) * 2, a[1] + (b[1] - a[1]) * e]; });
  fs.mkdirSync(__dirname + '/shots/brush', { recursive: true });
  await go('app://local/index.html?tablet=1', 1180, 820);
  await ev(`localStorage.setItem('fontseru.appMode','font'); true`);
  await go('app://local/index.html?tablet=1', 1180, 820);
  await sleep(1200);
  await ev(`document.querySelector('[data-testid="tool-brush"]').click(); true`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('.fm-brush-card')].find(b=>b.textContent.includes('Calligraphic')).click(); true`);
  await sleep(300);
  // bigger brush
  await ev(`(()=>{const r=[...document.querySelectorAll('.fm-rightpanel input[type=range]')][0]; if(!r) return 0; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'46'); r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); return r.value})()`);
  await sleep(400);
  await frame(); await frame();
  await stroke(line([488, 252], [352, 536]));
  await stroke(line([490, 252], [626, 536]));
  await stroke(line([414, 442], [566, 442], 18));
  for (let i = 0; i < 6; i++) await frame();
  // O with oil brush
  await ev(`document.querySelector('[data-testid="glyph-tile-O"]').click(); true`);
  await sleep(500);
  await ev(`[...document.querySelectorAll('.fm-brush-card')].find(b=>b.textContent.includes('Oil Brush')).click(); true`);
  await sleep(300);
  await ev(`(()=>{const r=[...document.querySelectorAll('.fm-rightpanel input[type=range]')][0]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'70'); r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); return r.value})()`);
  await sleep(300);
  await frame(); await frame();
  const cx = 501, cy = 398, rx = 128, ry = 140;
  const circ = Array.from({ length: 49 }, (_, i) => { const a = -Math.PI / 2 - (i / 48) * Math.PI * 2.04; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
  await stroke(circ, 2);
  for (let i = 0; i < 6; i++) await frame();
  console.log('frames', n);
};
