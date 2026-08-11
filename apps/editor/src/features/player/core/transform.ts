/**
 * Transform -> pixel placement math. Pure (no DOM/WebGL) so it is unit-testable
 * against the NORMATIVE formulas in docs/rendering-semantics.md §2.
 *
 * Contract (§2.3, order is fixed):
 *   1. fit = contain scale (fitScale = min(W/w_s, H/h_s))
 *   2. user scale (single combined factor s = fitScale * scale)
 *   3. rotate around the anchor point
 *   4. move the anchor point to P = (W/2 + x*W, H/2 + y*H)
 *
 * All math lives in project output space (W x H); the compositor maps it to the
 * canvas with a single uniform scale at the very end (§2.1).
 */
import type { Transform } from '@videoedit/timeline-schema';

export interface PlacementInput {
  /** Source natural size (autorotated), px. */
  srcW: number;
  srcH: number;
  /** Project/composition output size, px. */
  compW: number;
  compH: number;
  transform: Transform;
  /**
   * Source px -> composition px factor at `transform.scale === 1`, REPLACING
   * the fit=contain factor. Omitted (the normal case) means §2.2 fit=contain.
   *
   * Why it exists: §2.2's "scale = 1 means fit" is a rule about MEDIA, whose
   * natural size carries no meaning in composition space. An overlay raster
   * (text/shape, §7) is the opposite: it is rasterized AT a known project-space
   * size (`rasterPx = bboxPx * 2`) and must be drawn at `bboxPx * scale`, i.e.
   * with a fixed factor of 1/2 — fitting it to the composition would blow a
   * 400 px caption up to full frame. Both sides (preview compositor, gizmo and
   * the future SkiaSharp/export path) use this same single number.
   */
  baseScale?: number;
}

/** Precomputed placement factors for one clip at one instant. */
export interface Placement {
  /** Combined scale s = fitScale * transform.scale (§2.4). */
  s: number;
  /** Draw size w_d = w_s * s, h_d = h_s * s. */
  wDraw: number;
  hDraw: number;
  /** Anchor point in draw space: a = (anchorX * w_d, anchorY * h_d). */
  ax: number;
  ay: number;
  /** Target of the anchor in composition space: P = (W/2 + x*W, H/2 + y*H). */
  px: number;
  py: number;
  /** cos/sin of rotation (positive = clockwise in screen coords, y down). */
  cos: number;
  sin: number;
}

/** fit=contain scale factor (§2.2). */
export function fitScale(srcW: number, srcH: number, compW: number, compH: number): number {
  return Math.min(compW / srcW, compH / srcH);
}

export function computePlacement(input: PlacementInput): Placement {
  const { srcW, srcH, compW, compH, transform } = input;
  const base =
    input.baseScale !== undefined && Number.isFinite(input.baseScale) && input.baseScale > 0
      ? input.baseScale
      : fitScale(srcW, srcH, compW, compH);
  const s = base * transform.scale;
  const wDraw = srcW * s;
  const hDraw = srcH * s;
  const theta = (transform.rotationDeg * Math.PI) / 180;
  return {
    s,
    wDraw,
    hDraw,
    ax: transform.anchorX * wDraw,
    ay: transform.anchorY * hDraw,
    px: compW / 2 + transform.x * compW,
    py: compH / 2 + transform.y * compH,
    cos: Math.cos(theta),
    sin: Math.sin(theta),
  };
}

/**
 * Screen position of a source pixel (§2.4 open pixel formula):
 *   u = sx*s, v = sy*s
 *   x = P.x + cos*(u - a.x) - sin*(v - a.y)
 *   y = P.y + sin*(u - a.x) + cos*(v - a.y)
 */
export function sourceToScreen(p: Placement, sx: number, sy: number): { x: number; y: number } {
  const u = sx * p.s - p.ax;
  const v = sy * p.s - p.ay;
  return {
    x: p.px + p.cos * u - p.sin * v,
    y: p.py + p.sin * u + p.cos * v,
  };
}

