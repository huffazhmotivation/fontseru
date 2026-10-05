import { useEffect, useState } from 'react';
import { Type, PenTool, Clapperboard, ChevronDown, Undo2, Redo2, Moon, Sun, History, Share2, Search, Layers, SlidersHorizontal, PencilLine } from 'lucide-react';
import { useStore, getS } from '../store/store';
import { usePopover, Kbd, MOD, SHIFT, Tip } from './primitives';
import { saveVersion, importFilesViaPicker } from '../lib/library';
import * as C from '../engine/commands';
import { newProject, openProject, saveProject } from '../lib/actions';
import { TopMenus } from './TopMenus';
import { smartUndo, smartRedo } from '../tools/interaction';
import { sbCanUndo } from '../tools/shapebuilder';
import { useTablet, setTabletPref, setPalm } from '../store/tablet';

/** Saat DesignSeru dibuka di dalam FontSeru (iframe, Mode Design): tab Font / Design / Motion di bar atas, tepat di kanan logo.
 *  Klik tab mengirim pesan ke FontSeru yang menukar mode; di luar FontSeru komponen ini tidak tampil. */
const EMBEDDED = typeof window !== 'undefined' && window.parent !== window;
function ModeSwitch() {
  if (!EMBEDDED) return null;
  const go = (mode: 'font' | 'motion') => window.parent.postMessage({ type: 'fontseru:set-mode', mode }, location.origin);
  // ukuran persis sama dengan tab Font / Motion (ModeTabs di FontSeru) supaya ketiganya satu kesatuan
  const tabStyle = { height: 30, padding: '0 13px', gap: 7, fontSize: 12.5, letterSpacing: '-0.01em', borderRadius: 8, lineHeight: 1 } as const;
  const base = 'inline-flex items-center whitespace-nowrap border border-transparent font-semibold transition-colors';
  const idle = `${base} text-muted hover:text-ink`;
  const on = 'inline-flex items-center whitespace-nowrap border border-line font-semibold bg-panel text-ink shadow-sm';
  return (
    <div role="tablist" aria-label="Mode editor" className="mx-1.5 flex shrink-0 items-center border border-line bg-field" style={{ padding: 3, gap: 3, borderRadius: 11 }}>
      <button type="button" role="tab" aria-selected={false} className={idle} style={tabStyle} onClick={() => go('font')}>
        <Type size={15} strokeWidth={2} className="opacity-80" /> <span>Font</span>
      </button>
      <button type="button" role="tab" aria-selected className={on} style={tabStyle}>
        <PenTool size={15} strokeWidth={2} className="text-accent" /> <span>Design</span>
      </button>
      <button type="button" role="tab" aria-selected={false} className={idle} style={tabStyle} onClick={() => go('motion')}>
        <Clapperboard size={15} strokeWidth={2} className="opacity-80" /> <span>Motion</span>
      </button>
    </div>
  );
}

/** ikon aplikasi (sama dengan favicon & ikon layar utama) */
export function Logo({ size = 22 }: { size?: number }) {
  return <img src={new URL("favicon.svg", document.baseURI).href} width={size} height={size} alt="" aria-hidden draggable={false} style={{ borderRadius: size * 0.24 }} />;
}

