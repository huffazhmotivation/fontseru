import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initTablet } from './store/tablet';
import { initSeruBridge } from './lib/seruBridge';

initTablet(); // deteksi iPad/tablet sebelum render pertama
initSeruBridge(); // salin-tempel SVG antar tab Font ⇄ Design (aktif juga saat berdiri sendiri)

createRoot(document.getElementById('root')!).render(<App />);

// pustaka ikon lengkap dimuat saat browser senggang (tidak menghambat muat awal)
const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 2500));
idle(() => import('./lib/icons').then((m) => m.loadLucide()).catch(() => {}));

// PWA DesignSeru tidak dipakai di FontSeru: aplikasi ini berjalan di sub-folder /design/ (iframe) dan FontSeru punya
// service worker sendiri di akar situs (Mode Design sengaja tidak di-cache offline, lihat vite.config.ts FontSeru).

// berkas .seru dibuka lewat OS (PWA terpasang di Chrome/Edge): kirim ke fungsi buka proyek
type LaunchQ = { setConsumer(cb: (p: { files: { getFile(): Promise<File> }[] }) => void): void };
const lq = (window as unknown as { launchQueue?: LaunchQ }).launchQueue;
lq?.setConsumer(async (p) => {
  const h = p.files[0];
  if (h) import('./lib/actions').then(async (m) => m.openProjectFile(await h.getFile())).catch(() => {});
});
// aplikasi desktop (Electron) mengirim isi berkas yang diklik dua kali di Finder/Explorer
window.addEventListener('designseru:openfile', (e) => {
  const d = (e as CustomEvent<{ name: string; text: string }>).detail;
  if (d?.text) import('./lib/actions').then((m) => m.openProjectFile(new File([d.text], d.name))).catch(() => {});
});
(window as unknown as { __dsReady?: boolean }).__dsReady = true;
