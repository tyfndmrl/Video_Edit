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
