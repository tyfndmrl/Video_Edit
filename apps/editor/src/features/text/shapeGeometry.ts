/**
 * Shape drawing geometry — the preview MIRROR of the export's authority,
 * `backend/src/VideoEdit.Media/Text/ShapeGeometry.cs`.
 *
 * BINDING CONTRACT (both sides, change together or the preview lies):
 * - the natural box of a shape is the PROJECT FRAME (W x H). `ShapeClip.shape`
 *   carries no width/height, so "scale = 1 means fit" (rendering-semantics
 *   §2.2) is only definable if the natural box IS the composition. `scale = 1`
 *   is therefore a full-frame rect/ellipse and the user scales DOWN.
 * - a line/arrow with no stroke width falls back to 1 % of the short edge
 *   (min 2 px); the arrow head is `thickness * 4` long (capped at W/3) and
 *   `thickness * 2.5` half-wide;
 * - the corner radius is clamped to half the SHORT edge;
 * - rect/ellipse are drawn on the box inset by half the stroke width, so the
 *   stroke stays inside the bbox.
 *
 * Every constant below has a named twin in ShapeGeometry.cs. This module is
 * pure so the numbers can be diffed against that file in a unit test instead of
 * by eye.
 */
import type { ShapeClip } from '@videoedit/timeline-schema';

export type ShapeStyle = ShapeClip['shape'];

/** ShapeGeometry.DefaultLineThicknessRatio */
export const DEFAULT_LINE_THICKNESS_RATIO = 0.01;
/** ShapeGeometry.MinLineThicknessPx */
export const MIN_LINE_THICKNESS_PX = 2;
/** ShapeGeometry.ArrowHeadLengthFactor */
export const ARROW_HEAD_LENGTH_FACTOR = 4;
/** ShapeGeometry.ArrowHeadHalfWidthFactor */
export const ARROW_HEAD_HALF_WIDTH_FACTOR = 2.5;

export interface ShapeGeometry {
  type: ShapeStyle['type'];
  /** Natural box = the project frame (see the header). */
  boxWidthPx: number;
  boxHeightPx: number;
  strokeWidthPx: number;
  cornerRadiusPx: number;
  /** Body thickness of a line/arrow. */
  lineThicknessPx: number;
  arrowHeadLengthPx: number;
  arrowHeadHalfWidthPx: number;
}

/** Half-stroke inset box for rect/ellipse (ShapeGeometry.InsetBox). */
export function insetBox(g: ShapeGeometry): { left: number; top: number; right: number; bottom: number } {
  const half = g.strokeWidthPx / 2;
  return {
    left: half,
    top: half,
    right: g.boxWidthPx - half,
    bottom: g.boxHeightPx - half,
  };
}

/** Line-by-line mirror of ShapeGeometry.Compute (C#). */
export function computeShapeGeometry(
  shape: ShapeStyle,
  width: number,
  height: number,
): ShapeGeometry {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  // A stroke can never overflow the box (an inverted inset box would draw
  // nothing at all).
  const strokeWidthPx = Math.min(Math.max(0, shape.stroke?.widthPx ?? 0), Math.min(w, h));
  const thickness =
    strokeWidthPx > 0
      ? strokeWidthPx
      : Math.max(MIN_LINE_THICKNESS_PX, Math.round(Math.min(w, h) * DEFAULT_LINE_THICKNESS_RATIO));

  // The arrow head must fit the frame: half-width <= H/2, length <= W/3.
  const maxThicknessForHead = h / 2 / ARROW_HEAD_HALF_WIDTH_FACTOR;
  const headThickness = Math.max(1, Math.min(thickness, maxThicknessForHead));
  const arrowHeadLengthPx = Math.min(headThickness * ARROW_HEAD_LENGTH_FACTOR, w / 3);
  const isLinear = shape.type === 'line' || shape.type === 'arrow';

  return {
    type: shape.type,
    boxWidthPx: w,
    boxHeightPx: h,
    strokeWidthPx,
    cornerRadiusPx: Math.min(Math.max(0, shape.radiusPx ?? 0), Math.min(w, h) / 2),
    lineThicknessPx: isLinear ? headThickness : thickness,
    arrowHeadLengthPx,
    arrowHeadHalfWidthPx: headThickness * ARROW_HEAD_HALF_WIDTH_FACTOR,
  };
}
