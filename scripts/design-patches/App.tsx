import { lazy, Suspense, useEffect } from 'react';
import { useStore, getS, ASSET_CATS } from './store/store';
import { TopBar } from './ui/TopBar';
import { CanvasView } from './ui/CanvasView';
import { LayersColumn } from './ui/LayersPanel';
import { AssetsPanel } from './ui/AssetsPanel';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { ContextMenu, CommandPalette, ExportDialog } from './ui/Overlays';
import { Toasts } from './ui/toast';
import { installShortcuts } from './tools/shortcuts';
import { loadAutosave, startAutosave } from './lib/persist';
import { emptyDoc } from './model/doc';
import { zoomToFit } from './engine/commands';
import { Minimize2 } from 'lucide-react';
import { BottomBar } from './ui/BottomBar';
import { VersionsDialog } from './ui/Versions';
import { PdfImportDialog } from './ui/PdfImportDialog';
import { useMockup } from './lib/mockup/store';
import { loadLibrary, startAutoVersions } from './lib/library';
import { installAutoOutline } from './lib/textcurves';

// dialog berat dimuat saat pertama kali dibuka (chunk terpisah)
const ShortcutsDialog = lazy(() => import('./ui/ShortcutsDialog').then((m) => ({ default: m.ShortcutsDialog })));
const MockupStudio = lazy(() => import('./ui/MockupStudio').then((m) => ({ default: m.MockupStudio })));

function LazyDialogs() {
  const shortcuts = useStore((s) => s.shortcutsOpen);
  const studio = useMockup((s) => s.studio);
  return (
    <Suspense fallback={null}>
      {shortcuts && <ShortcutsDialog />}
      {studio && <MockupStudio />}
    </Suspense>
  );
}

const LAYOUT_KEY = 'designseru:layout';
type Layout = { leftOpen: boolean; rightOpen: boolean; layersOpen: boolean; assetCat: ReturnType<typeof getS>['assetCat'] };

export default function App() {
  const theme = useStore((s) => s.theme);
  const rightOpen = useStore((s) => s.rightOpen);
  const focus = useStore((s) => s.focusMode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const off = installShortcuts();
    const offOutline = installAutoOutline();
    let stop = () => {};
    // ingat susunan panel per browser
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const l = JSON.parse(raw) as Omit<Partial<Layout>, 'assetCat'> & { assetCat?: string };
        // kategori lama: Jelajah → Frame, Ilustrasi → Elemen
        const cat = l.assetCat === 'ilustrasi' ? 'elemen' : (ASSET_CATS as string[]).includes(l.assetCat ?? '') ? (l.assetCat as Layout['assetCat']) : 'frame';
        getS().set({ ...l, assetCat: cat });
      }
    } catch {
      /* abaikan */
    }
    let hasLayout = false;
    try {
      hasLayout = !!localStorage.getItem(LAYOUT_KEY);
    } catch {
      /* abaikan */
    }
    if (window.innerWidth < 768) getS().set({ leftOpen: false, rightOpen: false, layersOpen: false });
    else if (window.innerWidth < 1400 && !hasLayout) getS().set({ layersOpen: false });
    const unsubLayout = useStore.subscribe((s, p) => {
      if (s.leftOpen === p.leftOpen && s.rightOpen === p.rightOpen && s.layersOpen === p.layersOpen && s.assetCat === p.assetCat) return;
      try {
        const l: Layout = { leftOpen: s.leftOpen, rightOpen: s.rightOpen, layersOpen: s.layersOpen, assetCat: s.assetCat };
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
      } catch {
        /* abaikan */
      }
    });
    (async () => {
      try {
        const host = document.documentElement.getAttribute('data-theme');
        const t = localStorage.getItem('designseru:theme');
        if (t === 'dark' || t === 'light') getS().set({ theme: t });
        else if (host === 'dark' || host === 'light') getS().set({ theme: host });
        else if (window.matchMedia('(prefers-color-scheme: dark)').matches) getS().set({ theme: 'dark' });
      } catch {
        /* abaikan */
      }
      const saved = await loadAutosave();
      if (saved && saved.doc.root.length) {
        getS().loadDoc(saved.doc, saved.name, saved.pages, saved.pageId);
        if (saved.camera) getS().set({ camera: saved.camera });
        else getS().set({ fitPending: true });
      } else {
        getS().loadDoc(emptyDoc(), 'Tanpa Judul'); // kanvas kosong sebagai default
        getS().set({ fitPending: true });
      }
      if (getS().fitPending && getS().viewport.w > 1) {
        getS().set({ fitPending: false });
        zoomToFit();
      }
      const stopSave = startAutosave();
      const stopVer = startAutoVersions();
      loadLibrary();
      stop = () => {
        stopSave();
        stopVer();
      };
    })();
    return () => {
      off();
      offOutline();
      stop();
      unsubLayout();
    };
  }, []);

  const showRight = rightOpen && !focus;

  return (
    <div className="flex h-full flex-col bg-app text-ink">
      {!focus && <TopBar />}
      <div className="relative flex min-h-0 flex-1">
        {!focus && <AssetsPanel />}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <CanvasView />
            <ContextMenu />
            <Toasts />
            {focus && (
              <button
                className="ink-bar absolute right-3 top-3 z-20 h-9 gap-2 px-3 text-sm font-medium text-bar-ink hover:bg-bar-2"
                onClick={() => getS().set({ focusMode: false })}
              >
                <Minimize2 size={13} /> Keluar mode fokus <span className="kbd border-bar-line text-bar-muted">Tab</span>
              </button>
            )}
          </div>
        </main>
        {!focus && <LayersColumn />}
        {showRight && (
          <aside
            className="w-[264px] shrink-0 overflow-y-auto border-l border-line bg-panel max-md:absolute max-md:bottom-0 max-md:right-0 max-md:top-0 max-md:z-30 max-md:shadow-pop"
            aria-label="Properti"
          >
            <PropertiesPanel />
          </aside>
        )}
      </div>
      {!focus && <BottomBar />}
      <CommandPalette />
      <ExportDialog />
      <VersionsDialog />
      <PdfImportDialog />
      <LazyDialogs />
    </div>
  );
}