/**
 * Exact inverse of sourceToScreen(): which SOURCE pixel lands on this
 * composition-space point? Used by the preview gizmo to hit-test the (rotated)
 * clip quad — inside the quad iff 0 <= sx <= srcW and 0 <= sy <= srcH.
 *
 *   dx = x - P.x ; dy = y - P.y
 *   u  =  cos*dx + sin*dy      (inverse rotation)
 *   v  = -sin*dx + cos*dy
 *   sx = (u + a.x) / s ; sy = (v + a.y) / s
 */
export function screenToSource(p: Placement, x: number, y: number): { x: number; y: number } {
  if (p.s === 0) return { x: Number.NaN, y: Number.NaN };
  const dx = x - p.px;
  const dy = y - p.py;
  const u = p.cos * dx + p.sin * dy;
  const v = -p.sin * dx + p.cos * dy;
  return { x: (u + p.ax) / p.s, y: (v + p.ay) / p.s };
}

/** Screen px -> NDC (§2.4): ndc.x = 2x/W - 1, ndc.y = 1 - 2y/H. */
export function screenToNdc(compW: number, compH: number, x: number, y: number): { x: number; y: number } {
  return { x: (2 * x) / compW - 1, y: 1 - (2 * y) / compH };
}

/**
 * 3x3 column-major matrix mapping the UNIT quad (u,v in [0,1], u right,
 * v down = texture space) directly to NDC. This is what the vertex shader
 * multiplies with; it is the exact composition of:
 *   unit -> source px -> (scale, rotate-around-anchor, translate) -> NDC.
 */
export function unitQuadToNdcMatrix(
  p: Placement,
  srcW: number,
  srcH: number,
  compW: number,
  compH: number,
): Float32Array {
  // Screen-space affine (unit quad coords -> screen px):
  //   x = A*u + B*v + C ;  y = D*u + E*v + F
  const A = p.cos * srcW * p.s;
  const B = -p.sin * srcH * p.s;
  const C = p.px - p.cos * p.ax + p.sin * p.ay;
  const D = p.sin * srcW * p.s;
  const E = p.cos * srcH * p.s;
  const F = p.py - p.sin * p.ax - p.cos * p.ay;
  // NDC: X = (2/W)*x - 1 ; Y = -(2/H)*y + 1
  const kx = 2 / compW;
  const ky = -2 / compH;
  // Column-major mat3 for GLSL: columns are (X_u, Y_u, 0), (X_v, Y_v, 0), (X_1, Y_1, 1).
  return new Float32Array([
    kx * A, ky * D, 0,
    kx * B, ky * E, 0,
    kx * C - 1, ky * F + 1, 1,
  ]);
}

/**
 * Inverse of a unitQuadToNdcMatrix() result: NDC -> unit quad. null when the
 * placement is degenerate (scale 0 — nothing to sample).
 *
 * The transition pass needs it: it draws ONE full-frame quad and asks, per
 * fragment, "which source pixel of each side lands here?". The bottom row of
 * these matrices is always (0, 0, 1) (they are affine), so the inverse is the
 * closed form of a 2x2 plus a translation — no general 3x3 solver needed.
 */
export function invertAffineMat3(m: Float32Array): Float32Array | null {
  // Column-major: columns are (a, b, 0), (c, d, 0), (e, f, 1).
  const a = m[0]!;
  const b = m[1]!;
  const c = m[3]!;
  const d = m[4]!;
  const e = m[6]!;
  const f = m[7]!;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = (c * f - d * e) / det;
  const iff = (b * e - a * f) / det;
  return new Float32Array([ia, ib, 0, ic, id, 0, ie, iff, 1]);
}

/** Apply the mat3 to (u, v, 1) — used by tests to cross-check against the formula. */
export function applyMat3(m: Float32Array, u: number, v: number): { x: number; y: number } {
  return {
    x: m[0]! * u + m[3]! * v + m[6]!,
    y: m[1]! * u + m[4]! * v + m[7]!,
  };
}
