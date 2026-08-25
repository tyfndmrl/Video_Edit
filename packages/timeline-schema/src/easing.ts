/**
 * Easing curves and keyframe sampling — the REFERENCE implementation.
 * The C# export compiler must port this file 1:1 (same bezier solver, same
 * preset coefficients) so that preview and export animate identically.
 */

import type { MicroSec } from './time.js';

export type Easing =
  | { type: 'linear' }
  | { type: 'easeIn' }
  | { type: 'easeOut' }
  | { type: 'easeInOut' }
  | { type: 'cubicBezier'; x1: number; y1: number; x2: number; y2: number };

/** A single keyframe. `timeUs` is relative to the clip's timeline start. */
export interface Keyframe {
  timeUs: MicroSec;
  value: number;
  /** Easing of the segment AFTER this keyframe. */
  easing: Easing;
}

export interface BezierCoefficients {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Preset coefficients — CSS equivalents. Normative for both preview and export. */
export const EASING_PRESETS: Readonly<Record<'easeIn' | 'easeOut' | 'easeInOut', BezierCoefficients>> = {
  easeIn: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
};

/**
 * Evaluate a CSS-style cubic bezier easing at progress p in [0,1].
 * Curve endpoints are fixed at (0,0) and (1,1); (x1,y1)/(x2,y2) are control points.
 *
 * NORMATIVE (docs/rendering-semantics.md §3.2): fixed 32-iteration bisection.
 * Newton is forbidden — convergence differences could diverge across languages;
 * fixed-iteration bisection is deterministic. C# ports this line by line (double).
 */
export function cubicBezierAt(x1: number, y1: number, x2: number, y2: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bx = (t: number): number => 3 * t * (1 - t) * (1 - t) * x1 + 3 * t * t * (1 - t) * x2 + t * t * t;
  const by = (t: number): number => 3 * t * (1 - t) * (1 - t) * y1 + 3 * t * t * (1 - t) * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  let t = p;
  for (let i = 0; i < 32; i++) {
    t = (lo + hi) / 2;
    if (bx(t) < p) lo = t;
    else hi = t;
  }
  return by(t);
}

/** Inclusive range of a sampled animation curve (or of the bezier value axis). */
export interface CurveExtrema {
  min: number;
  max: number;
}

/**
 * Closed-form extrema of the bezier VALUE curve By(t) = 3t(1-t)²y1 + 3t²(1-t)y2 + t³
 * over t ∈ [0,1]. Endpoints are fixed (By(0)=0, By(1)=1) so the result always contains
 * [0,1]; y1/y2 outside [0,1] (schema-legal — §3.1 leaves y free) push it further out.
 *
 * WHY THIS EXISTS: the schema's min/max gates (scale floor "degenerate-layer", scale
 * ceiling "transform-scale") must ask the extremum of the SAMPLED curve, not of the
 * keyframe values — an undershooting cubicBezier drives sampled values below the
 * keyframe floor (measured: scale 0.02→1.0 with (0.3,-4,0.6,1) samples down to −1.499
 * at 30fps while the keyframe floor is 0.02). The four editor presets all stay exactly
 * inside [0,1] (their extrema are {0,1}), so for every editor-produced document this
 * function returns the keyframe hull unchanged.
 *
 * WHY CLOSED FORM (measured, 2026-08-25): By′(t)/3 = at² + bt + c with
 * a = 3y1−3y2+1, b = 2(y2−2y1), c = y1 — a quadratic whose [0,1] roots are the only
 * interior extremum candidates. Against a 20k-point dense scan over 2007 coefficient
 * pairs the closed form always COVERS the scan (never narrower) and agrees within
 * 3.1e-8 (the scan's own resolution), at ~90 ns vs ~220 µs for operational dense
 * sampling per segment (~2400x). Like every §3.2 algorithm it is ported line by line
 * to C# (Easing.BezierValueExtrema) — cross-language vectors:
 * test-vectors/easing-extrema-vectors.json.
 *
 * The bound COVERS the operational curve: sampling evaluates By at bisection-resolved
 * t ∈ [0,1], so no sample can escape these extrema; the extremum itself may fall
 * between two frame samples, in which case a gate built on it rejects a hair earlier
 * than the frame grid strictly requires (same "early reject is safe" doctrine as the
 * ceiling's max(static, keyframe) rule).
 */
export function bezierValueExtrema(y1: number, y2: number): CurveExtrema {
  const by = (t: number): number => 3 * t * (1 - t) * (1 - t) * y1 + 3 * t * t * (1 - t) * y2 + t * t * t;
  let min = 0;
  let max = 1;
  const a = 3 * y1 - 3 * y2 + 1;
  const b = 2 * (y2 - 2 * y1);
  const c = y1;
  const candidates: number[] = [];
  if (a === 0) {
    // Derivative is linear (e.g. the identity-shaped bezier y1=1/3, y2=2/3).
    if (b !== 0) candidates.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      candidates.push((-b - sq) / (2 * a), (-b + sq) / (2 * a));
    }
  }
  for (const t of candidates) {
    if (t > 0 && t < 1) {
      const v = by(t);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

/**
 * Extrema of the SAMPLED keyframe curve (the exact function `sampleKeyframes`
 * evaluates): the hull of all keyframe values widened, per curved segment, by the
 * segment easing's value-curve extrema. Linear segments (and the constant stretches
 * before the first / after the last keyframe) cannot leave the endpoint hull —
 * `easingProgress` clamps them to [0,1]. A zero-delta segment is constant regardless
 * of easing and contributes nothing beyond its endpoints.
 *
 * keyframes must be non-empty and sorted ascending by timeUs (schema invariant),
 * exactly like `sampleKeyframes`.
 */
export function keyframeCurveExtrema(keyframes: readonly Keyframe[]): CurveExtrema {
  if (keyframes.length === 0) {
    throw new Error('keyframeCurveExtrema requires at least one keyframe');
  }
  let min = Infinity;
  let max = -Infinity;
  for (const k of keyframes) {
    if (k.value < min) min = k.value;
    if (k.value > max) max = k.value;
  }
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const delta = b.value - a.value;
    if (delta === 0) continue;
    const bez = easingToBezier(a.easing);
    if (bez === null) continue;
    const ext = bezierValueExtrema(bez.y1, bez.y2);
    const v1 = a.value + delta * ext.min;
    const v2 = a.value + delta * ext.max;
    if (Math.min(v1, v2) < min) min = Math.min(v1, v2);
    if (Math.max(v1, v2) > max) max = Math.max(v1, v2);
  }
  return { min, max };
}

/** Resolve an Easing value to bezier coefficients; null means linear. */
export function easingToBezier(easing: Easing): BezierCoefficients | null {
  switch (easing.type) {
    case 'linear':
      return null;
    case 'easeIn':
    case 'easeOut':
    case 'easeInOut':
      return EASING_PRESETS[easing.type];
    case 'cubicBezier':
      return { x1: easing.x1, y1: easing.y1, x2: easing.x2, y2: easing.y2 };
  }
}

/** Eased progress for a segment: p in [0,1] -> eased value in [0,1]. */
export function easingProgress(easing: Easing, p: number): number {
  const bez = easingToBezier(easing);
  if (bez === null) return Math.min(1, Math.max(0, p));
  return cubicBezierAt(bez.x1, bez.y1, bez.x2, bez.y2, p);
}

/**
 * Sample a keyframe track at `timeUs` (relative to clip start, timeline time).
 * - keyframes must be non-empty and sorted ascending by timeUs (schema invariant)
 * - before the first keyframe -> first value; after the last -> last value
 * - between k[i] and k[i+1] the segment uses k[i].easing
 */
export function sampleKeyframes(keyframes: readonly Keyframe[], timeUs: MicroSec): number {
  if (!Number.isInteger(timeUs)) {
    throw new RangeError(`timeUs must be an integer, got ${String(timeUs)}`);
  }
  if (keyframes.length === 0) {
    throw new Error('sampleKeyframes requires at least one keyframe');
  }
  const first = keyframes[0];
  if (timeUs <= first.timeUs) return first.value;
  const last = keyframes[keyframes.length - 1];
  if (timeUs >= last.timeUs) return last.value;

  // Find segment [i, i+1] containing timeUs (linear scan; tracks are short).
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (timeUs >= a.timeUs && timeUs < b.timeUs) {
      const span = b.timeUs - a.timeUs;
      if (span <= 0) return b.value; // defensive; schema forbids duplicates
      const p = (timeUs - a.timeUs) / span;
      const eased = easingProgress(a.easing, p);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value; // unreachable with sorted input
}
