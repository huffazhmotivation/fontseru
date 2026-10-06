// Render promo.html → PNG stills or MP4 (H.264 1080p30 + musik sintetis) memakai Electron + mediabunny (WebCodecs).
// electron render.cjs stills 1.5,4.8,...   |   electron render.cjs video out.mp4
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(require('os').tmpdir(), 'fs-promo-render'));
const FPS = 30, W = 1920, H = 1080;
let DUR = 30;
app.whenReady().then(async () => {
  const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('render.cjs')) + 1);
  const mode = args[0];
  const page = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, paintWhenInitiallyHidden: true, webPreferences: { webSecurity: false, backgroundThrottling: false } });
  page.setContentSize(W, H);
  const PAGE = process.env.PROMO_PAGE || 'promo.html';
  await page.loadURL('file://' + path.join(__dirname, PAGE) + '?render=1');
  console.log('loaded');
  page.webContents.on('console-message', (e, l, m) => { if (!/Security Warning/.test(m)) console.log('page:', m); });
  await page.webContents.executeJavaScript('Promise.race([window.__ready,new Promise(r=>setTimeout(r,8000))])');
  console.log('ready');
  await page.webContents.executeJavaScript('new Promise(r=>{const c=()=>window.__glyphReady?r():setTimeout(c,50);c();})');
  console.log('glyph');
  DUR = await page.webContents.executeJavaScript('DUR');
  await page.webContents.executeJavaScript('window.__prewarm()');
  console.log('warm');
  const frameAt = async (t) => {
    await page.webContents.executeJavaScript(`window.__render(${t}).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,16)))))`);
    return page.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
  };
  if (mode === 'stills') {
    fs.mkdirSync(path.join(__dirname, 'stills'), { recursive: true });
    for (const t of args[1].split(',').map(Number)) {
      console.log('still', t);
      const img = await frameAt(t);
      fs.writeFileSync(path.join(__dirname, 'stills', `t${t.toFixed(2)}.png`), img.resize({ width: 960 }).toPNG());
    }
    app.quit();
    return;
  }
  const out = path.resolve(args[1] || 'promo.mp4');
  const enc = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false } });
  await enc.loadURL('file://' + path.join(__dirname, 'encoder.html'));
  await enc.webContents.executeJavaScript(`window.encInit(${W},${H},${FPS},${DUR},${JSON.stringify(process.env.PROMO_HITS || '')})`);
  const total = FPS * DUR;
  for (let i = 0; i < total; i++) {
    const img = await frameAt(i / FPS);
    const bmp = img.toBitmap(); // BGRA
    await new Promise((res) => { ipcMain.once('ack', res); enc.webContents.send('frame', i, bmp); });
    if (i % 30 === 0) console.log('frame', i, '/', total);
  }
  const bytes = await enc.webContents.executeJavaScript('window.encFinish()');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log('OK', out, fs.statSync(out).size);
  app.quit();
});