/** logo lengkap DesignSeru: versi terang dipakai di mode terang, versi gelap di mode gelap */
export function Wordmark({ height = 18 }: { height?: number }) {
  const dark = useStore((s) => s.theme) === 'dark';
  const ink = dark ? '#FFFFFF' : '#000000';
  return (
    <svg height={height} viewBox="0 0 2902.17 564.06" role="img" aria-label="DesignSeru" style={{ width: (height * 2902.17) / 564.06 }}>
      <path
        d="M242.16 13.48 C247.03 3.88 234.35 -4.87 227.1 3.08 L7.69 243.98 C2.3 249.89 6.48 259.39 14.48 259.43 L127.53 259.95 C134.83 259.98 139.2 268.07 135.24 274.2 L1.58 480.9 C-4.4 490.15 7.94 500.22 15.81 492.5 L309.29 204.27 C315.17 198.49 311.11 188.49 302.86 188.44 L168.67 187.78 C161.81 187.75 157.38 180.49 160.49 174.37 L242.16 13.48 Z"
        fill="#FF4DA6"
        stroke="#FF4DA6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        transform="translate(84.95 .68)"
        d="M396.05 227.82 C396.05 354.01 293.75 456.32 167.55 456.32 L0 456.32 L102.76 355.4 L157.53 355.4 C227.99 355.4 285.11 298.28 285.11 227.82 C285.11 157.35 227.99 100.23 157.53 100.23 L145.83 100.23 L190.21 12.79 C193.06 7.19 189.92 1.87 185.37 0 C303.24 9.09 396.05 107.61 396.05 227.82 Z"
        fill={ink}
      />
      <g fontFamily="'Stack Sans Notch', sans-serif" fontSize="424.3" fontWeight="400" dominantBaseline="central" xmlSpace="preserve">
        <text transform="translate(526.17 33.68)" fill={ink}>
          <tspan x="0" y="265.19">Design</tspan>
        </text>
        <text transform="translate(1903.17 33.68)" fill="#FF4DA6">
          <tspan x="0" y="265.19">Seru.</tspan>
        </text>
      </g>
    </svg>
  );
}

export function TopBar() {
  const fileName = useStore((s) => s.fileName);
  const theme = useStore((s) => s.theme);
  const canUndo = useStore((s) => s.past.length > 0 || !!s.penDrawingId || (s.tool === 'shapebuilder' && !!s.overlay && sbCanUndo()));
  const canRedo = useStore((s) => s.future.length > 0 || !!s.penDrawingId);
  const savedAt = useStore((s) => s.savedAt);
  const layersOpen = useStore((s) => s.layersOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const tablet = useTablet((s) => s.tablet);
  const [editName, setEditName] = useState(false);

  return (
    <header className="ds-topbar relative z-30 flex h-11 shrink-0 items-center gap-1 border-b border-line bg-app pl-2 pr-2">
      <MainMenu />
      <ModeSwitch />
      <span className={`mx-1.5 h-4 w-px bg-line ${tablet ? 'block' : 'hidden sm:block'}`} />

      <div className="relative z-10 flex min-w-0 items-center gap-2">
        {editName ? (
          <input
            autoFocus
            aria-label="Nama file"
            defaultValue={fileName}
            className="field h-7 w-60 font-medium"
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) getS().set({ fileName: v });
              setEditName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditName(false);
            }}
          />
        ) : (
          <button
            className="group flex h-7 min-w-0 max-w-[180px] items-center 2xl:max-w-[260px] gap-1.5 rounded-ctl px-2 text-sm font-medium hover:bg-hover"
            onClick={() => setEditName(true)}
            title="Klik untuk mengganti nama"
          >
            <span className="truncate">{fileName}</span>
            <PencilLine size={12} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        <SavedBadge savedAt={savedAt} tablet={tablet} />
      </div>

      <TopMenus />

      <div className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5">
        <Tip label="Cari perintah" shortcut={`${MOD}K`} side="bottom">
          <button className="icon-btn" aria-label="Cari perintah" onClick={() => getS().set({ palette: true })}>
            <Search size={15} strokeWidth={1.75} />
          </button>
        </Tip>
        <div className={`items-center ${tablet ? 'flex' : 'hidden sm:flex'}`}>
          <HistoryMenu />
        </div>
        <Tip label="Urungkan" shortcut={`${MOD}Z`} side="bottom">
          <button className="icon-btn" aria-label="Urungkan" disabled={!canUndo} onClick={() => smartUndo()}>
            <Undo2 size={15} strokeWidth={1.75} />
          </button>
        </Tip>
        <Tip label="Ulangi" shortcut={`${MOD}${SHIFT}Z`} side="bottom">
          <button className="icon-btn" aria-label="Ulangi" disabled={!canRedo} onClick={() => smartRedo()}>
            <Redo2 size={15} strokeWidth={1.75} />
          </button>
        </Tip>
        <span className="mx-1.5 h-4 w-px bg-line" />
        <Tip label={theme === 'light' ? 'Tema tinta (gelap)' : 'Tema kertas (terang)'} side="bottom">
          <button className="icon-btn" aria-label="Ganti tema" onClick={C.toggleTheme}>
            {theme === 'light' ? <Moon size={15} strokeWidth={1.75} /> : <Sun size={15} strokeWidth={1.75} />}
          </button>
        </Tip>
        <Tip label={layersOpen ? 'Sembunyikan layer' : 'Tampilkan layer'} side="bottom">
          <button className="icon-btn" aria-label="Kolom layer" data-on={layersOpen} onClick={() => getS().set({ layersOpen: !layersOpen })}>
            <Layers size={15} strokeWidth={1.75} />
          </button>
        </Tip>
        <Tip label={rightOpen ? 'Sembunyikan properti' : 'Tampilkan properti'} side="bottom">
          <button className="icon-btn" aria-label="Panel properti" data-on={rightOpen} onClick={() => getS().set({ rightOpen: !rightOpen })}>
            <SlidersHorizontal size={15} strokeWidth={1.75} />
          </button>
        </Tip>
        <div className={tablet ? 'block' : 'hidden sm:block'}>
          <ShareMenu />
        </div>
        <button className="btn-primary ml-1.5 h-7 px-3" onClick={() => getS().set({ exportOpen: true })}>
          Ekspor
        </button>
      </div>
    </header>
  );
}

