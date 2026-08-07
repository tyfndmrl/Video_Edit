/**
 * colorAdjust §4.1 parity tests (docs/rendering-semantics.md):
 * 1. hand-computed vectors against the pure TS reference (stage formulas,
 *    NORMATIVE order, per-stage clamps)
 * 2. shader-drift alarm: the constants inside the GLSL fragment source
 *    (compositor/shaders.ts) are extracted with regexes and compared against
 *    the reference constants — the shader cannot silently diverge from the
 *    doc/reference/ffmpeg-compiler trio.
 */
import { describe, expect, it } from 'vitest';
import {
  applyColorAdjustRef,
  applyContrastBrightness,
  applyExposure,
  applySaturation,
  applyTemperature,
  applyTint,
  bt709Luma,
  BT709_LUMA_B,
  BT709_LUMA_G,
  BT709_LUMA_R,
  IDENTITY_COLOR_ADJUST,
  K_TEMP,
  K_TINT,
  type Rgb,
} from './colorAdjustRef';
import { FRAGMENT_SHADER } from '../compositor/shaders';
import type { ColorAdjust } from './resolve';

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

function params(overrides: Partial<ColorAdjust>): ColorAdjust {
  return { ...IDENTITY_COLOR_ADJUST, ...overrides };
}

function expectRgbCloseTo(actual: Rgb, expected: Rgb, digits = 9): void {
  expect(actual.r).toBeCloseTo(expected.r, digits);
  expect(actual.g).toBeCloseTo(expected.g, digits);
  expect(actual.b).toBeCloseTo(expected.b, digits);
}

describe('colorAdjust reference — stage formulas (§4.1, hand-computed vectors)', () => {
  it('all params 0 = identity', () => {
    const c = rgb(0.25, 0.5, 0.75);
    expectRgbCloseTo(applyColorAdjustRef(c, IDENTITY_COLOR_ADJUST), c);
  });

  it('exposure is a 2^v multiplicative gain (NOT gamma), clamped', () => {
    // 0.25 * 2^1 = 0.5
    expectRgbCloseTo(applyExposure(rgb(0.25, 0.25, 0.25), 1), rgb(0.5, 0.5, 0.5));
    // 0.5 * 2^-1 = 0.25
    expectRgbCloseTo(applyExposure(rgb(0.5, 0.5, 0.5), -1), rgb(0.25, 0.25, 0.25));
    // 0.75 * 2^1 = 1.5 -> clamp 1
    expectRgbCloseTo(applyExposure(rgb(0.75, 0.75, 0.75), 1), rgb(1, 1, 1));
  });

  it('temperature: +0.10v on R, -0.10v on B (warm = +R -B), G untouched', () => {
    // v = 0.5: r 0.5+0.05=0.55, b 0.5-0.05=0.45
    expectRgbCloseTo(applyTemperature(rgb(0.5, 0.5, 0.5), 0.5), rgb(0.55, 0.5, 0.45));
    // v = -1 (cool): r 0.5-0.1=0.4, b 0.5+0.1=0.6
    expectRgbCloseTo(applyTemperature(rgb(0.5, 0.5, 0.5), -1), rgb(0.4, 0.5, 0.6));
    // clamp: r 0.95 + 0.1 -> 1
    expect(applyTemperature(rgb(0.95, 0, 0.02), 1).r).toBe(1);
    expect(applyTemperature(rgb(0.95, 0, 0.02), 1).b).toBe(0);
  });

  it('tint: -0.10v on G only (positive v = magenta)', () => {
    expectRgbCloseTo(applyTint(rgb(0.5, 0.5, 0.5), 1), rgb(0.5, 0.4, 0.5));
    expectRgbCloseTo(applyTint(rgb(0.5, 0.5, 0.5), -0.5), rgb(0.5, 0.55, 0.5));
  });

  it('contrast+brightness is ONE affine op: (in-0.5)*(1+c) + 0.5 + b', () => {
    // in 0.25, c 0.5, b 0.1: (0.25-0.5)*1.5 + 0.5 + 0.1 = -0.375 + 0.6 = 0.225
    expectRgbCloseTo(
      applyContrastBrightness(rgb(0.25, 0.25, 0.25), 0.5, 0.1),
      rgb(0.225, 0.225, 0.225),
    );
    // contrast -1 collapses to 0.5 + b
    expectRgbCloseTo(applyContrastBrightness(rgb(0.1, 0.6, 0.9), -1, 0.2), rgb(0.7, 0.7, 0.7));
  });

  it('saturation mixes around BT.709 luma: out = luma + (in-luma)*(1+v)', () => {
    // v = -1: pure grayscale at the BT.709 luma
    const gray = applySaturation(rgb(1, 0, 0), -1);
    expectRgbCloseTo(gray, rgb(0.2126, 0.2126, 0.2126));
    // v = 1 on (0.6, 0.4, 0.5): l = 0.2126*0.6 + 0.7152*0.4 + 0.0722*0.5
    const l = 0.2126 * 0.6 + 0.7152 * 0.4 + 0.0722 * 0.5;
    const sat = applySaturation(rgb(0.6, 0.4, 0.5), 1);
    expectRgbCloseTo(sat, rgb(l + (0.6 - l) * 2, l + (0.4 - l) * 2, l + (0.5 - l) * 2));
    expect(bt709Luma(rgb(1, 1, 1))).toBeCloseTo(1, 4); // coefficients sum to 1
  });

  it('per-stage clamps are observable (clamped exposure THEN brightness)', () => {
    // r=0.8, exposure 1 -> 1.6 -> CLAMP 1; brightness -0.2 -> 0.8.
    // Without the §4.1 per-stage clamp it would be 1.6-0.2=1.4 -> 1. The
    // difference proves the intermediate clamp happens.
    const out = applyColorAdjustRef(rgb(0.8, 0, 0), params({ exposure: 1, brightness: -0.2 }));
    expect(out.r).toBeCloseTo(0.8, 9);
  });

  it('full pipeline in NORMATIVE order (one combined hand-computed vector)', () => {
    // start (0.5, 0.5, 0.5)
    // exposure 0.5:   * 2^0.5 = 0.70710678...
    // temperature 1:  r +0.1, b -0.1
    // tint 0.5:       g -0.05
    // c=0.2, b=0.05:  (x-0.5)*1.2 + 0.55
    // saturation 0.25: l + (x-l)*1.25
    const e = Math.pow(2, 0.5) * 0.5;
    const r1 = e + 0.1;
    const g1 = e - 0.05;
    const b1 = e - 0.1;
    const r2 = (r1 - 0.5) * 1.2 + 0.55;
    const g2 = (g1 - 0.5) * 1.2 + 0.55;
    const b2 = (b1 - 0.5) * 1.2 + 0.55;
    const l = BT709_LUMA_R * r2 + BT709_LUMA_G * g2 + BT709_LUMA_B * b2;
    const expected = rgb(l + (r2 - l) * 1.25, l + (g2 - l) * 1.25, l + (b2 - l) * 1.25);
    const out = applyColorAdjustRef(
      rgb(0.5, 0.5, 0.5),
      params({ exposure: 0.5, temperature: 1, tint: 0.5, contrast: 0.2, brightness: 0.05, saturation: 0.25 }),
    );
    expectRgbCloseTo(out, expected, 7);
  });
});

