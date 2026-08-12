/**
 * KeyframeStripOverlay — the keyframe lane drawn over the timeline canvas.
 *
 * Why a separate overlay instead of more code inside TimelinePanel:
 * - TimelinePanel's body canvas owns the hit-rect pipeline for clips, trim
 *   handles and transition badges. Adding a fourth region type there would
 *   entangle the keyframe editor with every existing gesture; here the strip
 *   owns exactly its own pixels and TimelinePanel gains ONE render call.
 * - A press that hits NO diamond is deliberately NOT consumed: no
 *   stopPropagation, so it bubbles to the timeline wrap and the clip drag /
 *   trim / marquee it was aimed at happens as before. Only a press that lands
 *   on a diamond is captured. That is what makes this overlay additive rather
 *   than a new source of "the timeline stopped responding".
 *
 * Gesture contract (same shape as the timeline's own drags):
 * - drag a diamond      -> one docStore transaction -> ONE history entry
 * - double click        -> remove that keyframe     -> one entry
 * - right click         -> easing menu (linear / easeIn / easeOut / easeInOut)
 * - click the "+N" chip -> channel menu: promote a folded channel into a row
 * - Escape mid-drag     -> abort, document restored exactly
 * - unmount mid-drag    -> abort (an open transaction freezes autosave and
 *                          makes the NEXT mutate/undo throw)
 *
 * WHY THE CHIP IS A BUTTON
 * ------------------------
 * The band only fits `KEYFRAME_STRIP_MAX_ROWS` rows, so a clip animating three
 * or more channels folded the rest into a decorative "+N". Everything the strip
 * uniquely offers — moving a keyframe IN TIME, deleting it, its easing menu —
 * was therefore unreachable for those channels: no other surface moves a
 * keyframe in time. The chip now opens a channel list and the picked channel
 * takes a row (`preferChannels`), which keeps the two-row budget while making
 * every animated channel reachable.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Easing, MicroSec, Uuid } from '@videoedit/timeline-schema';
import { useDocStore, type Transaction } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import { assertDocValidDev } from '../../state/timelineOps';
import { RULER_H } from '../timeline/geometry';
import { drawKeyframeStrip } from '../timeline/render/drawKeyframes';
import { CHANNEL_META, EASING_OPTIONS, type KeyframeChannel } from './keyframeModel';
import {
  applyMoveKeyframeToDraft,
  removeKeyframe,
  setKeyframeEasing,
} from './keyframeOps';
import { clampMenuPoint } from './menuPosition';
import {
  buildStripLayout,
  hitTestStrip,
  hitTestStripChip,
  stripHitRect,
  xToClipTimeUs,
  type StripLayout,
} from './stripGeometry';

interface DragState {
  pointerId: number;
  clipId: Uuid;
  channel: KeyframeChannel;
  /** Where the keyframe is RIGHT NOW (it moves as the drag progresses). */
  currentTimeUs: MicroSec;
  /** pointerTime - keyframeTime at press, so the diamond does not jump. */
  grabOffsetUs: MicroSec;
  tx: Transaction;
  detach: () => void;
}

interface EasingMenuState {
  x: number;
  y: number;
  clipId: Uuid;
  channel: KeyframeChannel;
  timeUs: MicroSec;
  current: Easing;
}

/** The "+N" chip's menu: pick which animated channel gets a strip row. */
interface ChannelMenuState {
  x: number;
  y: number;
}

export interface KeyframeStripOverlayProps {
  /** TimelinePanel's vertical scroll (track rows are not in the store). */
  scrollY: number;
}

