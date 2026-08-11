/**
 * TimelinePanel — hybrid canvas timeline (design 01 §3).
 *
 * Layers (top to bottom in the DOM):
 * - playhead overlay canvas (thin, redrawn alone while playing)
 * - ruler canvas (redrawn on zoom/pan)
 * - body canvas (tracks/clips/filmstrip/waveform; redrawn on doc/view changes)
 * All devicePixelRatio-scaled; only the visible time range is painted.
 *
 * Interactions are pointer-based: click/shift-click/marquee selection,
 * move drag (ghost; commit on release), edge trim (live via a docStore
 * transaction; Ctrl = ripple, adjacent edge = roll), Ctrl+wheel cursor
 * anchored zoom, wheel vertical scroll, Shift+wheel pan, ruler scrub,
 * library asset drop (pointer DnD).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  formatTimecode,
  snapUsToFrameGrid,
  type MicroSec,
  type Uuid,
} from '@videoedit/timeline-schema';
import { useAssetStore } from '../../state/assetStore';
import { useDocStore, type Transaction } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import {
  addClipFromAsset,
  addTrack,
  addTransitionAtEdge,
  applyTrimToDraft,
  assertDocValidDev,
  clipEndUs,
  findTransitionCut,
  knownAssetDurations,
  moveClips,
  planMoveClips,
  projectEndUs,
  removeTransition,
  setTransitionDuration,
  setTransitionType,
  toggleTrackHidden,
  toggleTrackLocked,
  toggleTrackMuted,
  transitionAt,
  addTransitionBlockReason,
  type OpResult,
  type TrimEdge,
  type TrimMode,
} from '../../state/timelineOps';
import { autoFitSettled, decideAutoFit } from './autoFit';
import { ConflictDialog } from './ConflictDialog';
import {
  buildTimelineMenu,
  type TimelineMenuActionId,
  type TimelineMenuTarget,
} from './contextMenu';
import { MOVE_CONFLICT_MESSAGE, WARNING_TTL_MS, opFailureMessage, opNoticeMessage } from './feedback';
import { runTimelineMenuAction } from './menuActions';
import { TransitionEditor } from './TransitionEditor';
import { clampScrollUs, maxPanScrollUs, panScrollUs, panScrollY } from './pan';
import { TimelineContextMenu } from './TimelineContextMenu';
import {
  RULER_H,
  TRACK_GAP,
  TRACK_H,
  clampPxPerUs,
  fitPxPerUs,
  timeToX,
  trackIndexAtY,
  trackTop,
  tracksContentHeight,
  xToTime,
} from './geometry';
import { hitTestClips, type ClipHitRect } from './hitTest';
import {
  registerTimelineDropTarget,
  useLibraryDndStore,
  type LibraryDragPayload,
} from './libraryDnd';
import { drawRuler } from './render/drawRuler';
import { drawTracks, type DragVisual } from './render/drawTracks';
import { setMediaCacheInvalidator } from './render/mediaCache';
import { collectSnapCandidates, resolveMoveSnap, resolveSnap } from './snapping';
import { registerTimelineViewControl } from './viewControl';

const DRAG_THRESHOLD_PX = 4;

type PointerState =
  | { mode: 'idle' }
  | { mode: 'scrub'; pointerId: number }
  | {
      mode: 'pendingClip';
      pointerId: number;
      startX: number;
      startY: number;
      hit: ClipHitRect;
      additive: boolean;
      wasSelected: boolean;
    }
  | {
      mode: 'pendingMarquee';
      pointerId: number;
      startX: number;
      startY: number;
      additive: boolean;
      baseSelection: Uuid[];
    }
  | {
      mode: 'move';
      pointerId: number;
      clipIds: Uuid[];
      anchorId: Uuid;
      anchorStartUs: MicroSec;
      anchorDurationUs: MicroSec;
      anchorTrackIndex: number;
      grabOffsetUs: MicroSec;
      candidates: MicroSec[];
      last: { deltaUs: MicroSec; trackDelta: number; valid: boolean; reason: string | null };
    }
  | {
      mode: 'trim';
      pointerId: number;
      tx: Transaction;
      clipId: Uuid;
      edge: TrimEdge;
      trimMode: TrimMode;
      candidates: MicroSec[];
      durations: Map<string, MicroSec>;
      /**
       * Sürükleme SIRASINDA geçiş kısaltıldıysa/kaldırıldıysa bildirim kodu.
       * Uyarı balonu bırakma anında gösterilir: her pointermove'da göstermek
       * balonu titretirdi, hiç göstermemek ise sessiz düzeltme olurdu.
       */
      transitionNotice: string | null;
    }
  | {
      mode: 'marquee';
      pointerId: number;
      startX: number;
      startY: number;
      additive: boolean;
      baseSelection: Uuid[];
    }
  /**
   * Kesim rozetine basıldı. Düzenleyici BIRAKMA anında açılır: basma anında
   * açmak, TransitionEditor'ın "dışarı tıklayınca kapan" dinleyicisiyle aynı
   * jestin bırakma/tıklama zincirine denk gelir ve panel bir açıp bir kapatır.
   */
  | {
      mode: 'transitionBadge';
      pointerId: number;
      clipId: Uuid;
      startX: number;
      startY: number;
    }
  /** Orta fare tuşuyla kaydırma (pan) — doküman değişmez, yalnız görünüm. */
  | {
      mode: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      startScrollUs: MicroSec;
      startScrollY: number;
    };

/**
 * Sağ tık menüsünün açık durumu (client koordinatları + hedef).
 *
 * `playheadUs` menünün AÇILDIĞI andaki playhead'dir ve menü kapanana kadar
 * DONAR: hem menü içeriği (buildTimelineMenu) hem çalıştırılan op
 * (runTimelineMenuAction) bu tek değeri kullanır. Menü açıkken playhead'in
 * kayması (oynatma sürüyor olabilir) menüyü bayatlatıyor ve kullanıcının
 * gördüğünden BAŞKA bir yerde kesme riski doğuruyordu.
 */
