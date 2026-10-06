// Ambil screenshot asli FontSeru (dev server) dalam resolusi tinggi untuk video promo.
// Pakai: electron capture.cjs <steps.cjs>
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
// app:// = aplikasi desktop hasil build (desktop/dist): sama persis dengan versi terpasang, semua fitur Pro aktif
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const DIST = path.join(__dirname, '..', 'desktop', 'dist');
app.setPath('userData', path.join(require('os').tmpdir(), 'fs-promo-' + Date.now()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    return net.fetch(pathToFileURL(path.join(DIST, rel)).toString());
  });
  const stepsFile = path.resolve(process.argv[process.argv.length - 1]);
  const steps = require(stepsFile);
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, useContentSize: true, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  win.webContents.session.on('will-download', (e, item) => { fs.mkdirSync(path.join(__dirname, 'dl'), { recursive: true }); item.setSavePath(path.join(__dirname, 'dl', item.getFilename())); console.log('download', item.getFilename()); });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const api = {
    win,
    sleep,
    async go(url, w = 1680, h = 1050, dsf = 2) {
      win.setContentSize(w, h);
      await win.loadURL(url);
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
      await sleep(2500);
    },
    async size(w, h, touch = false) {
      win.setContentSize(w, h);
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
      await sleep(600);
    },
    key: async (key, code) => {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key.length === 1 ? key : undefined });
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
    },
    ev: (js) => win.webContents.executeJavaScript(js, true),
    async files(selector, file) {
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    },
    async shot(name) {
      await sleep(400);
      const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, 'shots', name + '.png'), Buffer.from(data, 'base64'));
      console.log('shot', name);
    },
  };
  try { await steps(api); } catch (e) { console.error('ERR', e); }
  app.quit();
});
