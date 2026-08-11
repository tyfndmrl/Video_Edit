/**
 * Transform gizmo — the draggable box over the preview canvas.
 *
 * This component is deliberately THIN: every number it draws or writes comes
 * from core/gizmo.ts + core/transform.ts (rendering-semantics §2), and every
 * document change goes through state/timelineOps.applyClipTransformToDraft —
 * the SAME code path the inspector's numeric fields use. There is no second
 * transform implementation anywhere in the player.
 *
 * Interaction contract:
 * - Visible only while the player is PAUSED and exactly one visual clip is
 *   selected AND that clip is under the playhead (you cannot drag a box for a
 *   clip you are not looking at) on a visible, unlocked track.
 * - One drag = one docStore transaction = ONE undo entry; autosave defers
 *   until the commit (docStore.transactionOpen), so a half-finished drag is
 *   never PUT to the server.
 * - A gesture ALWAYS closes. The box is conditionally rendered (it disappears
 *   when playback starts, the selection changes, the playhead leaves the clip
 *   or the panel unmounts), so "pointerup on the SVG" is not a guarantee — and
 *   a transaction left open freezes autosave and makes the NEXT mutate/undo
 *   throw (docStore.assertNoActiveTransaction). Every exit is covered:
 *   window pointerup/pointercancel (the inspector's liveEdit safety net),
 *   geometry loss while dragging, and unmount.
 * - Escape aborts mid-drag and restores the pre-drag document exactly.
 * - A pointerdown that hits nothing is NOT swallowed: the click keeps bubbling
 *   to the panel, so click-to-play still works with a clip selected. A real
 *   drag suppresses that click.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { isMediaClip } from '@videoedit/timeline-schema';
import type { Transform, Uuid } from '@videoedit/timeline-schema';
import { useDocStore, type Transaction } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { applyClipTransformToDraft, maxClipScale } from '../../state/timelineOps';
import { useAssetStore } from '../../state/assetStore';
import type { SourceSize } from './engine';
import { effectiveTransform, resolveVisualStack } from './core/resolve';
import {
  computeGizmoGeometry,
  cornerCompPoint,
  gizmoDragPatch,
  hitTestGizmo,
  type CornerHandle,
  type GizmoDragStart,
  type GizmoGeometry,
  type GizmoHandle,
} from './core/gizmo';
import { fitViewport, screenToComp, type Point } from './core/viewport';

/** Movement (screen px) before a press becomes a drag — same idea as the timeline. */
const DRAG_THRESHOLD_PX = 3;

/** History labels mirror the op's transformLabel() so the panel reads uniformly. */
const DRAG_LABEL: Record<GizmoHandle, string> = {
  move: 'Konum değiştirildi',
  rotate: 'Döndürme değiştirildi',
  nw: 'Ölçek değiştirildi',
  ne: 'Ölçek değiştirildi',
  se: 'Ölçek değiştirildi',
  sw: 'Ölçek değiştirildi',
};

const CURSOR: Record<GizmoHandle, string> = {
  move: 'move',
  rotate: 'grab',
  nw: 'nwse-resize',
  ne: 'nesw-resize',
  se: 'nwse-resize',
  sw: 'nesw-resize',
};

interface DragState {
  pointerId: number;
  start: GizmoDragStart;
  tx: Transaction;
  clipIds: Uuid[];
  /** Pointer position at pointerdown, CONTAINER-local px (threshold check). */
  origin: Point;
  /** True once the drag passed DRAG_THRESHOLD_PX (patches start flowing). */
  active: boolean;
  /** Removes the window-level release listeners for THIS gesture. */
  detach: () => void;
}

export interface TransformGizmoProps {
  /** The positioned panel box the overlay covers (also the coordinate origin). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The compositor canvas — its client box defines the composition viewport. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Engine-reported natural media size (most accurate w_s/h_s), if decoded. */
  getSourceSize: (clipId: Uuid) => SourceSize | null;
  /** Push the edited document into the engine now instead of after the debounce. */
  flushPreviewLoad: () => void;
  /** Gizmo is hidden during playback (a moving target cannot be grabbed). */
  isPlaying: boolean;
}