interface MenuState {
  x: number;
  y: number;
  target: TimelineMenuTarget;
  playheadUs: MicroSec;
}

/**
 * Açık geçiş düzenleyicisi. Kesim, DAİMA `(clipId, 'out')` ile adreslenir —
 * yani kesimin SOLUNDAKİ (giden) klip. Kesimin kimliği bu; bir taraf silinir
 * ya da kesim bozulursa `findTransitionCut` null döner ve düzenleyici kapanır
 * (bayat bir düzeltici artık var olmayan bir kesime yazamaz).
 */
interface TransitionEditorState {
  x: number;
  y: number;
  clipId: Uuid;
}

export function TimelinePanel() {
  // NOTE: deliberately NO React selector on playheadUs — during playback the
  // engine writes it every frame and a selector would re-render the whole
  // panel (header, buttons, track list) 60x/s. The playhead overlay canvas and
  // the timecode readout are updated imperatively via store subscriptions
  // below (chief-architect finding 12).
  const doc = useDocStore((s) => s.doc);
  const pxPerUs = useEditorStore((s) => s.pxPerUs);
  const scrollUs = useEditorStore((s) => s.scrollUs);
  const selection = useEditorStore((s) => s.selection);
  const snappingEnabled = useEditorStore((s) => s.snappingEnabled);
  const assets = useAssetStore((s) => s.assets);
  const libDrag = useLibraryDndStore((s) => s.drag);
  const sessionStatus = useProjectSession((s) => s.status);
  const sessionError = useProjectSession((s) => s.error);
  const sessionLoading = sessionStatus === 'loading';

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const [scrollY, setScrollY] = useState(0);
  const scrollYRef = useRef(0);
  scrollYRef.current = scrollY;

  const hitsRef = useRef<ClipHitRect[]>([]);
  const dragVisualRef = useRef<DragVisual | null>(null);
  const pointerRef = useRef<PointerState>({ mode: 'idle' });
  const rafRef = useRef(0);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const [transitionEditor, setTransitionEditor] = useState<TransitionEditorState | null>(null);
  const closeTransitionEditor = useCallback(() => setTransitionEditor(null), []);

  // Kısa süreli inline uyarı (çakışan taşıma, reddedilen menü eylemi …).
  // Sessiz ret kullanıcıya "çalışmıyor" hissi veriyordu.
  const [warning, setWarning] = useState<string | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warn = useCallback((message: string) => {
    setWarning(message);
    if (warnTimerRef.current !== null) clearTimeout(warnTimerRef.current);
    warnTimerRef.current = setTimeout(() => {
      warnTimerRef.current = null;
      setWarning(null);
    }, WARNING_TTL_MS);
  }, []);
  useEffect(
    () => () => {
      if (warnTimerRef.current !== null) clearTimeout(warnTimerRef.current);
    },
    [],
  );
  /**
   * Op sonucunu balona çevir. Başarısızlıkta ret gerekçesi, BAŞARIDA da
   * `notice` varsa bilgilendirme gösterilir: "geçiş süresi kısaltıldı" gibi
   * istenmemiş düzeltmeler sessiz kalırsa kullanıcı ürünün kendi kendine
   * bir şeyler değiştirdiğini düşünür (rendering-semantics §5.5 kısaltmayı
   * zorunlu kılıyor, görünürlük bizim borcumuz).
   */
  const reportOp = useCallback(
    (result: OpResult) => {
      if (!result.ok) {
        warn(opFailureMessage(result.reason));
        return;
      }
      const notice = opNoticeMessage(result.notice);
      if (notice !== null) warn(notice);
    },
    [warn],
  );

  /**
   * Kesim rozetine tıklandığında geçiş düzenleyicisini açar.
   *
   * BOŞ bir kesimde düzenleyici ancak geçiş EKLENEBİLİYORSA açılır; aksi halde
   * op'un kendi gerekçesi balona düşer. Kaynak payı olmayan bir kesimde altı
   * tip düğmesini gösterip her birinde ret vermek, kullanıcıya "tıklıyorum bir
   * şey olmuyor" dedirtirdi — gerekçe tıklamadan ÖNCE söylenir.
   */
  const openTransitionEditorAt = useCallback(
    (clipId: Uuid, clientX: number, clientY: number) => {
      if (useProjectSession.getState().status !== 'ready') return;
      const d = useDocStore.getState().doc;
      const cut = findTransitionCut(d, clipId, 'out');
      if (!cut) return;
      if (cut.track.locked) {
        warn(opFailureMessage('track is locked'));
        return;
      }
      if (transitionAt(cut) === undefined) {
        const blocked = addTransitionBlockReason(d, clipId, 'out');
        if (blocked !== null) {
          warn(opFailureMessage(blocked));
          return;
        }
      }
      setMenu(null);
      setTransitionEditor({ x: clientX, y: clientY, clipId });
    },
    [warn],
  );

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------

  const drawPlayhead = useCallback(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { w, h } = viewportRef.current;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    const st = useEditorStore.getState();
    const x = Math.round(timeToX(st.playheadUs, st.scrollUs, st.pxPerUs)) + 0.5;
    if (x >= -4 && x <= w + 4) {
      ctx.strokeStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }, []);

  const drawAll = useCallback(() => {
    const { w, h } = viewportRef.current;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const d = useDocStore.getState().doc;
    const st = useEditorStore.getState();

    const rulerCtx = rulerRef.current?.getContext('2d');
    if (rulerCtx) {
      rulerCtx.setTransform(1, 0, 0, 1, 0, 0);
      drawRuler(rulerCtx, {
        widthPx: w,
        dpr,
        scrollUs: st.scrollUs,
        pxPerUs: st.pxPerUs,
        fps: d.settings.fps,
        markers: d.markers,
      });
    }

    const bodyCtx = bodyRef.current?.getContext('2d');
    if (bodyCtx) {
      bodyCtx.setTransform(1, 0, 0, 1, 0, 0);
      hitsRef.current = drawTracks(bodyCtx, {
        doc: d,
        widthPx: w,
        heightPx: h - RULER_H,
        dpr,
        scrollUs: st.scrollUs,
        pxPerUs: st.pxPerUs,
        scrollY: scrollYRef.current,
        selection: st.selection,
        assets: useAssetStore.getState().assets,
        drag: dragVisualRef.current,
      });
    }
    drawPlayhead();
  }, [drawPlayhead]);

  const requestDraw = useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = 1;
    // rAF for normal paced painting; a timeout fallback keeps the canvas
    // fresh when the window is occluded/hidden (rAF suspended).
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      rafRef.current = 0;
      drawAll();
    };
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }, [drawAll]);

  // Canvas sizing: synchronous initial measure (ResizeObserver's first
  // callback is paint-driven and unreliable in occluded windows), then a
  // ResizeObserver for subsequent layout changes. dpr-scaled backing stores.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = (): void => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      const size = (canvas: HTMLCanvasElement | null, cssH: number): void => {
        if (!canvas) return;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(cssH * dpr));
        canvas.style.width = `${w}px`;
        canvas.style.height = `${cssH}px`;
      };
      size(rulerRef.current, RULER_H);
      size(bodyRef.current, Math.max(0, h - RULER_H));
      size(overlayRef.current, h);
      setViewport({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Redraw triggers.
  useEffect(() => {
    requestDraw();
  }, [doc, pxPerUs, scrollUs, selection, snappingEnabled, assets, viewport, scrollY, requestDraw]);

  // Playhead-only overlay redraw (cheap path used during playback): imperative
  // store subscription, no React render involved. Zoom/scroll/viewport changes
  // repaint the overlay through drawAll above.
  useEffect(() => {
    const unsub = useEditorStore.subscribe((s, prev) => {
      if (s.playheadUs !== prev.playheadUs) drawPlayhead();
    });
    drawPlayhead();
    return unsub;
  }, [drawPlayhead]);

  // Async media (sprites/manifests/peaks) landing -> repaint.
  useEffect(() => {
    setMediaCacheInvalidator(requestDraw);
    return () => setMediaCacheInvalidator(null);
  }, [requestDraw]);

  // ---------------------------------------------------------------------
  // Zoom / pan / fit
  // ---------------------------------------------------------------------

  /**
   * TEK yatay kaydırma yazma yolu — her zaman [0, maxPanScrollUs] arasına
   * kelepçeler. Orta tuş pan'i, Shift+wheel ve zoom hepsi buradan geçer;
   * sınırsız kalan bir yol tek jestte "boş timeline" üretiyordu.
   */
  const applyScrollUs = useCallback((next: MicroSec, pxPerUs?: number) => {
    const st = useEditorStore.getState();
    const zoom = pxPerUs ?? st.pxPerUs;
    const max = maxPanScrollUs(
      projectEndUs(useDocStore.getState().doc),
      viewportRef.current.w,
      zoom,
    );
    st.setScrollUs(clampScrollUs(next, max));
  }, []);

  const zoomAt = useCallback(
    (anchorX: number, factor: number) => {
      const st = useEditorStore.getState();
      const next = clampPxPerUs(st.pxPerUs * factor);
      if (next === st.pxPerUs) return;
      const cursorTime = st.scrollUs + anchorX / st.pxPerUs;
      st.setPxPerUs(next);
      // Yeni zoom ile kelepçele: uzaklaşırken görünür aralık büyüdüğü için üst
      // sınır küçülür, eski scroll değeri sınırın dışında kalabilir.
      applyScrollUs(cursorTime - anchorX / next, next);
    },
    [applyScrollUs],
  );

  const fitToProject = useCallback(() => {
    const d = useDocStore.getState().doc;
    const st = useEditorStore.getState();
    const w = viewportRef.current.w || 800;
    st.setPxPerUs(fitPxPerUs(w, projectEndUs(d)));
    st.setScrollUs(0);
  }, []);

  useEffect(
    () => registerTimelineViewControl({
      zoomBy: (factor) => zoomAt(viewportRef.current.w / 2, factor),
      fitToProject,
    }),
    [zoomAt, fitToProject],
  );

  // Otomatik sığdırma — proje açılışında görünümü içeriğe oturt (autoFit.ts).
  //
  // Bu efekt DOKÜMAN ve VIEWPORT değişimlerinde de çalışır ama kararı
  // decideAutoFit verir: sığdırma proje oturumu başına yalnız bir kez uygulanır
  // (kullanıcının zoom'u asla ezilmez) ve canvas henüz ölçülmemişse 'wait'
  // dönerek ilk ölçümü bekler (yarış yok, uydurma genişlikle yanlış zoom yok).
  const autoFitAppliedRef = useRef(false);
  useEffect(() => {
    if (sessionStatus === 'loading' || sessionStatus === 'idle') {
      autoFitAppliedRef.current = false;
      return;
    }
    const decision = decideAutoFit({
      sessionStatus,
      contentEndUs: projectEndUs(useDocStore.getState().doc),
      viewportWidthPx: viewport.w,
      alreadyApplied: autoFitAppliedRef.current,
    });
    if (autoFitSettled(decision)) autoFitAppliedRef.current = true;
    if (decision.kind === 'fit') {
      const st = useEditorStore.getState();
      st.setPxPerUs(decision.pxPerUs);
      st.setScrollUs(decision.scrollUs);
    }
  }, [sessionStatus, viewport.w, doc]);

  // Wheel: Ctrl=zoom (cursor anchored), Shift=pan, plain=vertical scroll.
  // Native non-passive listener (React attaches wheel passively).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      if (e.ctrlKey) {
        zoomAt(localX, e.deltaY < 0 ? 1.2 : 1 / 1.2);
      } else if (e.shiftKey) {
        const st = useEditorStore.getState();
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        // Orta tuş pan'iyle AYNI üst sınır — iki yol da içeriği ekrandan atamaz.
        applyScrollUs(st.scrollUs + delta / st.pxPerUs);
      } else {
        const trackCount = useDocStore.getState().doc.tracks.length;
        const bodyH = Math.max(0, viewportRef.current.h - RULER_H);
        const maxScroll = Math.max(0, tracksContentHeight(trackCount) - bodyH);
        setScrollY((y) => Math.min(maxScroll, Math.max(0, y + e.deltaY)));
      }
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyScrollUs]);

  // ---------------------------------------------------------------------
  // Pointer interactions
  // ---------------------------------------------------------------------

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const x = clientX - (rect?.left ?? 0);
    const y = clientY - (rect?.top ?? 0);
    return { x, y, contentY: y - RULER_H + scrollYRef.current };
  }, []);

  const scrubTo = useCallback((localX: number) => {
    const st = useEditorStore.getState();
    const d = useDocStore.getState().doc;
    const t = snapUsToFrameGrid(xToTime(localX, st.scrollUs, st.pxPerUs), d.settings.fps);
    st.setPlayheadUs(t);
  }, []);

  const marqueeSelect = useCallback(
    (state: Extract<PointerState, { mode: 'marquee' }>, x1: number, y1: number) => {
      const d = useDocStore.getState().doc;
      const st = useEditorStore.getState();
      const minX = Math.min(state.startX, x1);
      const maxX = Math.max(state.startX, x1);
      const minY = Math.min(state.startY, y1);
      const maxY = Math.max(state.startY, y1);
      const picked = new Set(state.baseSelection);
      for (let ti = 0; ti < d.tracks.length; ti++) {
        const top = trackTop(ti);
        if (top > maxY || top + TRACK_H < minY) continue;
        for (const clip of d.tracks[ti].clips) {
          const cx = timeToX(clip.timelineStartUs, st.scrollUs, st.pxPerUs);
          const cw = clip.timelineDurationUs * st.pxPerUs;
          if (cx <= maxX && cx + cw >= minX) picked.add(clip.id);
        }
      }
      st.setSelection(picked);
      dragVisualRef.current = { kind: 'marquee', x0: state.startX, y0: state.startY, x1, y1 };
      requestDraw();
    },
    [requestDraw],
  );

  const finishInteraction = useCallback(() => {
    pointerRef.current = { mode: 'idle' };
    dragVisualRef.current = null;
    requestDraw();
  }, [requestDraw]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      // Orta tuş: sürükleyerek kaydırma (pan). Boşlukta space+sürükleme
      // GEREKMEZ; preventDefault Windows'un orta tuş otomatik kaydırmasını da
      // devre dışı bırakır.
      if (e.button === 1) {
        e.preventDefault();
        wrap.setPointerCapture(e.pointerId);
        const p = localPoint(e.clientX, e.clientY);
        pointerRef.current = {
          mode: 'pan',
          pointerId: e.pointerId,
          startX: p.x,
          startY: p.y,
          startScrollUs: useEditorStore.getState().scrollUs,
          startScrollY: scrollYRef.current,
        };
        wrap.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      wrap.setPointerCapture(e.pointerId);
      const { x, y, contentY } = localPoint(e.clientX, e.clientY);
      const st = useEditorStore.getState();
      const d = useDocStore.getState().doc;

      if (y < RULER_H) {
        pointerRef.current = { mode: 'scrub', pointerId: e.pointerId };
        scrubTo(x);
        return;
      }

      const hit = hitTestClips(hitsRef.current, x, contentY);
      if (hit) {
        const track: (typeof d.tracks)[number] | undefined = d.tracks[hit.trackIndex];
        // Kesim rozeti: sürükleme YOK, bırakınca düzenleyici açılır.
        if (hit.region === 'transition') {
          pointerRef.current = {
            mode: 'transitionBadge',
            pointerId: e.pointerId,
            clipId: hit.clipId,
            startX: x,
            startY: contentY,
          };
          return;
        }
        if (track && !track.locked && (hit.region === 'trimL' || hit.region === 'trimR')) {
          // Selection follows the trimmed clip.
          if (!st.selection.has(hit.clipId)) st.setSelection([hit.clipId]);
          const clip = track.clips.find((c) => c.id === hit.clipId);
          let trimMode: TrimMode = 'normal';
          if (e.ctrlKey || e.metaKey) {
            trimMode = 'ripple';
          } else if (clip) {
            const idx = track.clips.indexOf(clip);
            const neighbor =
              hit.region === 'trimL' ? track.clips[idx - 1] : track.clips[idx + 1];
            const adjacent =
              neighbor !== undefined &&
              (hit.region === 'trimL'
                ? clipEndUs(neighbor) === clip.timelineStartUs
                : clipEndUs(clip) === neighbor.timelineStartUs);
            if (adjacent) trimMode = 'roll';
          }
          const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
          pointerRef.current = {
            mode: 'trim',
            pointerId: e.pointerId,
            tx,
            clipId: hit.clipId,
            edge: hit.region === 'trimL' ? 'left' : 'right',
            trimMode,
            candidates: collectSnapCandidates(d, {
              excludeClipIds: new Set([hit.clipId]),
              playheadUs: st.playheadUs,
            }),
            durations: knownAssetDurations(),
            transitionNotice: null,
          };
          return;
        }

        // Body: selection now, drag decision on move.
        const additive = e.shiftKey;
        const wasSelected = st.selection.has(hit.clipId);
        if (additive) {
          if (!wasSelected) st.addToSelection(hit.clipId);
        } else if (!wasSelected) {
          st.setSelection([hit.clipId]);
        }
        pointerRef.current = {
          mode: 'pendingClip',
          pointerId: e.pointerId,
          startX: x,
          startY: contentY,
          hit,
          additive,
          wasSelected,
        };
        return;
      }

      // Empty area: marquee (or click-clear on release).
      pointerRef.current = {
        mode: 'pendingMarquee',
        pointerId: e.pointerId,
        startX: x,
        startY: contentY,
        additive: e.shiftKey,
        baseSelection: e.shiftKey ? [...st.selection] : [],
      };
    },
    [localPoint, scrubTo],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerRef.current;
      const { x, y, contentY } = localPoint(e.clientX, e.clientY);
      const st = useEditorStore.getState();
      const d = useDocStore.getState().doc;

      // Hover cursor feedback (idle only).
      if (state.mode === 'idle') {
        const wrap = wrapRef.current;
        if (wrap) {
          const hover = hitTestClips(hitsRef.current, x, contentY);
          wrap.style.cursor =
            hover?.region === 'transition'
              ? 'pointer'
              : hover?.region === 'trimL' || hover?.region === 'trimR'
                ? 'ew-resize'
                : 'default';
        }
        return;
      }
      if (state.mode === 'scrub') {
        scrubTo(x);
        return;
      }

      if (state.mode === 'pan') {
        st.setScrollUs(
          panScrollUs(
            state.startScrollUs,
            state.startX,
            x,
            st.pxPerUs,
            maxPanScrollUs(projectEndUs(d), viewportRef.current.w, st.pxPerUs),
          ),
        );
        const bodyH = Math.max(0, viewportRef.current.h - RULER_H);
        const maxScroll = Math.max(0, tracksContentHeight(d.tracks.length) - bodyH);
        setScrollY(panScrollY(state.startScrollY, state.startY, y, maxScroll));
        return;
      }

      if (state.mode === 'pendingClip') {
        const dist = Math.hypot(x - state.startX, contentY - state.startY);
        if (dist < DRAG_THRESHOLD_PX) return;
        // Promote to move drag: drag the whole selection when the grabbed clip
        // is part of it, else just the grabbed clip. The grabbed anchor goes
        // FIRST — planMoveClips snaps the delta against clipIds[0], and the
        // snap guide (resolveMoveSnap) also anchors on the grabbed clip.
        const ids = (st.selection.has(state.hit.clipId) ? [...st.selection] : [state.hit.clipId])
          .filter((id) => {
            for (const track of d.tracks) {
              if (track.clips.some((c) => c.id === id)) return !track.locked;
            }
            return false;
          })
          .sort((a, b) => (a === state.hit.clipId ? -1 : b === state.hit.clipId ? 1 : 0));
        if (ids.length === 0) return;
        const anchorTrackIndex = state.hit.trackIndex;
        const anchor = d.tracks[anchorTrackIndex]?.clips.find((c) => c.id === state.hit.clipId);
        if (!anchor) return;
        const grabTime = xToTime(state.startX, st.scrollUs, st.pxPerUs);
        pointerRef.current = {
          mode: 'move',
          pointerId: state.pointerId,
          clipIds: ids,
          anchorId: anchor.id,
          anchorStartUs: anchor.timelineStartUs,
          anchorDurationUs: anchor.timelineDurationUs,
          anchorTrackIndex,
          grabOffsetUs: grabTime - anchor.timelineStartUs,
          candidates: collectSnapCandidates(d, {
            excludeClipIds: new Set(ids),
            playheadUs: st.playheadUs,
          }),
          last: { deltaUs: 0, trackDelta: 0, valid: true, reason: null },
        };
        return;
      }

      if (state.mode === 'move') {
        const pointerTime = xToTime(x, st.scrollUs, st.pxPerUs);
        const rawDelta = pointerTime - state.grabOffsetUs - state.anchorStartUs;
        const snap = resolveMoveSnap(
          state.anchorStartUs,
          state.anchorDurationUs,
          rawDelta,
          state.candidates,
          st.pxPerUs,
          d.settings.fps,
          st.snappingEnabled,
        );
        const row = trackIndexAtY(contentY, d.tracks.length);
        const trackDelta =
          typeof row === 'number' ? row - state.anchorTrackIndex : state.last.trackDelta;
        const plan = planMoveClips(d, state.clipIds, snap.deltaUs, trackDelta);
        state.last = {
          deltaUs: snap.deltaUs,
          trackDelta,
          valid: plan.ok,
          // Bırakınca gösterilecek uyarının gerekçesi (sessiz ret yok).
          reason: plan.ok ? null : plan.reason,
        };

        const ghosts: Extract<DragVisual, { kind: 'move' }>['ghosts'] = [];
        for (const id of state.clipIds) {
          for (let ti = 0; ti < d.tracks.length; ti++) {
            const clip = d.tracks[ti].clips.find((c) => c.id === id);
            if (!clip) continue;
            ghosts.push({
              clipId: id,
              trackIndex: Math.max(0, Math.min(d.tracks.length - 1, ti + trackDelta)),
              startUs: Math.max(0, clip.timelineStartUs + snap.deltaUs),
              durationUs: clip.timelineDurationUs,
            });
          }
        }
        dragVisualRef.current = { kind: 'move', ghosts, valid: plan.ok, guideUs: snap.snappedTo };
        requestDraw();
        return;
      }

      if (state.mode === 'trim') {
        const raw = xToTime(x, st.scrollUs, st.pxPerUs);
        const snap = resolveSnap(
          raw,
          state.candidates,
          st.pxPerUs,
          d.settings.fps,
          st.snappingEnabled,
        );
        state.tx.update((draft) => {
          const result = applyTrimToDraft(
            draft,
            state.clipId,
            state.edge,
            snap.timeUs,
            state.trimMode,
            state.durations,
          );
          // Kırpma geçişli bir kenarı bozduysa op bunu `notice` ile söyler.
          // İlk bildirimi SAKLA: aynı sürüklemede sonraki adımlar (geçiş artık
          // kısalmış olduğu için) sessiz döner ve bilgi kaybolurdu.
          if (result.ok && result.notice !== undefined && state.transitionNotice === null) {
            state.transitionNotice = result.notice;
          }
        });
        dragVisualRef.current = { kind: 'trim', guideUs: snap.snappedTo };
        requestDraw();
        return;
      }

      if (state.mode === 'transitionBadge') return; // rozet sürüklenmez

      if (state.mode === 'pendingMarquee') {
        const dist = Math.hypot(x - state.startX, contentY - state.startY);
        if (dist < DRAG_THRESHOLD_PX) return;
        pointerRef.current = { ...state, mode: 'marquee' };
        marqueeSelect(pointerRef.current as Extract<PointerState, { mode: 'marquee' }>, x, contentY);
        return;
      }

      if (state.mode === 'marquee') {
        marqueeSelect(state, x, contentY);
      }
    },
    [localPoint, marqueeSelect, requestDraw, scrubTo],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = pointerRef.current;
      const st = useEditorStore.getState();
      if (state.mode === 'idle') return;
      if ('pointerId' in state && state.pointerId !== e.pointerId) return;

      if (state.mode === 'pendingClip') {
        // Plain click: collapse selection / additive click: toggle off.
        if (state.additive) {
          if (state.wasSelected) st.removeFromSelection(state.hit.clipId);
        } else {
          st.setSelection([state.hit.clipId]);
        }
      } else if (state.mode === 'pendingMarquee') {
        if (!state.additive) st.clearSelection();
      } else if (state.mode === 'move') {
        const moved = state.last.deltaUs !== 0 || state.last.trackDelta !== 0;
        if (moved && !state.last.valid) {
          // Çakışma/kilit yüzünden reddedilen taşıma artık SESSİZ değil.
          warn(
            state.last.reason !== null
              ? opFailureMessage(state.last.reason)
              : MOVE_CONFLICT_MESSAGE,
          );
        } else if (moved) {
          reportOp(moveClips(state.clipIds, state.last.deltaUs, state.last.trackDelta));
        }
      } else if (state.mode === 'trim') {
        state.tx.commit();
        assertDocValidDev('trim drag');
        const notice = opNoticeMessage(state.transitionNotice);
        if (notice !== null) warn(notice);
      } else if (state.mode === 'transitionBadge') {
        openTransitionEditorAt(state.clipId, e.clientX, e.clientY);
      } else if (state.mode === 'pan') {
        const wrap = wrapRef.current;
        if (wrap) wrap.style.cursor = 'default';
      }
      finishInteraction();
    },
    [finishInteraction, openTransitionEditorAt, reportOp, warn],
  );

  const cancelInteraction = useCallback(() => {
    const state = pointerRef.current;
    if (state.mode === 'trim') state.tx.abort();
    if (state.mode === 'pan') {
      const wrap = wrapRef.current;
      if (wrap) wrap.style.cursor = 'default';
    }
    if (state.mode !== 'idle') finishInteraction();
  }, [finishInteraction]);

  // Esc cancels the active drag (capture phase, ahead of the global dispatcher).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && pointerRef.current.mode !== 'idle') {
        e.stopPropagation();
        cancelInteraction();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancelInteraction]);

  // ---------------------------------------------------------------------
  // Sağ tık menüsü + çift tık
  // ---------------------------------------------------------------------

  // Proje yeniden yüklenirken menü/düzenleyici açık kalmasın (hedef kaybolabilir).
  useEffect(() => {
    if (sessionLoading) {
      setMenu(null);
      setTransitionEditor(null);
    }
  }, [sessionLoading]);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (pointerRef.current.mode !== 'idle') return; // sürükleme sürerken açma
      const { x, y, contentY } = localPoint(e.clientX, e.clientY);
      const st = useEditorStore.getState();
      const d = useDocStore.getState().doc;
      // Menü ömrü boyunca DONAN playhead (finding 4): içerik de eylem de bunu
      // kullanır, oynatma sürerken bile menü kendi gösterdiğiyle tutarlı kalır.
      const playheadUs = st.playheadUs;

      if (y < RULER_H) {
        setMenu({
          x: e.clientX,
          y: e.clientY,
          playheadUs,
          target: {
            kind: 'ruler',
            timeUs: snapUsToFrameGrid(xToTime(x, st.scrollUs, st.pxPerUs), d.settings.fps),
          },
        });
        return;
      }

      const hit = hitTestClips(hitsRef.current, x, contentY);
      if (hit) {
        // Menü açılırken klip seçili değilse seç (eylemler seçim üzerinden çalışır).
        if (!st.selection.has(hit.clipId)) st.setSelection([hit.clipId]);
        setMenu({
          x: e.clientX,
          y: e.clientY,
          playheadUs,
          // Tıklanan zaman menüye taşınır: geçiş öğeleri klibin hangi kesimini
          // kastettiğimizi bundan çıkarır (kesime yakın sağ tık = o kesim).
          target: {
            kind: 'clip',
            clipId: hit.clipId,
            timeUs: xToTime(x, st.scrollUs, st.pxPerUs),
          },
        });
        return;
      }

      const row = trackIndexAtY(contentY, d.tracks.length);
      const track = typeof row === 'number' ? d.tracks[row] : undefined;
      setMenu({
        x: e.clientX,
        y: e.clientY,
        playheadUs,
        target: track ? { kind: 'track', trackId: track.id } : { kind: 'empty' },
      });
    },
    [localPoint],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const { x, y, contentY } = localPoint(e.clientX, e.clientY);
      if (y < RULER_H) return;
      const hit = hitTestClips(hitsRef.current, x, contentY);
      if (!hit) return;
      const clip = useDocStore
        .getState()
        .doc.tracks[hit.trackIndex]?.clips.find((c) => c.id === hit.clipId);
      if (!clip) return;
      // Keşfedilebilirlik: klibi seç ve playhead'i klip başına götür.
      const st = useEditorStore.getState();
      st.setSelection([hit.clipId]);
      st.setPlayheadUs(clip.timelineStartUs);
    },
    [localPoint],
  );

  /**
   * Menü eylemleri — eşleme menuActions.ts'te (MEVCUT timelineOps çağrıları,
   * yeni düzenleme mantığı yok). Menünün AÇILIŞ anındaki seçim ve DONMUŞ
   * playhead geçirilir, böylece op menünün gösterdiği bağlamda çalışır.
   * Başarısız sonuçlar uyarı balonuna düşer.
   */
  const runMenuAction = useCallback(
    (id: TimelineMenuActionId) => {
      const open = menu;
      closeMenu();
      if (open === null) return;
      if (useProjectSession.getState().status !== 'ready') return;
      reportOp(
        runTimelineMenuAction(id, {
          target: open.target,
          selection: [...useEditorStore.getState().selection],
          playheadUs: open.playheadUs,
        }),
      );
    },
    [closeMenu, menu, reportOp],
  );

  // ---------------------------------------------------------------------
  // Library drag-and-drop (pointer DnD from LibraryPanel)
  // ---------------------------------------------------------------------

  const insertTargetFor = useCallback(
    (clientX: number, clientY: number, payload: LibraryDragPayload) => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      if (
        clientX < rect.left || clientX > rect.right ||
        clientY < rect.top + RULER_H || clientY > rect.bottom
      ) {
        return null;
      }
      const localX = clientX - rect.left;
      const contentY = clientY - rect.top - RULER_H + scrollYRef.current;
      const st = useEditorStore.getState();
      const d = useDocStore.getState().doc;
      const row = trackIndexAtY(contentY, d.tracks.length);
      const raw = xToTime(localX, st.scrollUs, st.pxPerUs);
      const snap = resolveSnap(
        raw,
        collectSnapCandidates(d, { playheadUs: st.playheadUs }),
        st.pxPerUs,
        d.settings.fps,
        st.snappingEnabled,
      );
      const startUs = snap.timeUs;
      const durationUs = payload.durationUs;

      if (row === null) return null;
      if (row === 'new') {
        return { trackIndex: 'new' as const, startUs, durationUs, valid: true, guideUs: snap.snappedTo };
      }
      const track = d.tracks[row];
      const required = payload.kind === 'audio' ? 'audio' : 'video';
      let valid = track.type === required && !track.locked;
      if (valid) {
        for (const c of track.clips) {
          if (startUs < clipEndUs(c) && c.timelineStartUs < startUs + durationUs) {
            valid = false;
            break;
          }
        }
      }
      return { trackIndex: row, startUs, durationUs, valid, guideUs: snap.snappedTo };
    },
    [],
  );

  // Ghost while a library asset hovers the timeline.
  useEffect(() => {
    if (!libDrag) {
      if (dragVisualRef.current?.kind === 'insert') {
        dragVisualRef.current = null;
        requestDraw();
      }
      return;
    }
    const target = insertTargetFor(libDrag.clientX, libDrag.clientY, libDrag);
    dragVisualRef.current = target
      ? {
          kind: 'insert',
          trackIndex: target.trackIndex,
          startUs: target.startUs,
          durationUs: target.durationUs,
          valid: target.valid,
          guideUs: target.guideUs,
        }
      : null;
    requestDraw();
  }, [libDrag, insertTargetFor, requestDraw]);

  useEffect(
    () =>
      registerTimelineDropTarget({
        drop: (pos, payload) => {
          // A drop landing while a project is (re)loading must not mutate the
          // outgoing document (finding 1b) — the docStore is locked anyway.
          if (useProjectSession.getState().status !== 'ready') return;
          const target = insertTargetFor(pos.clientX, pos.clientY, payload);
          if (!target || !target.valid) return;
          const d = useDocStore.getState().doc;
          if (target.trackIndex === 'new') {
            addClipFromAsset(payload.assetId, { newTrack: true }, target.startUs);
          } else {
            const track = d.tracks[target.trackIndex];
            if (track) addClipFromAsset(payload.assetId, { trackId: track.id }, target.startUs);
          }
        },
      }),
    [insertTargetFor],
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const fps = doc.settings.fps;

  // Menü içeriği bağlamdan SAF olarak üretilir (contextMenu.ts). Playhead
  // menü state'inden gelir — menü açılırken DONDURULMUŞ değerdir; canlı
  // playhead'e selector bağlanmıyor (panel oynatma sırasında yeniden render
  // edilmesin diye, bkz. dosya başı notu) ve zaten bağlanmamalı: menü içeriği
  // ile eylemin çalıştığı an aynı olmalı.
  const menuEntries =
    menu !== null
      ? buildTimelineMenu({
          target: menu.target,
          doc,
          selection: [...selection],
          playheadUs: menu.playheadUs,
          mutationAllowed: sessionStatus === 'ready',
        })
      : [];

  // Geçiş düzenleyicisinin CANLI bağlamı. `doc` değiştikçe yeniden türetilir,
  // böylece op'un yazdığı (ve gerekirse KISALTTIĞI) değer alanlara anında
  // yansır. Kesim ortadan kalktıysa (undo, silme, taşıma) null döner ve
  // düzenleyici kapanır — bayat bir düzenleyici var olmayan kesime yazamaz.
  const transitionCut =
    transitionEditor !== null ? findTransitionCut(doc, transitionEditor.clipId, 'out') : null;
  useEffect(() => {
    if (transitionEditor !== null && transitionCut === null) setTransitionEditor(null);
  }, [transitionEditor, transitionCut]);

  const runTransitionOp = useCallback(
    (op: () => OpResult, closeAfter = false) => {
      if (useProjectSession.getState().status !== 'ready') return;
      reportOp(op());
      if (closeAfter) setTransitionEditor(null);
    },
    [reportOp],
  );

  // Timecode readout: imperative textContent updates (no React re-render per
  // playback frame — finding 12). Re-synced when fps/doc changes.
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const update = (): void => {
      const el = timecodeRef.current;
      if (!el) return;
      el.textContent = formatTimecode(
        useEditorStore.getState().playheadUs,
        useDocStore.getState().doc.settings.fps,
      );
    };
    update();
    const unsub = useEditorStore.subscribe((s, prev) => {
      if (s.playheadUs !== prev.playheadUs) update();
    });
    return unsub;
  }, [fps]);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-edge bg-surface-2 px-3 py-1.5">
        <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Timeline</span>
        <button
          type="button"
          title="Video track ekle"
          disabled={sessionLoading}
          className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
          onClick={() => {
            if (!sessionLoading) addTrack('video');
          }}
        >
          +V
        </button>
        <button
          type="button"
          title="Ses track'i ekle"
          disabled={sessionLoading}
          className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
          onClick={() => {
            if (!sessionLoading) addTrack('audio');
          }}
        >
          +A
        </button>
        <span ref={timecodeRef} className="ml-2 font-mono text-xs text-fg" title="Playhead (HH:MM:SS:FF)">
          {formatTimecode(useEditorStore.getState().playheadUs, fps)}
        </span>
        <span className="font-mono text-[10px] text-fg-muted">
          / {formatTimecode(projectEndUs(doc), fps)}
        </span>
        {/* Kısa süreli inline uyarı: reddedilen taşıma / menü eylemi. */}
        {warning !== null && (
          <span
            role="status"
            data-testid="timeline-warning"
            className="ml-2 truncate rounded border border-danger/60 bg-danger/15 px-2 py-0.5 text-[11px] text-danger"
          >
            {warning}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {sessionStatus === 'error' && (
            <span className="text-[10px] text-danger" title={sessionError ?? undefined}>
              Proje yüklenemedi
            </span>
          )}
          <button
            type="button"
            title="Yapışma (S)"
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              snappingEnabled
                ? 'border-accent/60 text-accent'
                : 'border-edge text-fg-muted hover:text-fg'
            }`}
            onClick={() => useEditorStore.getState().toggleSnapping()}
          >
            Snap
          </button>
          <button
            type="button"
            title="Uzaklaştır (-)"
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={() => zoomAt(viewportRef.current.w / 2, 1 / 1.25)}
          >
            −
          </button>
          <button
            type="button"
            title="Yakınlaştır (+)"
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={() => zoomAt(viewportRef.current.w / 2, 1.25)}
          >
            +
          </button>
          <button
            type="button"
            title="Sığdır (Shift+Z)"
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={fitToProject}
          >
            Fit
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Track header column (DOM, scroll-synced with the canvas body). */}
        <div className="w-[170px] shrink-0 overflow-hidden border-r border-edge bg-surface-1">
          <div style={{ height: RULER_H }} className="border-b border-edge bg-surface-2" />
          <div className="relative overflow-hidden" style={{ height: `calc(100% - ${RULER_H}px)` }}>
            <div style={{ transform: `translateY(${-scrollY}px)` }}>
              {doc.tracks.map((track, i) => (
                <div
                  key={track.id}
                  className="flex items-center gap-1 px-2"
                  style={{ height: TRACK_H, marginBottom: TRACK_GAP }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      playheadUs: useEditorStore.getState().playheadUs,
                      target: { kind: 'track', trackId: track.id },
                    });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
                    {track.name ?? `${track.type === 'audio' ? 'Ses' : track.type === 'overlay' ? 'Overlay' : 'Video'} ${i + 1}`}
                  </span>
                  <TrackToggle
                    label="M"
                    title="Sessize al"
                    active={track.muted}
                    onClick={() => toggleTrackMuted(track.id)}
                  />
                  <TrackToggle
                    label="H"
                    title="Gizle"
                    active={track.hidden}
                    onClick={() => toggleTrackHidden(track.id)}
                  />
                  <TrackToggle
                    label="L"
                    title="Kilitle"
                    active={track.locked}
                    onClick={() => toggleTrackLocked(track.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Canvas stack. */}
        <div
          ref={wrapRef}
          className="relative min-w-0 flex-1 touch-none overflow-hidden select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelInteraction}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
          // Orta tuşun tarayıcı otomatik kaydırmasını bastır (pan modu bizde).
          onAuxClick={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
        >
          <canvas ref={rulerRef} className="block" />
          <canvas ref={bodyRef} className="block" />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" />
        </div>
      </div>

      {/* Project-loading lock: blocks every pointer interaction with the
          timeline until the server document is adopted (finding 1a). The
          docStore lock + shortcut gating cover the non-pointer paths. */}
      {sessionLoading && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-surface-0/60"
          aria-busy="true"
          data-testid="timeline-loading-overlay"
        >
          <span className="rounded border border-edge bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
            Proje yükleniyor…
          </span>
        </div>
      )}

      {menuEntries.length > 0 && menu !== null && (
        <TimelineContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries}
          onSelect={runMenuAction}
          onClose={closeMenu}
        />
      )}

      {transitionEditor !== null && transitionCut !== null && (
        <TransitionEditor
          x={transitionEditor.x}
          y={transitionEditor.y}
          cutUs={clipEndUs(transitionCut.a)}
          fps={fps}
          current={transitionAt(transitionCut)}
          mutationAllowed={sessionStatus === 'ready'}
          onPickType={(type) => {
            const clipId = transitionEditor.clipId;
            // Boş kesimde tip seçmek EKLEME, dolu kesimde tip DEĞİŞTİRMEdir;
            // ikisi de tek history girdisi.
            runTransitionOp(() =>
              transitionAt(transitionCut) === undefined
                ? addTransitionAtEdge(clipId, 'out', type)
                : setTransitionType(clipId, 'out', type),
            );
          }}
          onSetDuration={(durationUs) => {
            const clipId = transitionEditor.clipId;
            runTransitionOp(() => setTransitionDuration(clipId, 'out', durationUs));
          }}
          onRemove={() => {
            const clipId = transitionEditor.clipId;
            runTransitionOp(() => removeTransition(clipId, 'out'), true);
          }}
          onClose={closeTransitionEditor}
        />
      )}

      <ConflictDialog />
    </div>
  );
}

function TrackToggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`h-5 w-5 rounded border text-[10px] font-semibold ${
        active
          ? 'border-accent/60 bg-accent/20 text-accent'
          : 'border-edge text-fg-muted hover:bg-surface-3 hover:text-fg'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
