/**
 * TransitionEditor — kesim rozetine tıklayınca açılan geçiş düzenleyici.
 *
 * TimelineContextMenu ile AYNI hafif desen (dialog kütüphanesi yok, tema
 * token'ları, Escape/dışarı tık/tekerlek ile kapanma). İçerik: altı geçiş tipi
 * + süre alanı + kaldırma düğmesi.
 *
 * Doküman mantığı burada YOK: her düğme timelineOps'taki geçiş op'una iner ve
 * op'un OpResult'ı (ret gerekçesi ya da "kısaltıldı" bildirimi) çağırana
 * geri verilir — uyarı balonunu TimelinePanel gösterir.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MicroSec, TransitionType } from '@videoedit/timeline-schema';
import { formatTimecode } from '@videoedit/timeline-schema';
import {
  formatTransitionSeconds,
  parseTransitionSeconds,
  transitionTypeLabel,
  TRANSITION_TYPE_OPTIONS,
} from './transitions';

/** Kenar payı (px) — menüyle aynı. */
const EDGE_MARGIN = 6;

export interface TransitionEditorProps {
  /** Açılış noktası, client (viewport) koordinatları. */
  x: number;
  y: number;
  /** Kesimin zamanı — başlıkta timecode olarak gösterilir. */
  cutUs: MicroSec;
  fps: { num: number; den: number };
  /** Kesimde şu an duran geçiş; yoksa (henüz eklenmemiş) undefined. */
  current: { type: TransitionType; durationUs: MicroSec } | undefined;
  /** Doküman düzenlenebilir mi (proje yükleniyorsa false). */
  mutationAllowed: boolean;
  onPickType(type: TransitionType): void;
  onSetDuration(durationUs: MicroSec): void;
  onRemove(): void;
  onClose(): void;
}

export function TransitionEditor({
  x,
  y,
  cutUs,
  fps,
  current,
  mutationAllowed,
  onPickType,
  onSetDuration,
  onRemove,
  onClose,
}: TransitionEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Süre alanı KONTROLSÜZ değil, "taslak" tutulur: kullanıcı yazarken her tuş
  // vuruşunda op çağırmak (ve her birini history'ye yazmak) kabul edilemez;
  // commit blur/Enter'da olur. Dışarıdan gelen değişiklik (op kısalttı) taslağı
  // tazeler.
  const durationUs = current?.durationUs;
  const [draft, setDraft] = useState(() =>
    durationUs === undefined ? '' : formatTransitionSeconds(durationUs),
  );
  useEffect(() => {
    setDraft(durationUs === undefined ? '' : formatTransitionSeconds(durationUs));
  }, [durationUs]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - rect.width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - rect.height - EDGE_MARGIN)),
    });
  }, [x, y]);

  const commitDuration = useCallback(() => {
    if (durationUs === undefined) return;
    const parsed = parseTransitionSeconds(draft);
    if (parsed === null) {
      setDraft(formatTransitionSeconds(durationUs));
      return;
    }
    if (parsed !== durationUs) onSetDuration(parsed);
  }, [draft, durationUs, onSetDuration]);

  // Dışarı tık / Escape / tekerlek / resize -> kapat. Escape capture fazında
  // durdurulur: global kısayol dispatcher'ına sızıp sürükleme iptal etmesin.
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

  const disabled = !mutationAllowed;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Geçiş"
      data-testid="transition-editor"
      className="fixed z-50 w-[15rem] rounded-md border border-edge bg-surface-2 p-2 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold text-fg">Geçiş</span>
        <span className="font-mono text-[10px] text-fg-muted" title="Kesim noktası">
          {formatTimecode(cutUs, fps)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1">
        {TRANSITION_TYPE_OPTIONS.map((option) => {
          const active = current?.type === option.type;
          return (
            <button
              key={option.type}
              type="button"
              disabled={disabled}
              data-testid={`transition-type-${option.type}`}
              aria-pressed={active}
              className={`rounded border px-1.5 py-1 text-left text-[11px] disabled:pointer-events-none disabled:opacity-40 ${
                active
                  ? 'border-accent/70 bg-accent/20 text-accent'
                  : 'border-edge text-fg-muted hover:bg-surface-3 hover:text-fg'
              }`}
              onClick={() => onPickType(option.type)}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {current !== undefined && (
        <>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
            <span className="shrink-0">Süre (sn)</span>
            <input
              type="text"
              inputMode="decimal"
              disabled={disabled}
              data-testid="transition-duration"
              aria-label="Geçiş süresi (saniye)"
              value={draft}
              className="min-w-0 flex-1 rounded border border-edge bg-surface-1 px-1.5 py-0.5 text-right font-mono text-[11px] text-fg outline-none focus:border-accent/70 disabled:opacity-40"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDuration}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDuration();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft(formatTransitionSeconds(current.durationUs));
                }
              }}
            />
          </label>
          <p className="mt-1 text-[10px] leading-tight text-fg-muted">
            {transitionTypeLabel(current.type)} — süre çift kare sayısına oturtulur ve kaynak
            payına göre kısaltılabilir.
          </p>
          <button
            type="button"
            disabled={disabled}
            data-testid="transition-remove"
            className="mt-1.5 w-full rounded border border-edge px-1.5 py-1 text-[11px] text-danger hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40"
            onClick={onRemove}
          >
            Geçişi kaldır
          </button>
        </>
      )}

      {current === undefined && (
        <p className="mt-2 text-[10px] leading-tight text-fg-muted">
          Bir tip seçince kesime geçiş eklenir.
        </p>
      )}
    </div>
  );
}
