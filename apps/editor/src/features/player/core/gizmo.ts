/**
 * Preview transform gizmo — geometry, hit-testing and drag math. Pure (no DOM,
 * no store), so every pixel the user sees and every number the drag writes is
 * unit-testable.
 *
 * BINDING RULE: the box drawn here is the SAME quad the compositor draws. Both
 * go through core/transform.ts (rendering-semantics §2.4 open-pixel formula);
 * this module never re-derives the placement math. The gizmo box is literally
 * the image of the source rectangle [0..w_s] x [0..h_s] under sourceToScreen().
 *
 * Pivot: §2.3 fixes the ANCHOR as the point that (a) lands on
 * P = (W/2 + x*W, H/2 + y*H) and (b) rotation turns around. Since P does not
 * depend on `scale` either, the anchor is the fixed point of BOTH scaling and
 * rotation — so corner-scale and rotate never touch transform.x/y, and move
 * never touches scale/rotation. Each handle writes exactly one concern.
 *
 * Spaces (see core/viewport.ts):
 * - composition space: project output px (W x H) — where §2 math lives
 * - screen space: client px — where handle sizes and hit radii live
 * Geometry is emitted in BOTH: points in screen px (for drawing/hit-testing),
 * while drag math consumes composition-space pointer positions.
 */
import type { Transform } from '@videoedit/timeline-schema';
import { TRANSFORM_SCALE_DECIMALS, TRANSFORM_SCALE_MIN } from '@videoedit/timeline-schema';
import { computePlacement, screenToSource, sourceToScreen, type Placement } from './transform';
import { compToScreen, screenToComp, type Point, type ViewportMapping } from './viewport';

/** Handle hit radius in SCREEN px (finger-friendly, matches the drawn size). */
export const HANDLE_HIT_RADIUS_PX = 11;
/** Distance from the top edge to the rotate handle, SCREEN px. */
export const ROTATE_HANDLE_OFFSET_PX = 28;
/** Rotation snap step while Shift is held (deg). */
export const ROTATE_SNAP_DEG = 15;
/**
 * Scale band — NOT the gizmo's own numbers.
 *
 * The authority is the shared schema package (`TRANSFORM_SCALE_MIN` and
 * `maxScaleFor(settings)`), which is also what
 * state/timelineOps.applyClipTransformToDraft clamps with. The gizmo must never
 * propose a value the op would silently clamp, or the box would stop following
 * the pointer without saying why — so it imports the same constants instead of
 * mirroring them. The ceiling is PROJECT-DEPENDENT (the compiler bounds the
 * rendered layer box at MAX_LAYER_DIMENSION px, so a 4K project allows half the
 * scale of a 1080p one); it therefore travels with the gesture, in
 * GizmoDragStart.maxScale, rather than living here as a constant.
 */
export const MIN_SCALE = TRANSFORM_SCALE_MIN;

/** Decimals written to the document — identical to the op's rounding. */
const POSITION_DECIMALS = 4;
const SCALE_DECIMALS = TRANSFORM_SCALE_DECIMALS;
const ROTATION_DECIMALS = 2;

export type CornerHandle = 'nw' | 'ne' | 'se' | 'sw';
export type GizmoHandle = 'move' | 'rotate' | CornerHandle;

export const CORNER_HANDLES: readonly CornerHandle[] = ['nw', 'ne', 'se', 'sw'];

export interface GizmoGeometry {
  /** Placement used to build the quad (composition space). */
  placement: Placement;
  mapping: ViewportMapping;
  srcW: number;
  srcH: number;
  /** Quad corners in SCREEN px, source-space order nw -> ne -> se -> sw. */
  corners: Record<CornerHandle, Point>;
  /** Rotate handle centre, SCREEN px (outward from the top edge midpoint). */
  rotateHandle: Point;
  /** Top edge midpoint, SCREEN px — the rotate handle's stem root. */
  topMid: Point;
  /** The anchor = pivot of scale and rotation, SCREEN px. */
  anchor: Point;
}

