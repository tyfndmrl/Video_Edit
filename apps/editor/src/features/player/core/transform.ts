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
  const s = fitScale(srcW, srcH, compW, compH) * transform.scale;
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

/** Apply the mat3 to (u, v, 1) — used by tests to cross-check against the formula. */
export function applyMat3(m: Float32Array, u: number, v: number): { x: number; y: number } {
  return {
    x: m[0]! * u + m[3]! * v + m[6]!,
    y: m[1]! * u + m[4]! * v + m[7]!,
  };
}
