/**
 * Pure TS reference of the transition mix functions — docs/rendering-semantics
 * §5.3, the PREVIEW half of the transition contract.
 *
 * Same role as colorAdjustRef.ts: the GLSL lives on the GPU where no test can
 * read it, so the formulas are written once here, pinned by hand-computed
 * vectors, and cross-checked against the shader source by regex
 * (transitionRef.test.ts). The E2E computes its expected canvas pixel with
 * these functions too — "the preview blends" is a claim about a NUMBER, not a
 * screenshot that looks about right.
 *
 * Colour convention: straight (unassociated) alpha on non-linear sRGB, channels
 * in [0,1] — §6.3, the same space the compositor blends in.
 */
import type { TransitionType } from '@videoedit/timeline-schema';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * GLSL `uMode` values. The shader branches on these integers; the object below
 * is the only place TypeScript names them, so a renumbering breaks the build
 * instead of silently turning every wipe into a crossfade.
 */
export const TRANSITION_MODE: Record<TransitionType, number> = {
  crossfade: 0,
  dissolve: 1,
  fadeToBlack: 2,
  wipeLeft: 3,
  wipeRight: 4,
  slideUp: 5,
};

/** Linear mix position across the window [T - D/2, T + D/2) (§5.3). */
export function transitionProgress(cutUs: number, durationUs: number, tUs: number): number {
  if (durationUs <= 0) return 1;
  return (tUs - (cutUs - durationUs / 2)) / durationUs;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Weighted average of two straight-alpha colours (premultiply -> mix -> unpremultiply). */
export function mixStraight(a: Rgba, b: Rgba, p: number): Rgba {
  const oa = a.a + (b.a - a.a) * p;
  if (oa <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (ca: number, cb: number): number => (ca * a.a + (cb * b.a - ca * a.a) * p) / oa;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: oa };
}

/** Straight-alpha "src over dst" (§6.3 normative blend equation). */
export function overStraight(src: Rgba, dst: Rgba): Rgba {
  const oa = src.a + dst.a * (1 - src.a);
  if (oa <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (cs: number, cd: number): number => (cs * src.a + cd * dst.a * (1 - src.a)) / oa;
  return { r: ch(src.r, dst.r), g: ch(src.g, dst.g), b: ch(src.b, dst.b), a: oa };
}

export interface MixOptions {
  /**
   * Screen position of the pixel, 0..1 with y DOWN (the geometric transitions
   * are defined on it). Defaults to the frame centre.
   */
  uv?: { x: number; y: number };
  /**
   * dissolve threshold for this pixel, 0..1. The shader derives it from a hash
   * of `uv`; a test that wants a deterministic answer passes it explicitly.
   */
  noise?: number;
}

/**
 * The §5.3 mix at progress p.
 *
 * `slideUp` is the one type whose geometry is in the SAMPLING (both pictures
 * translate upward), so the reference takes the already-shifted samples and
 * only performs the composite — the shift itself is asserted through the
 * sampling coordinates in transitionRef.test.ts.
 */
export function mixTransitionRef(
  type: TransitionType,
  a: Rgba,
  b: Rgba,
  progress: number,
  opts: MixOptions = {},
): Rgba {
  const p = clamp01(progress);
  const uv = opts.uv ?? { x: 0.5, y: 0.5 };
  switch (type) {
    case 'wipeLeft':
      return uv.x > 1 - p ? b : a;
    case 'wipeRight':
      return uv.x < p ? b : a;
    case 'dissolve':
      return (opts.noise ?? 0.5) < p ? b : a;
    case 'fadeToBlack': {
      const k = p < 0.5 ? 1 - 2 * p : 2 * p - 1;
      const src = p < 0.5 ? a : b;
      return { r: src.r * k, g: src.g * k, b: src.b * k, a: src.a };
    }
    case 'slideUp':
      return overStraight(b, a);
    case 'crossfade':
    default:
      return mixStraight(a, b, p);
  }
}

/** 8-bit channel triple of a reference colour (what readPixel/probePixel returns). */
export function toBytes(c: Rgba): [number, number, number] {
  return [Math.round(clamp01(c.r) * 255), Math.round(clamp01(c.g) * 255), Math.round(clamp01(c.b) * 255)];
}
