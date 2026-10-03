import { useEffect, useRef } from 'react';
import { Copy, ClipboardPaste, Trash2 } from 'lucide-react';
import { useStore } from '../store/store';
import { useTablet, setHeld, toggleLatched, virtualMods, type ModKey } from '../store/tablet';
import { keys, altPressedDuringMove, refreshHover } from '../tools/interaction';
import * as C from '../engine/commands';
import { handleFiles } from '../lib/library';
import { placeSvgText } from '../lib/place';
import { isSvgText, classifyClipText } from '../lib/seruBridge';

const DEFS: { id: ModKey; sym: string; label: string; aria: string }[] = [
  { id: 'shift', sym: '⇧', label: 'Shift', aria: 'Shift' },
  { id: 'alt', sym: '⌥', label: 'Alt', aria: 'Alt / Option' },
  { id: 'meta', sym: '⌘', label: 'Cmd', aria: 'Command / Control' },
];

const TAP_MS = 280;

/** tempel: gambar/SVG dari clipboard sistem bila ada izin, selain itu clipboard internal (sama dengan Ctrl+V di PC) */
async function pasteFromAnywhere() {
  try {
    const items = await navigator.clipboard?.read?.();
    if (items?.length) {
      const files: File[] = [];
      for (const it of items) {
        for (const type of it.types) {
          if (type.startsWith('image/') || type === 'application/pdf') {
            const b = await it.getType(type);
            files.push(new File([b], `tempelan.${type.split('/')[1] || 'png'}`, { type }));
          }
        }
      }
      if (files.length) return void handleFiles(files);
      for (const it of items) {
        if (it.types.includes('text/plain')) {
          const t = (await (await it.getType('text/plain')).text()).trim();
          if (isSvgText(t)) {
            if (classifyClipText(t) === 'own') return void C.paste();
            return void placeSvgText(t, 'SVG tempelan');
          }
        }
      }
    }
  } catch {
    /* tanpa izin / tidak didukung → pakai clipboard internal */
  }
  C.paste();
}

/**
 * Pad 6 tombol mengambang di pojok kiri bawah kanvas (muncul otomatis di tablet), 3 × 2:
 *   atas : Salin · Tempel · Hapus      (sama dengan Ctrl+C · Ctrl+V · Delete di PC)
 *   bawah: Shift · Alt · Cmd/Ctrl      (modifier virtual)
 *  - modifier: ketuk singkat = kunci; tahan sambil menyeret dengan jari/Pencil lain = aktif selama ditahan
 */
export function TabletModifiers() {
  const latched = useTablet((s) => s.latched);
  const held = useTablet((s) => s.held);
  const rulers = useStore((s) => s.toolOpts.rulers);
  const hasSel = useStore((s) => s.selection.length > 0 || (s.editPathId != null && s.selAnchors.length > 0));
  const narrow = useStore((s) => s.viewport.w < 480);

  // samakan dengan `keys` (dibaca alat untuk pratinjau/hover) dan beri tahu alat saat Alt ditekan di tengah geser
  const prev = useRef({ shift: false, alt: false, meta: false });
  useEffect(() => {
    const v = virtualMods();
    keys.shift = v.shift;
    keys.alt = v.alt;
    keys.meta = v.meta;
    if (v.alt && !prev.current.alt) altPressedDuringMove();
    prev.current = v;
    refreshHover();
  }, [latched, held]);

  // di kanvas yang sangat sempit pad naik di atas dock "Alat gambar" supaya tidak bertumpuk
  const bottom = narrow ? 58 : 10;

  return (
    <div
      className="ink-bar ds-pad pointer-events-auto absolute z-20 grid grid-cols-3 gap-0.5 p-[3px]"
      style={{ left: rulers ? 30 : 10, bottom, touchAction: 'none', WebkitTouchCallout: 'none' }}
      role="toolbar"
      aria-label="Tombol pintasan tablet"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ActionButton label="Salin" disabled={!hasSel} onRun={() => C.copy()} icon={<Copy size={16} strokeWidth={1.8} />} />
      <ActionButton label="Tempel" onRun={() => void pasteFromAnywhere()} icon={<ClipboardPaste size={16} strokeWidth={1.8} />} />
      <ActionButton label="Hapus" disabled={!hasSel} danger onRun={() => C.deleteSelection()} icon={<Trash2 size={16} strokeWidth={1.8} />} />
      {DEFS.map((d) => (
        <ModButton key={d.id} def={d} on={latched[d.id] || held[d.id]} locked={latched[d.id]} />
      ))}
    </div>
  );
}

function ActionButton({ label, icon, onRun, disabled, danger }: { label: string; icon: React.ReactNode; onRun: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-danger={danger ? 'true' : undefined}
      className="ds-mod ds-act"
      onPointerDown={(e) => {
        // jangan ambil fokus/seleksi dari kanvas
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onRun}
    >
      <span className="ds-mod-sym flex items-center justify-center">{icon}</span>
      <span className="ds-mod-label">{label}</span>
    </button>
  );
}

function ModButton({ def, on, locked }: { def: (typeof DEFS)[number]; on: boolean; locked: boolean }) {
  const down = useRef<{ t: number; wasLatched: boolean } | null>(null);

  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = down.current;
    if (!d) return;
    down.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setHeld(def.id, false);
    // ketuk singkat = kunci / lepas kunci; tahan lama = hanya aktif selama ditahan
    if (e.type !== 'pointercancel' && performance.now() - d.t < TAP_MS) toggleLatched(def.id, !d.wasLatched);
  };

  return (
    <button
      type="button"
      aria-label={def.aria}
      aria-pressed={on}
      data-on={on}
      data-locked={locked}
      className="ds-mod"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        down.current = { t: performance.now(), wasLatched: locked };
        setHeld(def.id, true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span className="ds-mod-sym">{def.sym}</span>
      <span className="ds-mod-label">{def.label}</span>
    </button>
  );
}
