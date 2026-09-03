/**
 * TimelineResizeHandle — timeline satırını dikey olarak sürükleyerek büyütüp
 * küçülten tutamak (panel turu dilim 2b).
 *
 * YERİ: panelin kökünde, canvas SARMALAYICISININ DIŞINDA duran mutlak
 * konumlu bir şerit. Sarmalayıcının içine konsaydı e2e'nin "3 canvas içeren
 * div" sezgisi ve gövde imzasının canvas sırası bozulurdu; başlığın 1.5
 * birimlik üst dolgusunun içinde kaldığı için de başlıktaki düğmelerin
 * tıklama alanını ÇALMAZ.
 *
 * JEST: PropertyFields'ın pointer-capture deseni + ÜÇLÜ ÇIKIŞ —
 *   pointerup            -> commit (kalıcılık burada yazılır),
 *   lostpointercapture   -> commit (capture başka bir yere geçtiyse jest bitti),
 *   pointercancel/Escape -> abort (sürükleme öncesi yüksekliğe dön).
 * pointermove'lar rAF ile BİRLEŞTİRİLİR: kare başına en fazla bir store
 * yazımı olur (60 Hz'te her olayda yazmak dört paneli de yeniden render
 * ettirirdi). Kalıcılık YALNIZ commit anında yazılır — sürükleme boyunca
 * senkron localStorage I/O yapılmaz.
 *
 * KLAVYE: ok tuşları ince, Shift+ok bir track satırı kadar, Home/End
 * sınırlar. Yalnız ELE ALINAN tuşlarda preventDefault + stopPropagation
 * yapılır; diğerleri global kısayol dispatcher'ına geçer (tutamak, klavyeyi
 * odaktayken rehin almaz).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { TRACK_GAP, TRACK_H } from './geometry';
import {
  clampTimelineHeight,
  maxTimelineHeight,
  minTimelineHeight,
  selectTimelineHeightPx,
  selectTimelineMaxPx,
  selectTimelineMinPx,
  setPreferredTimelineHeight,
  useTimelineHeightStore,
} from './timelineHeight';

/** Ok tuşu adımı (ince ayar). */
const STEP_PX = 8;
/** Shift+ok adımı: tam bir track satırı (satır aralığı dahil). */
const COARSE_STEP_PX = TRACK_H + TRACK_GAP;

interface DragState {
  pointerId: number;
  startClientY: number;
  /** Jest başındaki EFEKTİF yükseklik (sürükleme bunun üzerine biner). */
  startHeightPx: number;
  /** Jest başındaki KULLANICI NİYETİ — abort bunu geri yazar. */
  startPreferredPx: number;
  /** rAF birleştirme durumu (son işlenmemiş imleç konumu). */
  pendingClientY: number | null;
  rafId: number;
}

