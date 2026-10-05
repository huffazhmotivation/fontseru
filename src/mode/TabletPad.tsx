import { useEffect, useRef, useSyncExternalStore } from "react";
import { Copy, ClipboardPaste, Trash2 } from "lucide-react";
import { subscribeMods, setVirtualMod, virtualMods, installVirtualModifiers, useIsTablet, type ModKey } from "@/mode/tablet";

const MODS: { id: ModKey; sym: string; label: string }[] = [
  { id: "shift", sym: "⇧", label: "Shift" },
  { id: "alt", sym: "⌥", label: "Alt / Option" },
  { id: "meta", sym: "⌘", label: "Cmd / Ctrl" },
];

const TAP_MS = 280;
const snapshot = () => `${+virtualMods.shift}${+virtualMods.alt}${+virtualMods.meta}`;

interface Props {
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  /** posisi: "canvas" = absolut di pojok kiri bawah induk (induk harus position:relative) */
  className?: string;
}

/**
 * Pad 6 tombol mengambang (hanya tablet), 3 × 2 — sama dengan pad di Mode Design:
 *   atas : Salin · Tempel · Hapus   (Ctrl+C · Ctrl+V · Delete)
 *   bawah: Shift · Alt · Cmd/Ctrl   (modifier virtual: ketuk = kunci, tahan = aktif selama ditahan)
 */
export function TabletPad({ onCopy, onPaste, onDelete, className }: Props) {
  const tablet = useIsTablet();
  const state = useSyncExternalStore(subscribeMods, snapshot, snapshot);
  useEffect(() => { if (tablet) installVirtualModifiers(); }, [tablet]);
  // lepas semua modifier saat pad hilang (mis. pindah mode)
  useEffect(() => () => { (["shift", "alt", "meta"] as ModKey[]).forEach((k) => setVirtualMod(k, false)); }, []);
  if (!tablet) return null;

  return (
    <div
      className={`fm-tpad ${className ?? ""}`}
      role="toolbar"
      aria-label="Tombol pintasan tablet"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ActBtn label="Salin" onRun={onCopy} icon={<Copy size={17} strokeWidth={1.9} />} />
      <ActBtn label="Tempel" onRun={onPaste} icon={<ClipboardPaste size={17} strokeWidth={1.9} />} />
      <ActBtn label="Hapus" danger onRun={onDelete} icon={<Trash2 size={17} strokeWidth={1.9} />} />
      {MODS.map((m, i) => (
        <ModBtn key={m.id} id={m.id} sym={m.sym} label={m.label} on={state[i] === "1"} />
      ))}
    </div>
  );
}

function ActBtn({ label, icon, onRun, danger }: { label: string; icon: React.ReactNode; onRun: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      className="fm-tpad-btn"
      aria-label={label}
      title={label}
      data-danger={danger ? "true" : undefined}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={onRun}
    >
      {icon}
    </button>
  );
}

function ModBtn({ id, sym, label, on }: { id: ModKey; sym: string; label: string; on: boolean }) {
  const down = useRef<{ t: number; wasLatched: boolean } | null>(null);
  const latched = useRef(false);
  const holding = useRef(false);

  const apply = () => setVirtualMod(id, latched.current || holding.current);

  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = down.current;
    if (!d) return;
    down.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    holding.current = false;
    // ketuk singkat = kunci / lepas kunci; tahan lama = hanya aktif selama ditahan
    if (e.type !== "pointercancel" && performance.now() - d.t < TAP_MS) latched.current = !d.wasLatched;
    apply();
  };

  return (
    <button
      type="button"
      className="fm-tpad-btn fm-tpad-mod"
      aria-label={label}
      title={label}
      aria-pressed={on}
      data-on={on}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        down.current = { t: performance.now(), wasLatched: latched.current };
        holding.current = true;
        apply();
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      {sym}
    </button>
  );
}