export interface GizmoGeometryInput {
  srcW: number;
  srcH: number;
  compW: number;
  compH: number;
  transform: Transform;
  mapping: ViewportMapping;
  /**
   * Overlay rasters are not fit to the composition — see
   * core/transform.ts PlacementInput.baseScale. Passing it here is what keeps
   * "the box is the SAME quad the compositor draws" true for text/shape clips.
   */
  baseScale?: number;
  /** Override for tests / denser layouts. */
  rotateHandleOffsetPx?: number;
}

function unit(dx: number, dy: number, fallback: Point): Point {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len === 0) return fallback;
  return { x: dx / len, y: dy / len };
}

/**
 * Corners of the clip quad + handle positions, in screen px.
 * Source-space corner order is fixed (nw = source (0,0)), so the handles rotate
 * WITH the clip — grabbing "nw" always grabs the same image corner.
 */
export function computeGizmoGeometry(input: GizmoGeometryInput): GizmoGeometry {
  const { srcW, srcH, compW, compH, transform, mapping } = input;
  const placement = computePlacement({
    srcW,
    srcH,
    compW,
    compH,
    transform,
    baseScale: input.baseScale,
  });
  const toScreen = (sx: number, sy: number): Point =>
    compToScreen(mapping, sourceToScreen(placement, sx, sy));

  const corners: Record<CornerHandle, Point> = {
    nw: toScreen(0, 0),
    ne: toScreen(srcW, 0),
    se: toScreen(srcW, srcH),
    sw: toScreen(0, srcH),
  };
  const topMid = toScreen(srcW / 2, 0);
  const bottomMid = toScreen(srcW / 2, srcH);
  // Outward normal of the top edge = direction bottom -> top of the box.
  const up = unit(topMid.x - bottomMid.x, topMid.y - bottomMid.y, { x: 0, y: -1 });
  const offset = input.rotateHandleOffsetPx ?? ROTATE_HANDLE_OFFSET_PX;
  return {
    placement,
    mapping,
    srcW,
    srcH,
    corners,
    topMid,
    rotateHandle: { x: topMid.x + up.x * offset, y: topMid.y + up.y * offset },
    anchor: compToScreen(mapping, { x: placement.px, y: placement.py }),
  };
}

/**
 * Which handle is under a SCREEN-space point? Priority: rotate handle (it sits
 * outside the box), then corners, then the box body ('move'), else null.
 *
 * The body test is exact for a ROTATED box: the point is mapped back through
 * the §2 formula to source pixels and compared against [0..w_s] x [0..h_s] —
 * no axis-aligned bounding-box approximation (which would grab empty corners
 * of a rotated clip).
 */
export function hitTestGizmo(
  geo: GizmoGeometry,
  screenPoint: Point,
  handleRadiusPx: number = HANDLE_HIT_RADIUS_PX,
): GizmoHandle | null {
  const near = (p: Point): boolean =>
    Math.hypot(screenPoint.x - p.x, screenPoint.y - p.y) <= handleRadiusPx;

  if (near(geo.rotateHandle)) return 'rotate';
  for (const corner of CORNER_HANDLES) {
    if (near(geo.corners[corner])) return corner;
  }
  const comp = screenToComp(geo.mapping, screenPoint);
  const src = screenToSource(geo.placement, comp.x, comp.y);
  if (!Number.isFinite(src.x) || !Number.isFinite(src.y)) return null;
  if (src.x >= 0 && src.x <= geo.srcW && src.y >= 0 && src.y <= geo.srcH) return 'move';
  return null;
}

// ---------------------------------------------------------------------------
// Drag math
// ---------------------------------------------------------------------------

/** Only the fields a gizmo drag may write (anchor is never touched here). */
export type TransformPatch = Partial<Pick<Transform, 'x' | 'y' | 'scale' | 'rotationDeg'>>;

export interface GizmoDragStart {
  handle: GizmoHandle;
  /** Pointer position at pointerdown, COMPOSITION px. */
  pointer: Point;
  /** Transform when the gesture started (never mutated). */
  transform: Transform;
  /** Placement when the gesture started, COMPOSITION space. */
  placement: Placement;
  /** Composition size — normalized x/y are fractions of it (§2.1). */
  compW: number;
  compH: number;
  /**
   * Scale ceiling for THIS project — `maxScaleFor(doc.settings)`. Passed in
   * rather than imported so the pure drag math stays settings-free and the
   * caller cannot forget that the bound depends on the composition size.
   */
  maxScale: number;
  /** Grabbed corner position at pointerdown, COMPOSITION px (corner drags). */
  corner?: Point;
}