export function TimelineResizeHandle() {
  const heightPx = useTimelineHeightStore(selectTimelineHeightPx);
  const minPx = useTimelineHeightStore(selectTimelineMinPx);
  const maxPx = useTimelineHeightStore(selectTimelineMaxPx);

  const dragRef = useRef<DragState | null>(null);

  /**
   * Niyeti yazar. KELEPÇENİN SAHİBİ TEK: `clampTimelineHeight` (saf fonksiyon)
   * — burada ikinci bir kelepçe kopyası yoktur, ekrana giden değer daima o
   * fonksiyondan geçer.
   */
  const writeIntent = useCallback((px: number): void => {
    setPreferredTimelineHeight(px, { persist: false });
  }, []);

  /** Kullanıcının GÖRDÜĞÜ (kelepçelenmiş) yüksekliği niyet olarak kalıcılaştırır. */
  const commitEffective = useCallback((): void => {
    const effective = clampTimelineHeight(useTimelineHeightStore.getState());
    setPreferredTimelineHeight(effective, { persist: true });
  }, []);

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (drag === null) return;
      dragRef.current = null;
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId);
      // Üç çıkışın da ortak temizliği: sürükleme imleci belge kökünden kalkar.
      document.documentElement.style.cursor = '';
      if (commit) {
        // Son pointermove'un rAF'ı henüz koşmamış olabilir: jest biterken
        // bekleyen konum BİR KEZ uygulanır (kare başına ≤1 yazım kuralı bozulmaz).
        if (drag.pendingClientY !== null) {
          writeIntent(drag.startHeightPx - (drag.pendingClientY - drag.startClientY));
        }
        commitEffective();
      } else {
        // Abort: niyet jest ÖNCESİNE döner, kalıcı değer hiç yazılmamıştır.
        setPreferredTimelineHeight(drag.startPreferredPx, { persist: false });
      }
    },
    [commitEffective, writeIntent],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // preventDefault: metin seçimi/sürükleme başlamasın. Bedeli, uyumluluk
      // fare olaylarının (ve onlara bağlı ODAKLANMANIN) düşmesidir — tutamak
      // klavyeyle de kullanıldığı için odağı ELLE alırız.
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      const state = useTimelineHeightStore.getState();
      const current = clampTimelineHeight(state);
      dragRef.current = {
        pointerId: e.pointerId,
        startClientY: e.clientY,
        startHeightPx: current,
        startPreferredPx: state.preferredPx,
        pendingClientY: null,
        rafId: 0,
      };
      // İmleç TÜM belgede row-resize kalsın: sürükleme sırasında imleç
      // tutamağın dışına çıktığında (capture bizde) imlecin değişmesi
      // jestin bittiği izlenimi verirdi.
      document.documentElement.style.cursor = 'row-resize';
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || e.pointerId !== drag.pointerId) return;
      drag.pendingClientY = e.clientY;
      if (drag.rafId !== 0) return; // bu kare için zaten planlandı
      drag.rafId = requestAnimationFrame(() => {
        const active = dragRef.current;
        if (active === null) return;
        active.rafId = 0;
        if (active.pendingClientY === null) return;
        // Yukarı sürüklemek BÜYÜTÜR (timeline en alttaki satırdır).
        writeIntent(active.startHeightPx - (active.pendingClientY - active.startClientY));
      });
    },
    [writeIntent],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const state = useTimelineHeightStore.getState();
      const lo = minTimelineHeight(state.headerPx);
      const hi = maxTimelineHeight(state.headerPx, state.availablePx);
      const current = clampTimelineHeight(state);
      const step = e.shiftKey ? COARSE_STEP_PX : STEP_PX;
      let next: number | null = null;
      if (e.key === 'ArrowUp') next = current + step;
      else if (e.key === 'ArrowDown') next = current - step;
      else if (e.key === 'Home') next = lo;
      else if (e.key === 'End') next = hi;
      // Ele ALINMAYAN tuşlar dokunulmadan geçer (Tab, ?, Space, kısayollar…).
      if (next === null) return;
      // Ele alınan tuşlar dispatcher'a SIZMAZ: ↑↓ orada kesme noktası,
      // Home/End playhead'dir — tutamak odaktayken playhead oynamamalı.
      e.preventDefault();
      e.stopPropagation();
      writeIntent(next);
      commitEffective();
    },
    [commitEffective, writeIntent],
  );

  // Escape sürüklemeyi iptal eder (capture: global dinleyicilerden önce).
  // Sürükleme yokken hiçbir şey yapmaz — Escape'in diğer sahipleri korunur.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || dragRef.current === null) return;
      e.stopPropagation();
      endDrag(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [endDrag]);

  // Sökülme: yarım kalmış bir jestin rAF'ı ve imleci geride kalmasın.
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag === null) return;
      dragRef.current = null;
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId);
      document.documentElement.style.cursor = '';
    },
    [],
  );

  return (
    <div
      data-testid="timeline-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Timeline yüksekliği"
      aria-controls="timeline-section"
      aria-valuenow={Math.round(heightPx)}
      aria-valuemin={Math.round(minPx)}
      aria-valuemax={Math.round(maxPx)}
      tabIndex={0}
      title="Timeline yüksekliği — sürükleyin (ok tuşları: ince ayar)"
      className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onLostPointerCapture={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onKeyDown={onKeyDown}
    />
  );
}
