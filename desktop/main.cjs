// FontSeru desktop: memuat aplikasi web hasil build dari dalam paket (offline) lewat skema app:// supaya fetch, Worker,
// IndexedDB, dan localStorage bekerja seperti di browser.
const { app, BrowserWindow, protocol, net, shell, Menu, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

const DIST = path.join(__dirname, 'dist');

// ukuran, posisi, dan status layar penuh/maksimal jendela diingat antar sesi
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { width: Math.min(1760, Math.round(wa.width * 0.94)), height: Math.min(1100, Math.round(wa.height * 0.94)), maximized: false, fullscreen: false };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) {
      const r = { x: s.x, y: s.y, width: s.width, height: s.height };
      // posisi lama harus masih ada di salah satu layar (monitor bisa dicabut)
      const ok = Number.isFinite(r.x) && Number.isFinite(r.y) && screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return r.x < b.x + b.width - 80 && r.x + r.width > b.x + 80 && r.y >= b.y - 10 && r.y < b.y + b.height - 80;
      });
      return { ...def, ...(ok ? r : { width: r.width, height: r.height }), maximized: !!s.maximized, fullscreen: !!s.fullscreen };
    }
  } catch {}
  return def;
}

function createWindow() {
  const st = loadState();
  const win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d0c',
    title: 'FontSeru',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  if (st.maximized) win.maximize();
  if (st.fullscreen) win.setFullScreen(true);
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized(),
      fullscreen = win.isFullScreen();
    // saat maksimal/layar penuh, simpan ukuran normal (bukan ukuran layar) supaya bisa dikembalikan
    const b = maximized || fullscreen ? win.getNormalBounds() : win.getBounds();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...b, maximized, fullscreen }));
    } catch {}
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
  win.on('close', save);
  win.loadURL('app://local/index.html');
  // setelah jendela diminimalkan lalu dibuka lagi, Chromium di macOS kadang membuang font/lapisan GPU → teks panel hilang.
  // Paksa gambar ulang dan muat ulang font yang belum termuat.
  const nudge = () => {
    if (win.isDestroyed()) return;
    win.webContents.invalidate();
    win.webContents
      .executeJavaScript(
        `(()=>{try{document.fonts&&document.fonts.forEach(f=>{if(f.status!=='loaded')f.load().catch(()=>{});});const r=document.documentElement;r.style.willChange='transform';requestAnimationFrame(()=>requestAnimationFrame(()=>{r.style.willChange='';window.dispatchEvent(new Event('resize'));}));}catch(e){}})()`,
      )
      .catch(() => {});
  };
  for (const ev of ['restore', 'show', 'focus', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => setTimeout(nudge, 80));
  // tautan luar dibuka di browser bawaan sistem
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('app://')) shell.openExternal(url);
    return { action: url.startsWith('app://') ? 'allow' : 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname, search } = new URL(req.url);
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
