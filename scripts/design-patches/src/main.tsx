import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initTablet } from './store/tablet';
import { initSeruBridge } from './lib/seruBridge';
import { installPenUndo } from './engine/penUndo';

initTablet(); // deteksi iPad/tablet sebelum render pertama
installPenUndo(); // Urungkan saat Pen menggambar = cabut 1 titik terakhir, bukan seluruh path
initSeruBridge(); // salin-tempel SVG antar tab Font ⇄ Design (aktif juga saat berdiri sendiri)

createRoot(document.getElementById('root')!).render(<App />);

// pustaka ikon lengkap dimuat saat browser senggang (tidak menghambat muat awal)
const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 2500));
idle(() => import('./lib/icons').then((m) => m.loadLucide()).catch(() => {}));