export function KeyframeStripOverlay({ scrollY }: KeyframeStripOverlayProps) {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const scrollUs = useEditorStore((s) => s.scrollUs);
  const pxPerUs = useEditorStore((s) => s.pxPerUs);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [menu, setMenu] = useState<EasingMenuState | null>(null);
  const [channelMenu, setChannelMenu] = useState<ChannelMenuState | null>(null);
  /**
   * Channels promoted from the "+N" chip, most recent first. VIEW state, not
   * document state: it must not enter history or autosave, and a stale entry is
   * harmless because `buildStripLayout` ignores channels that are no longer
   * animated.
   */
  const [preferChannels, setPreferChannels] = useState<KeyframeChannel[]>([]);
  /** Diamond to highlight (hover or drag) — redraw trigger, not document state. */
  const [active, setActive] = useState<{ channel: string; timeUs: number } | null>(null);

  // Own the measurement: the overlay is inset-0 inside the timeline wrap, so
  // its box IS the wrap box and no prop plumbing is needed for width/height.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = (): void => {
      const r = host.getBoundingClientRect();
      const w = Math.max(0, Math.floor(r.width));
      const h = Math.max(0, Math.floor(r.height));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const layout: StripLayout | null = useMemo(
    () => buildStripLayout({ doc, selection, scrollUs, pxPerUs, widthPx: size.w, preferChannels }),
    [doc, selection, scrollUs, pxPerUs, size.w, preferChannels],
  );

  // A different clip is a different set of channels; carrying the previous
  // clip's picks over would show rows the user never asked for HERE.
  const clipId = layout?.clipId ?? null;
  useEffect(() => {
    setPreferChannels((prev) => (prev.length === 0 ? prev : []));
    setChannelMenu(null);
  }, [clipId]);

  // Paint. The canvas is dpr-scaled here (it is this overlay's own canvas, not
  // one of TimelinePanel's three).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.max(1, Math.round(size.w * dpr));
    const wantH = Math.max(1, Math.round(size.h * dpr));
    if (canvas.width !== wantW) canvas.width = wantW;
    if (canvas.height !== wantH) canvas.height = wantH;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    drawKeyframeStrip(ctx, {
      layout,
      widthPx: size.w,
      heightPx: size.h,
      dpr,
      scrollY,
      active,
    });
  }, [layout, size, scrollY, active]);

  /** Client point -> timeline CONTENT space (same convention as hitTest.ts). */
  const localPoint = useCallback(
    (clientX: number, clientY: number): { x: number; contentY: number } => {
      const r = hostRef.current?.getBoundingClientRect();
      return {
        x: clientX - (r?.left ?? 0),
        contentY: clientY - (r?.top ?? 0) - RULER_H + scrollY,
      };
    },
    [scrollY],
  );

  const editable = layout !== null && layout.editable && sessionReady;

  /** THE single exit of a drag — idempotent, callable from anywhere. */
  const finishDrag = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.detach();
    if (commit) {
      drag.tx.commit();
      assertDocValidDev('keyframe drag');
    } else {
      drag.tx.abort();
    }
    setActive(null);
  }, []);

  // Escape aborts; unmount aborts. An open transaction outliving this component
  // would freeze autosave and make the next mutate/undo throw.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (dragRef.current !== null) {
        e.preventDefault();
        e.stopPropagation();
        finishDrag(false);
        return;
      }
      setMenu((m) => (m === null ? m : null));
      setChannelMenu((m) => (m === null ? m : null));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [finishDrag]);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      drag.detach();
      drag.tx.abort();
    },
    [],
  );

  // The strip disappeared mid-drag (selection changed, clip deleted, undo):
  // the user cannot finish the gesture, so abort rather than leave it open.
  useEffect(() => {
    if (layout === null && dragRef.current !== null) finishDrag(false);
  }, [layout, finishDrag]);

  // A menu anchored to the click point runs off the window near the right or
  // bottom edge — visible to a DOM query, unreachable by a real pointer. Clamp
  // against the measured box, after layout (see menuPosition.ts).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (menu !== null) {
      const next = clampMenuPoint(menu, size, viewport);
      if (next.x !== menu.x || next.y !== menu.y) setMenu({ ...menu, ...next });
      return;
    }
    if (channelMenu !== null) {
      const next = clampMenuPoint(channelMenu, size, viewport);
      if (next.x !== channelMenu.x || next.y !== channelMenu.y) setChannelMenu(next);
    }
  }, [menu, channelMenu]);

  // Close the open menu on any press elsewhere (capture phase, so it lands
  // before a timeline drag opens its own transaction).
  useEffect(() => {
    if (menu === null && channelMenu === null) return;
    const onDown = (e: PointerEvent): void => {
      // Capture phase runs BEFORE the menu's own handlers, so a press inside
      // the menu must be recognised here or the item would be unmounted before
      // its click ever fires.
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
      setChannelMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [menu, channelMenu]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || layout === null) return;
      const { x, contentY } = localPoint(e.clientX, e.clientY);
      // The chip is painted OVER the first row, so it is tested first — a
      // diamond underneath must not steal its press.
      if (hitTestStripChip(layout, x, contentY)) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        setChannelMenu((m) => (m === null ? { x: e.clientX, y: e.clientY } : null));
        return;
      }
      const hit = hitTestStrip(layout, x, contentY);
      // MISS: do not consume. The press belongs to the clip/trim/marquee under
      // it and must reach TimelinePanel exactly as before.
      if (!hit) return;
      if (!editable) {
        // Locked track / project loading: swallow the press so a read-only
        // strip does not start a clip drag the user did not aim for.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      setChannelMenu(null);
      e.currentTarget.setPointerCapture(e.pointerId);

      const pointerTimeUs = xToClipTimeUs(layout, x, scrollUs, pxPerUs);
      const onRelease = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        finishDrag(ev.type === 'pointerup');
      };
      window.addEventListener('pointerup', onRelease);
      window.addEventListener('pointercancel', onRelease);

      dragRef.current = {
        pointerId: e.pointerId,
        clipId: layout.clipId,
        channel: hit.channel,
        currentTimeUs: hit.timeUs,
        grabOffsetUs: pointerTimeUs - hit.timeUs,
        tx: useDocStore.getState().beginTransaction(
          'keyframeMove',
          `${CHANNEL_META[hit.channel].label} keyframe taşındı`,
        ),
        detach: () => {
          window.removeEventListener('pointerup', onRelease);
          window.removeEventListener('pointercancel', onRelease);
        },
      };
      setActive({ channel: hit.channel, timeUs: hit.timeUs });
    },
    [layout, localPoint, editable, scrollUs, pxPerUs, finishDrag],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const { x, contentY } = localPoint(e.clientX, e.clientY);
      if (!drag) {
        // Idle: highlight what the pointer would grab. Never consume the event
        // (the timeline's own hover cursor logic still needs it). Over the chip
        // nothing is grabbable — highlighting the diamond hiding under it would
        // promise an ew-resize drag that the press will not start.
        const overChip = layout !== null && hitTestStripChip(layout, x, contentY);
        const hit = layout && !overChip ? hitTestStrip(layout, x, contentY) : null;
        setActive((prev) => {
          const next = hit ? { channel: hit.channel, timeUs: hit.timeUs } : null;
          if (prev === null && next === null) return prev;
          if (prev && next && prev.channel === next.channel && prev.timeUs === next.timeUs) {
            return prev;
          }
          return next;
        });
        return;
      }
      if (e.pointerId !== drag.pointerId || layout === null) return;
      e.stopPropagation();
      const wantUs = xToClipTimeUs(layout, x, scrollUs, pxPerUs) - drag.grabOffsetUs;
      drag.tx.update((d) => {
        const moved = applyMoveKeyframeToDraft(
          d,
          drag.clipId,
          drag.channel,
          drag.currentTimeUs,
          wantUs,
        );
        if (moved.ok) drag.currentTimeUs = moved.timeUs;
      });
      setActive({ channel: drag.channel, timeUs: drag.currentTimeUs });
    },
    [layout, localPoint, scrollUs, pxPerUs],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null || e.pointerId !== dragRef.current.pointerId) return;
      e.stopPropagation();
      finishDrag(true);
    },
    [finishDrag],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (layout === null) return;
      const { x, contentY } = localPoint(e.clientX, e.clientY);
      // A double click on the chip is two chip clicks, never a delete of the
      // diamond hiding under it.
      if (hitTestStripChip(layout, x, contentY)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const hit = hitTestStrip(layout, x, contentY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (!editable) return;
      removeKeyframe(layout.clipId, hit.channel, hit.timeUs);
      setActive(null);
    },
    [layout, localPoint, editable],
  );

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (layout === null) return;
      const { x, contentY } = localPoint(e.clientX, e.clientY);
      if (hitTestStripChip(layout, x, contentY)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const hit = hitTestStrip(layout, x, contentY);
      // Miss: let the timeline's own context menu open.
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (!editable) return;
      const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === layout.clipId);
      const current: Easing =
        clip?.keyframes[hit.channel]?.find((k) => k.timeUs === hit.timeUs)?.easing ?? {
          type: 'linear',
        };
      setMenu({
        x: e.clientX,
        y: e.clientY,
        clipId: layout.clipId,
        channel: hit.channel,
        timeUs: hit.timeUs,
        current,
      });
    },
    [layout, localPoint, editable, doc],
  );

  /**
   * The band's SCREEN box, clipped to the body area. Without the clamp a band
   * scrolled up under the ruler would keep a live hit area on top of the ruler
   * and swallow scrub clicks.
   */
  const hitBox = useMemo(() => {
    if (layout === null) return null;
    const rect = stripHitRect(layout);
    const top = Math.max(RULER_H, RULER_H + rect.y - scrollY);
    const bottom = Math.min(size.h, RULER_H + rect.y - scrollY + rect.height);
    if (bottom <= top || rect.width <= 0) return null;
    return { left: rect.x, top, width: rect.width, height: bottom - top };
  }, [layout, scrollY, size.h]);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      <canvas
        ref={canvasRef}
        data-testid="keyframe-strip-canvas"
        className="pointer-events-none absolute top-0 left-0"
      />
      {hitBox !== null && layout !== null && (
        <div
          data-testid="keyframe-strip"
          data-clip-id={layout.clipId}
          data-rows={layout.rows.map((r) => r.channel).join(',')}
          data-hidden-channels={layout.hiddenChannels.length}
          data-chip={layout.chipRect === null ? 'none' : 'shown'}
          className="pointer-events-auto absolute touch-none"
          style={{
            left: hitBox.left,
            top: hitBox.top,
            width: hitBox.width,
            height: hitBox.height,
            cursor: active !== null ? 'ew-resize' : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        />
      )}
      {menu !== null && (
        <div
          ref={menuRef}
          data-testid="keyframe-easing-menu"
          role="menu"
          className="pointer-events-auto fixed z-50 min-w-[150px] rounded border border-edge bg-surface-2 py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <p className="px-2 pb-1 text-[10px] text-fg-muted">
            {CHANNEL_META[menu.channel].label} — geçiş eğrisi
          </p>
          {EASING_OPTIONS.map((option) => (
            <button
              key={option.type}
              type="button"
              role="menuitem"
              data-testid={`keyframe-easing-${option.type}`}
              aria-checked={menu.current.type === option.type}
              className={`block w-full px-2 py-1 text-left text-[11px] hover:bg-surface-3 ${
                menu.current.type === option.type ? 'text-accent' : 'text-fg'
              }`}
              onClick={() => {
                setKeyframeEasing(menu.clipId, menu.channel, menu.timeUs, {
                  type: option.type,
                });
                setMenu(null);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {channelMenu !== null && layout !== null && (
        <div
          ref={menuRef}
          data-testid="keyframe-channel-menu"
          role="menu"
          className="pointer-events-auto fixed z-50 min-w-[150px] rounded border border-edge bg-surface-2 py-1 shadow-lg"
          style={{ left: channelMenu.x, top: channelMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <p className="px-2 pb-1 text-[10px] text-fg-muted">Şeritte göster (en fazla 2)</p>
          {layout.animatedChannels.map((channel) => {
            const shown = layout.rows.some((r) => r.channel === channel);
            return (
              <button
                key={channel}
                type="button"
                role="menuitem"
                data-testid={`keyframe-channel-${channel}`}
                data-shown={shown ? 'true' : 'false'}
                aria-checked={shown}
                className={`block w-full px-2 py-1 text-left text-[11px] hover:bg-surface-3 ${
                  shown ? 'text-accent' : 'text-fg'
                }`}
                onClick={() => {
                  // Most recent first: the pick always wins a row, and the
                  // channel it displaces is the one picked longest ago.
                  setPreferChannels((prev) => [channel, ...prev.filter((c) => c !== channel)]);
                  setChannelMenu(null);
                }}
              >
                {shown ? '● ' : '○ '}
                {CHANNEL_META[channel].label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
