/**
 * TimelineContextMenu — sağ tık menüsünün DOM overlay'i.
 *
 * ConflictDialog / ShortcutsHelpOverlay ile aynı hafif desen (dialog kütüphanesi
 * yok, tema token'ları: surface-2 / edge / fg / danger). Kapatma: Escape,
 * dışarı tıklama, tekerlek, pencere yeniden boyutlanması. Öğe listesi
 * contextMenu.ts'te SAF olarak üretilir; burada yalnız çizim ve klavye gezinme
 * vardır.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TimelineMenuActionId, TimelineMenuEntry } from './contextMenu';

/** Menü kenarının ekrana yapışmaması için pay (px). */
const EDGE_MARGIN = 6;

export interface TimelineContextMenuProps {
  /** Açılış noktası — client (viewport) koordinatları. */
  x: number;
  y: number;
  entries: TimelineMenuEntry[];
  onSelect(id: TimelineMenuActionId): void;
  onClose(): void;
}

export function TimelineContextMenu({ x, y, entries, onSelect, onClose }: TimelineContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Ekran dışına taşmayı engelle (ölçüm mount sonrası, boyama öncesi).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(x, vw - rect.width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(y, vh - rect.height - EDGE_MARGIN)),
    });
    const first = el.querySelector<HTMLButtonElement>('button:not([disabled])');
    first?.focus();
  }, [x, y, entries.length]);

  // Dışarı tık / Escape / tekerlek / resize -> kapat. Escape capture fazında
  // yakalanır ve durdurulur: global kısayol dispatcher'ına sızmamalı.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  /** ↑/↓/Home/End ile etkin öğeler arasında gezinme. */
  const onMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const items = [...el.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
    else if (e.key === 'End') next = items.length - 1;
    items[next].focus();
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      aria-label="Timeline işlemleri"
      data-testid="timeline-context-menu"
      className="fixed z-50 min-w-[15rem] rounded-md border border-edge bg-surface-2 py-1 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry.kind === 'separator' ? (
          <div key={`sep-${i}`} role="separator" className="my-1 border-t border-edge" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={`flex w-full items-center gap-4 px-3 py-1 text-left text-xs outline-none ${
              entry.danger ? 'text-danger' : 'text-fg'
            } enabled:hover:bg-surface-3 enabled:focus-visible:bg-surface-3 disabled:cursor-default disabled:opacity-40`}
            onClick={() => onSelect(entry.id)}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut !== undefined && (
              <span className="shrink-0 font-mono text-[10px] text-fg-muted">{entry.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