describe('shader-drift alarm: GLSL constants match the reference (§4.1)', () => {
  it('exposure stage uses exp2 gain', () => {
    expect(FRAGMENT_SHADER).toMatch(/c\.rgb\s*=\s*clamp\(c\.rgb\s*\*\s*exp2\(uExposure\)/);
  });

  it('temperature coefficients (+R, -B) equal K_TEMP', () => {
    const r = /c\.r\s*=\s*clamp\(c\.r\s*\+\s*([0-9.]+)\s*\*\s*uTemperature/.exec(FRAGMENT_SHADER);
    const b = /c\.b\s*=\s*clamp\(c\.b\s*-\s*([0-9.]+)\s*\*\s*uTemperature/.exec(FRAGMENT_SHADER);
    expect(r).not.toBeNull();
    expect(b).not.toBeNull();
    expect(parseFloat(r![1]!)).toBe(K_TEMP);
    expect(parseFloat(b![1]!)).toBe(K_TEMP);
  });

  it('tint coefficient (-G) equals K_TINT', () => {
    const g = /c\.g\s*=\s*clamp\(c\.g\s*-\s*([0-9.]+)\s*\*\s*uTint/.exec(FRAGMENT_SHADER);
    expect(g).not.toBeNull();
    expect(parseFloat(g![1]!)).toBe(K_TINT);
  });

  it('contrast+brightness is the single affine op with 0.5 pivot', () => {
    expect(FRAGMENT_SHADER).toMatch(
      /\(c\.rgb\s*-\s*0\.5\)\s*\*\s*\(1\.0\s*\+\s*uContrast\)\s*\+\s*0\.5\s*\+\s*uBrightness/,
    );
  });

  it('saturation luma coefficients are BT.709', () => {
    const m = /float\s+l\s*=\s*dot\(c\.rgb,\s*vec3\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)\)/.exec(
      FRAGMENT_SHADER,
    );
    expect(m).not.toBeNull();
    expect(parseFloat(m![1]!)).toBe(BT709_LUMA_R);
    expect(parseFloat(m![2]!)).toBe(BT709_LUMA_G);
    expect(parseFloat(m![3]!)).toBe(BT709_LUMA_B);
  });

  it('saturation mix uses (1 + uSaturation) around the luma', () => {
    expect(FRAGMENT_SHADER).toMatch(/mix\(vec3\(l\),\s*c\.rgb,\s*1\.0\s*\+\s*uSaturation\)/);
  });

  it('every color stage clamps to [0,1] (ffmpeg 8-bit intermediates)', () => {
    // 5 stages clamp rgb/channels: exposure, temp(r+b), tint(g), affine, saturation.
    const clampCount = (FRAGMENT_SHADER.match(/clamp\(/g) ?? []).length;
    expect(clampCount).toBeGreaterThanOrEqual(6);
  });
});