interface Rects {
  /** Canvas box relative to the container. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function TransformGizmo({
  containerRef,
  canvasRef,
  getSourceSize,
  flushPreviewLoad,
  isPlaying,
}: TransformGizmoProps) {
  const doc = useDocStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const assets = useAssetStore((s) => s.assets);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [rects, setRects] = useState<Rects | null>(null);
  const [srcSize, setSrcSize] = useState<SourceSize | null>(null);
  const [hoverHandle, setHoverHandle] = useState<GizmoHandle | null>(null);

  /**
   * The clip the gizmo belongs to. resolveVisualStack does the semantic work:
   * hidden tracks and audio clips are already excluded there, so the gizmo can
   * never appear for something the compositor is not drawing.
   */
  const target = useMemo(() => {
    if (isPlaying || selection.size !== 1) return null;
    const [clipId] = [...selection];
    if (clipId === undefined) return null;
    const found = resolveVisualStack(doc, playheadUs).find((a) => a.clip.id === clipId);
    if (!found || found.track.locked) return null;
    if (!isMediaClip(found.clip)) return null; // text/shape/sticker: M3+ shapes
    return found;
  }, [doc, selection, playheadUs, isPlaying]);

  const clipId = target?.clip.id ?? null;

  /**
   * Keep the measured boxes and the decoded media size fresh with ONE rAF
   * loop: canvas layout can change without a React render (panel resize, split
   * drag, scroll) and the media size only appears once the decoder has a frame.
   * State is written only when a value actually changes, so this does not
   * re-render per frame.
   */
  useEffect(() => {
    if (clipId === null) {
      setRects(null);
      setSrcSize(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (container && canvas) {
        const c = container.getBoundingClientRect();
        const v = canvas.getBoundingClientRect();
        const next: Rects = {
          left: v.left - c.left,
          top: v.top - c.top,
          width: v.width,
          height: v.height,
        };
        setRects((prev) =>
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
            ? prev
            : next,
        );
      }
      const size = getSourceSize(clipId);
      setSrcSize((prev) =>
        (prev?.width ?? null) === (size?.width ?? null) &&
        (prev?.height ?? null) === (size?.height ?? null)
          ? prev
          : size,
      );
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [clipId, containerRef, canvasRef, getSourceSize]);

  /**
   * THE single exit of a gesture, callable from a React event, a window
   * listener, an effect or an unmount cleanup. Idempotent: whoever gets here
   * first clears dragRef, the rest are no-ops.
   */
  const finishDrag = useCallback(
    (commit: boolean, opts: { suppressClick?: boolean } = {}) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      drag.detach();
      if (commit) drag.tx.commit();
      else drag.tx.abort();
      // A real drag must not also toggle play/pause on the trailing click.
      suppressClickRef.current = opts.suppressClick ?? drag.active;
      flushPreviewLoad();
    },
    [flushPreviewLoad],
  );

  /** Escape aborts the drag; the document returns to its pre-drag state. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || dragRef.current === null) return;
      e.preventDefault();
      e.stopPropagation();
      finishDrag(false, { suppressClick: true });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [finishDrag]);

  /**
   * Unmount with a gesture in flight (panel closed, project switched, route
   * change): abort so the store is never left with an open transaction. Runs
   * exactly once, and deliberately does NOT go through finishDrag — nothing
   * downstream of an unmounted component should be poked.
   */
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

  const compW = doc.settings.width;
  const compH = doc.settings.height;

  /**
   * w_s / h_s (§2.1). Decoder first (it is what the compositor samples), asset
   * probe metadata second, composition size last — the fallback keeps the box
   * meaningful (it is exactly the "fit" rectangle) before anything is decoded.
   */
  const source: SourceSize = useMemo(() => {
    if (srcSize && srcSize.width > 0 && srcSize.height > 0) return srcSize;
    const assetId = target && isMediaClip(target.clip) ? target.clip.assetId : null;
    const asset = assetId ? assets.get(assetId) : undefined;
    if (asset?.width && asset.height) return { width: asset.width, height: asset.height };
    return { width: compW, height: compH };
  }, [srcSize, target, assets, compW, compH]);

  /** Transform to DRAW: keyframes applied, i.e. what is on screen right now. */
  const shownTransform: Transform | null = useMemo(
    () => (target ? effectiveTransform(target.clip, playheadUs) : null),
    [target, playheadUs],
  );

  /**
   * A keyframed transform is animated: dragging the box would write the BASE
   * transform and appear to do nothing. Rather than lie, the gizmo goes
   * read-only and says why.
   */
  const keyframed = useMemo(() => {
    const kf = target?.clip.keyframes;
    if (!kf) return false;
    return Boolean(
      kf.x?.length || kf.y?.length || kf.scale?.length || kf.rotationDeg?.length,
    );
  }, [target]);

  const geometry: GizmoGeometry | null = useMemo(() => {
    if (!rects || !shownTransform || rects.width <= 0 || rects.height <= 0) return null;
    const mapping = fitViewport(compW, compH, rects);
    if (mapping.scale <= 0) return null;
    return computeGizmoGeometry({
      srcW: source.width,
      srcH: source.height,
      compW,
      compH,
      transform: shownTransform,
      mapping,
    });
  }, [rects, shownTransform, compW, compH, source]);

  /**
   * The box vanished while a gesture was running — Space started playback, the
   * selection changed, the playhead left the clip, the panel collapsed. The
   * user can no longer finish the drag (there is nothing left to release on),
   * so the gesture is ABORTED: the document returns to its pre-drag state and,
   * crucially, the transaction closes. Leaving it open was the actual defect:
   * autosave stays deferred forever and the next mutate/undo throws.
   */
  useEffect(() => {
    if (geometry === null && dragRef.current !== null) {
      finishDrag(false, { suppressClick: true });
    }
  }, [geometry, finishDrag]);

  const localPoint = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): Point => {
      const container = containerRef.current;
      if (!container) return { x: e.clientX, y: e.clientY };
      const r = container.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    [containerRef],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 || !geometry || !target || !shownTransform || keyframed) return;
      const point = localPoint(e);
      const handle = hitTestGizmo(geometry, point);
      // Miss: do NOT capture. The event keeps bubbling, so clicking the picture
      // next to a selected clip still toggles playback.
      if (!handle) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const pointerComp = screenToComp(geometry.mapping, point);
      const start: GizmoDragStart = {
        handle,
        pointer: pointerComp,
        transform: shownTransform,
        placement: geometry.placement,
        compW,
        compH,
        // The op's OWN ceiling function, not a re-derivation of it. The bound
        // is project-dependent (the compiler measures the scaled layer box) AND
        // capped by a resolution-independent sanity limit; importing
        // maxClipScale is the only way the box cannot stop following the
        // pointer at a limit the document does not actually enforce.
        maxScale: maxClipScale(doc.settings),
        corner:
          handle === 'move' || handle === 'rotate'
            ? undefined
            : cornerCompPoint(geometry.placement, source.width, source.height, handle),
      };
      // Safety net (same mechanism as inspector/liveEdit.ts): the release that
      // ends this gesture may never reach the SVG — it can unmount mid-drag, or
      // the pointer can be released outside the document. window ALWAYS sees it.
      const onRelease = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        finishDrag(ev.type === 'pointerup');
      };
      window.addEventListener('pointerup', onRelease);
      window.addEventListener('pointercancel', onRelease);