function SavedBadge({ savedAt, tablet }: { savedAt: number | null; tablet?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  if (!savedAt) return null;
  const sec = Math.round((Date.now() - savedAt) / 1000);
  const label = sec < 45 ? 'Tersimpan' : sec < 3600 ? `Tersimpan · ${Math.round(sec / 60)} mnt` : 'Tersimpan';
  return (
    <span className={`shrink-0 items-center gap-1.5 text-xs text-faint ${tablet ? 'flex' : 'hidden md:flex'}`} title="Tersimpan otomatis di browser ini">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
      {label}
    </span>
  );
}

function MainMenu() {
  const { open, setOpen, ref } = usePopover();
  const item = (label: string, fn: () => void, kbd?: string, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
  const head = (t: string) => <div className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">{t}</div>;
  const sel = useStore((s) => s.selection.length);
  const tablet = useTablet((s) => s.tablet);
  const palm = useTablet((s) => s.palm);
  return (
    <div ref={ref} className="relative z-10">
      <button className="flex h-8 items-center gap-2 rounded-ctl pl-1 pr-1.5 hover:bg-hover" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={tablet ? 'hidden' : 'sm:hidden'}>
          <Logo size={24} />
        </span>
        <span className={`pl-1 ${tablet ? 'inline' : 'hidden sm:inline'}`}>
          <Wordmark height={tablet ? 15 : 17} />
        </span>
        <ChevronDown size={12} strokeWidth={2} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="popover animate-drop absolute left-0 top-10 z-40 max-h-[calc(100vh-64px)] w-64 overflow-y-auto p-1">
          {head('File')}
          {item('Dokumen baru', newProject)}
          {item('Buka proyek (.pulpen)…', openProject, `${MOD}O`)}
          {item('Impor file… (SVG, gambar, PDF)', importFilesViaPicker)}
          {item('Simpan proyek (.pulpen)', saveProject, `${MOD}S`)}
          {item('Ekspor…', () => getS().set({ exportOpen: true }), `${MOD}${SHIFT}E`)}
          {item('Simpan versi', () => saveVersion())}
          {item('Riwayat versi…', () => getS().set({ versionsOpen: true }))}
          {item('Pintasan keyboard…', () => getS().set({ shortcutsOpen: true }))}
          {head('Edit')}
          {item('Urungkan', () => smartUndo(), `${MOD}Z`)}
          {item('Ulangi', () => smartRedo(), `${MOD}${SHIFT}Z`)}
          {item('Duplikat', C.duplicate, `${MOD}D`, !sel)}
          {item('Grupkan', C.group, `${MOD}G`, !sel)}
          {item('Pisahkan grup', C.ungroupSel, `${MOD}${SHIFT}G`, !sel)}
          {item('Pilih semua', C.selectAll, `${MOD}A`)}
          {head('Tampilan')}
          {item('Cari perintah…', () => getS().set({ palette: true }), `${MOD}K`)}
          {item('Aset & brand kit', () => getS().set({ leftOpen: true, assetCat: 'brand' }))}
          {item('Mode fokus', () => getS().set({ focusMode: true }), 'Tab')}
          {item('Penggaris & guide', C.toggleRulers, `${SHIFT}R`)}
          {item('Grid titik', () => getS().setToolOpts((o) => ({ ...o, dotGrid: !o.dotGrid })))}
          {item('Hapus semua guide', C.clearGuides)}
          {item('Ganti tema', C.toggleTheme)}
          {head('Tablet')}
          {item(`Mode tablet: ${tablet ? 'aktif' : 'mati'}`, () => setTabletPref(!tablet))}
          {tablet && item(`Tolak telapak tangan: ${palm ? 'aktif' : 'mati'}`, () => setPalm(!palm))}
        </div>
      )}
    </div>
  );
}