export interface DragModifiers {
  /** Move: lock to one axis. Rotate: snap to ROTATE_SNAP_DEG. */
  shift?: boolean;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Normalize to (-180, 180] so the inspector never shows 725 degrees. */
export function normalizeDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Clamp into [MIN_SCALE, maxScale]. `maxScale` is the project's derived ceiling
 * (maxScaleFor(settings)); a degenerate/absent ceiling collapses to the floor
 * rather than letting an unbounded value through.
 */
export function clampScale(scale: number, maxScale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  const hi = Number.isFinite(maxScale) ? Math.max(MIN_SCALE, maxScale) : MIN_SCALE;
  return Math.min(hi, Math.max(MIN_SCALE, scale));
}

/**
 * The transform patch for a pointer position (COMPOSITION px). Absolute, not
 * incremental: it is always computed from the GESTURE START state, so replaying
 * it with the same pointer yields the same result no matter how many
 * intermediate moves happened (no drift accumulation across a drag).
 *
 * Returns {} when the gesture cannot produce a meaningful change (degenerate
 * pivot distance, non-finite input) — the caller then writes nothing.
 */
export function gizmoDragPatch(
  start: GizmoDragStart,
  pointer: Point,
  mods: DragModifiers = {},
): TransformPatch {
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return {};
  const t = start.transform;

  if (start.handle === 'move') {
    let dx = pointer.x - start.pointer.x;
    let dy = pointer.y - start.pointer.y;
    if (mods.shift) {
      // Axis lock: keep the dominant axis, zero the other.
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (start.compW <= 0 || start.compH <= 0) return {};
    return {
      x: round(t.x + dx / start.compW, POSITION_DECIMALS),
      y: round(t.y + dy / start.compH, POSITION_DECIMALS),
    };
  }

  // Pivot for scale AND rotation is the anchor's composition position P (§2.3).
  const pivotX = start.placement.px;
  const pivotY = start.placement.py;

  if (start.handle === 'rotate') {
    const a0 = Math.atan2(start.pointer.y - pivotY, start.pointer.x - pivotX);
    const a1 = Math.atan2(pointer.y - pivotY, pointer.x - pivotX);
    // Screen y grows downward, so a positive atan2 delta IS clockwise (§2.1).
    const deltaDeg = ((a1 - a0) * 180) / Math.PI;
    let next = t.rotationDeg + deltaDeg;
    if (mods.shift) next = Math.round(next / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
    return { rotationDeg: round(normalizeDeg(next), ROTATION_DECIMALS) };
  }

  // Corner: uniform scale about the anchor. The factor is the projection of the
  // current pivot->pointer vector onto the pivot->corner vector at gesture
  // start; projecting (instead of comparing raw distances) keeps perpendicular
  // pointer wobble from inflating the scale and lets the drag pass through zero
  // smoothly into the clamp.
  const corner = start.corner;
  if (!corner) return {};
  const v0x = corner.x - pivotX;
  const v0y = corner.y - pivotY;
  const denom = v0x * v0x + v0y * v0y;
  if (denom === 0) return {}; // anchor sits exactly on the grabbed corner
  const factor = ((pointer.x - pivotX) * v0x + (pointer.y - pivotY) * v0y) / denom;
  return { scale: round(clampScale(t.scale * factor, start.maxScale), SCALE_DECIMALS) };
}

/** Corner position in COMPOSITION px — what gizmoDragPatch wants in `corner`. */
export function cornerCompPoint(
  placement: Placement,
  srcW: number,
  srcH: number,
  corner: CornerHandle,
): Point {
  const sx = corner === 'ne' || corner === 'se' ? srcW : 0;
  const sy = corner === 'se' || corner === 'sw' ? srcH : 0;
  return sourceToScreen(placement, sx, sy);
}
