/**
 * Pure TS reference implementation of the colorAdjust pipeline —
 * docs/rendering-semantics.md §4.1, NORMATIVE stage order:
 *
 *   exposure (2^v gain) -> temperature (+K_TEMP*v R, -K_TEMP*v B)
 *   -> tint (-K_TINT*v G) -> contrast+brightness (ONE affine op)
 *   -> saturation (linear mix around BT.709 luma)
 *
 * with a clamp to [0,1] AFTER EVERY STAGE (matches ffmpeg's 8-bit
 * intermediates; the GLSL shader clamps per stage for the same reason).
 *
 * This file exists as the drift alarm between the doc, the WebGL shader
 * (compositor/shaders.ts) and the ffmpeg compiler: colorAdjustRef.test.ts
 * checks hand-computed vectors against these functions AND extracts the
 * constants out of the shader source to compare with the ones below. Change
 * anything here only together with the doc + shader + compiler.
 */
import type { ColorAdjust } from './resolve';

/** §4.1 temperature coefficient (linear RGB offset per unit v). */
export const K_TEMP = 0.1;
/** §4.1 tint coefficient (linear green offset per unit v). */
export const K_TINT = 0.1;
/** §4.1 saturation luma coefficients — BT.709. */
export const BT709_LUMA_R = 0.2126;
export const BT709_LUMA_G = 0.7152;
export const BT709_LUMA_B = 0.0722;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const IDENTITY_COLOR_ADJUST: ColorAdjust = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Stage 1 — exposure: multiplicative gain 2^v (NOT gamma), then clamp. */
export function applyExposure(c: Rgb, v: number): Rgb {
  const gain = Math.pow(2, v);
  return { r: clamp01(c.r * gain), g: clamp01(c.g * gain), b: clamp01(c.b * gain) };
}

/** Stage 2 — temperature: +K_TEMP*v on R, -K_TEMP*v on B (warm = +R -B), clamp. */
export function applyTemperature(c: Rgb, v: number): Rgb {
  return { r: clamp01(c.r + K_TEMP * v), g: c.g, b: clamp01(c.b - K_TEMP * v) };
}

/** Stage 3 — tint: -K_TINT*v on G (positive v = magenta), clamp. */
export function applyTint(c: Rgb, v: number): Rgb {
  return { r: c.r, g: clamp01(c.g - K_TINT * v), b: c.b };
}

/**
 * Stage 4 — contrast + brightness as ONE affine op (ffmpeg eq semantics):
 *   out = (in - 0.5) * (1 + contrast) + 0.5 + brightness, then clamp.
 * Applying them as two separate stages is FORBIDDEN (order would differ).
 */
export function applyContrastBrightness(c: Rgb, contrast: number, brightness: number): Rgb {
  const f = (x: number) => clamp01((x - 0.5) * (1 + contrast) + 0.5 + brightness);
  return { r: f(c.r), g: f(c.g), b: f(c.b) };
}

/** BT.709 luma of an RGB triple (no clamp — pure dot product). */
export function bt709Luma(c: Rgb): number {
  return BT709_LUMA_R * c.r + BT709_LUMA_G * c.g + BT709_LUMA_B * c.b;
}

/** Stage 5 — saturation: mix(luma, c, 1 + v) around BT.709 luma, clamp. */
export function applySaturation(c: Rgb, v: number): Rgb {
  const l = bt709Luma(c);
  const k = 1 + v;
  const f = (x: number) => clamp01(l + (x - l) * k);
  return { r: f(c.r), g: f(c.g), b: f(c.b) };
}

/** Full §4.1 pipeline in the NORMATIVE stage order with per-stage clamps. */
export function applyColorAdjustRef(c: Rgb, p: ColorAdjust): Rgb {
  let out = applyExposure(c, p.exposure);
  out = applyTemperature(out, p.temperature);
  out = applyTint(out, p.tint);
  out = applyContrastBrightness(out, p.contrast, p.brightness);
  out = applySaturation(out, p.saturation);
  return out;
}