      dragRef.current = {
        pointerId: e.pointerId,
        start,
        tx: useDocStore.getState().beginTransaction('clipTransform', DRAG_LABEL[handle]),
        clipIds: [target.clip.id],
        origin: point,
        active: false,
        detach: () => {
          window.removeEventListener('pointerup', onRelease);
          window.removeEventListener('pointercancel', onRelease);
        },
      };
    },
    [
      geometry,
      target,
      shownTransform,
      keyframed,
      localPoint,
      compW,
      compH,
      source,
      finishDrag,
      doc.settings,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      const point = localPoint(e);
      if (!drag) {
        // Idle: reflect what the pointer would grab in the cursor.
        const handle = geometry && !keyframed ? hitTestGizmo(geometry, point) : null;
        setHoverHandle((prev) => (prev === handle ? prev : handle));
        return;
      }
      if (e.pointerId !== drag.pointerId || !geometry) return;
      if (!drag.active) {
        const moved = Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y);
        if (moved < DRAG_THRESHOLD_PX) return; // still a click, not a drag
        drag.active = true;
      }
      const patch = gizmoDragPatch(drag.start, screenToComp(geometry.mapping, point), {
        shift: e.shiftKey,
      });
      if (Object.keys(patch).length === 0) return;
      drag.tx.update((d) => {
        applyClipTransformToDraft(d, drag.clipIds, patch);
      });
      // The engine's doc reload is debounced (100 ms); during a drag that reads
      // as lag between the box and the picture, so push it through now.
      flushPreviewLoad();
    },
    [geometry, keyframed, localPoint, flushPreviewLoad],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>, commit: boolean) => {
      if (e.pointerId !== dragRef.current?.pointerId) return;
      finishDrag(commit);
    },
    [finishDrag],
  );

  const onClickCapture = useCallback((e: ReactMouseEvent<SVGSVGElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  if (!geometry) return null;

  const { corners, rotateHandle, topMid } = geometry;
  const points = `${corners.nw.x},${corners.nw.y} ${corners.ne.x},${corners.ne.y} ${corners.se.x},${corners.se.y} ${corners.sw.x},${corners.sw.y}`;
  const cursor = dragRef.current
    ? CURSOR[dragRef.current.start.handle]
    : hoverHandle
      ? CURSOR[hoverHandle]
      : 'default';

  return (
    <svg
      data-testid="player-gizmo"
      data-clip-id={clipId ?? ''}
      data-keyframed={keyframed ? 'true' : 'false'}
      className="absolute inset-0 h-full w-full"
      // pointerEvents 'all' (not the SVG default 'visiblePainted'): the root
      // must receive the press even where nothing is painted, because the
      // authoritative hit test is hitTestGizmo(), not the DOM. A miss simply
      // is not captured and the click bubbles on to the panel.
      style={{ cursor, touchAction: 'none', pointerEvents: 'all' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onClickCapture={onClickCapture}
    >
      {/* Outline: dark under-stroke first so the box stays readable on any
          footage, bright stroke on top. */}
      <polygon
        data-testid="player-gizmo-box"
        points={points}
        fill="none"
        stroke="rgba(0,0,0,0.55)"
        strokeWidth={3}
        pointerEvents="none"
      />
      <polygon
        points={points}
        fill="none"
        stroke="#ffffff"
        strokeWidth={1.25}
        strokeDasharray={keyframed ? '5 4' : undefined}
        pointerEvents="none"
      />
      {!keyframed && (
        <>
          <line
            x1={topMid.x}
            y1={topMid.y}
            x2={rotateHandle.x}
            y2={rotateHandle.y}
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={3}
            pointerEvents="none"
          />
          <line
            x1={topMid.x}
            y1={topMid.y}
            x2={rotateHandle.x}
            y2={rotateHandle.y}
            stroke="#ffffff"
            strokeWidth={1.25}
            pointerEvents="none"
          />
          <circle
            data-testid="player-gizmo-rotate"
            cx={rotateHandle.x}
            cy={rotateHandle.y}
            r={6}
            fill="#ffffff"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={1.5}
            pointerEvents="none"
          />
          {(['nw', 'ne', 'se', 'sw'] as CornerHandle[]).map((corner) => (
            <rect
              key={corner}
              data-testid={`player-gizmo-corner-${corner}`}
              x={corners[corner].x - 5}
              y={corners[corner].y - 5}
              width={10}
              height={10}
              fill="#ffffff"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          ))}
        </>
      )}
      {keyframed && (
        <title>
          Bu klibin dönüşümü animasyonlu (keyframe). Kutuyu sürüklemek temel değeri
          değiştirir ve ekranda bir şey değişmezdi — değerleri Inspector&apos;dan düzenleyin.
        </title>
      )}
    </svg>
  );
}