function HistoryMenu() {
  const { open, setOpen, ref } = usePopover();
  const past = useStore((s) => s.past);
  const future = useStore((s) => s.future);
  const entries = [
    ...past.map((p, i) => ({ label: p.label, index: i, state: 'past' as const })),
    { label: 'Keadaan sekarang', index: past.length, state: 'now' as const },
    ...future.map((f, i) => ({ label: f.label, index: past.length + i + 1, state: 'future' as const })),
  ];
  return (
    <div ref={ref} className="relative">
      <Tip label="Riwayat langkah" side="bottom">
        <button className="icon-btn" aria-label="Riwayat" data-on={open} onClick={() => setOpen(!open)}>
          <History size={15} strokeWidth={1.75} />
        </button>
      </Tip>
      {open && (
        <div className="popover animate-drop absolute right-0 top-9 z-40 w-72 p-1">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="section-title">Riwayat langkah</span>
            <span className="rule" />
            <span className="num text-2xs text-faint">{past.length}</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            <button className="menu-item text-muted" onClick={() => getS().jumpTo(0)}>
              Dokumen dibuka
            </button>
            {entries.map((e, i) =>
              e.state === 'now' ? (
                <div key="now" className="menu-item relative bg-sel font-medium text-ink">
                  {past.length ? past[past.length - 1].label : 'Belum ada perubahan'}
                  <span className="ml-auto text-2xs font-semibold uppercase tracking-wider text-accent">sekarang</span>
                </div>
              ) : e.state === 'past' && i === past.length - 1 ? null : (
                <button
                  key={i}
                  className={`menu-item ${e.state === 'future' ? 'text-faint line-through decoration-faint/50' : ''}`}
                  onClick={() => getS().jumpTo(e.state === 'past' ? e.index + 1 : e.index)}
                >
                  {e.label}
                </button>
              ),
            )}
          </div>
          <div className="border-t border-line px-2 py-1.5 text-xs text-muted">Klik langkah untuk kembali ke titik itu.</div>
        </div>
      )}
    </div>
  );
}

function ShareMenu() {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <Tip label="Bagikan" side="bottom">
        <button className="icon-btn" aria-label="Bagikan" data-on={open} onClick={() => setOpen(!open)}>
          <Share2 size={15} strokeWidth={1.75} />
        </button>
      </Tip>
      {open && (
        <div className="popover animate-drop absolute right-0 top-9 z-40 w-72 p-3.5">
          <div className="text-sm font-semibold">Bagikan desain</div>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Kolaborasi real-time menyusul. Untuk sekarang, simpan file <b className="font-semibold text-ink">.pulpen</b> lalu kirim ke rekanmu. Mereka bisa
            membukanya lewat menu Buka proyek.
          </p>
          <button
            className="btn-ink mt-3 w-full justify-center"
            onClick={() => {
              setOpen(false);
              saveProject();
            }}
          >
            Simpan file .pulpen
          </button>
        </div>
      )}
    </div>
  );
}
