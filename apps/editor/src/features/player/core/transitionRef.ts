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

/** GLSL/ffmpeg smoothstep: t = clamp((x-e0)/(e1-e0)), t*t*(3-2t). */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * BT.709 LIMITED-range code units (0..255 scale) from straight gamma rgb 0..1 —
 * the space the export's fadeToBlack actually mixes in (measured; §5.3). The
 * roundtrip is exact affine, so using it ONLY inside fadeToBlack cannot drift
 * any other transition.
 */
function toYuv709(r: number, g: number, b: number): { y: number; u: number; v: number } {
  const yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {
    y: 16 + 219 * yl,
    u: 128 + (224 * (b - yl)) / 1.8556,
    v: 128 + (224 * (r - yl)) / 1.5748,
  };
}

/** Inverse of `toYuv709`, clamped to displayable rgb (super-black clips to 0). */
function fromYuv709(y: number, u: number, v: number): { r: number; g: number; b: number } {
  const yl = (y - 16) / 219;
  const pb = (u - 128) / 224;
  const pr = (v - 128) / 224;
  return {
    r: clamp01(yl + 1.5748 * pr),
    g: clamp01(yl - 0.1873 * pb - 0.4681 * pr),
    b: clamp01(yl + 1.8556 * pb),
  };
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
      // Threshold rule = ffmpeg's dissolve exactly (B iff noise < p — measured:
      // the B fraction tracks p to 3 decimals on real renders). Only the noise
      // FIELD is an approximation; see the §5.3 note in shaders.ts.
      return (opts.noise ?? 0.5) < p ? b : a;
    case 'fadeToBlack': {
      // ffmpeg xfade 'fadeblack' (phase 0.2) — pixel-exact against the EXPORT'S
      // ACTUAL behaviour, measured from real ffmpeg 8.0 frames (the vectors live
      // in transitionRef.test.ts). ffmpeg's progress P runs 1->0; the mix is per
      // PLANE in BT.709 limited YUV with black = (Y=0, U=V=128):
      //   out = mix(mix(A, bg, sm(0.8,1,P)), mix(bg, B, sm(0.2,1,P)), P)
      // with ffmpeg mix(a,b,m) = a*m + b*(1-m).
      //
      // WHY YUV, NOT per-channel rgb: the CANONICAL fadeToBlack (a plain cut
      // between two full-frame clips) compiles to the single-layer fast path,
      // which runs the xfade on yuv420p — and vf_xfade's yuv "black" is Y=0, a
      // SUPER-black below broadcast range, NOT the affine image of rgb black
      // (that would be Y=16). The composed path (layered docs) negotiates an
      // rgb family instead and mixes channel-wise toward 0; the two curves were
      // MEASURED to differ only in the dip (≤ ~15/255 on the golden fixture —
      // §5.3, known limit poc-bilinen-sinirlar §2.3). The preview follows the
      // fast path; both export curves are pinned by running goldens
      // (ExportRenderGoldenTests.FadeToBlack_* pair).
      // The curve is asymmetric: A is gone by p=0.2, B ramps over the rest.
      const P = 1 - p;
      const smA = smoothstep(0.8, 1, P);
      const smB = smoothstep(0.2, 1, P);
      const ya = toYuv709(a.r, a.g, a.b);
      const yb = toYuv709(b.r, b.g, b.b);
      const plane = (av: number, bv: number, bg: number): number =>
        P * (av * smA + bg * (1 - smA)) + (1 - P) * (bg * smB + bv * (1 - smB));
      const rgb = fromYuv709(
        plane(ya.y, yb.y, 0),
        plane(ya.u, yb.u, 128),
        plane(ya.v, yb.v, 128),
      );
      // Alpha plane: vf_xfade'in alpha "siyahı" OPAKTIR (black[3] = max) — format
      // ailesinden bağımsız; yarı saydam girdilerle ölçüldü (test vektörleri).
      return {
        ...rgb,
        a: P * (a.a * smA + (1 - smA)) + (1 - P) * (smB + b.a * (1 - smB)),
      };
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
