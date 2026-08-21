/**
 * Transition mix parity tests (docs/rendering-semantics.md §5.3):
 *
 * 1. hand-computed vectors against the pure TS reference (what a pixel MUST be
 *    at a given progress),
 * 2. shader-drift alarm: the mode numbers and the §4.1 colour constants are
 *    extracted from the GLSL source and compared with the TS side — the two
 *    copies of the transition math cannot diverge silently.
 *
 * The reference is not decoration: the E2E computes its expected canvas pixel
 * with these same functions, so "the preview blends" is checked against a
 * number derived from the contract, not from the implementation.
 */
import { describe, expect, it } from 'vitest';
import type { TransitionType } from '@videoedit/timeline-schema';
import {
  mixStraight,
  mixTransitionRef,
  overStraight,
  toBytes,
  transitionProgress,
  TRANSITION_MODE,
  type Rgba,
} from './transitionRef';
import { TRANSITION_FRAGMENT_SHADER, TRANSITION_MODE_GLSL } from '../compositor/shaders';
import { BT709_LUMA_B, BT709_LUMA_G, BT709_LUMA_R, K_TEMP, K_TINT } from './colorAdjustRef';

const RED: Rgba = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: Rgba = { r: 0, g: 0, b: 1, a: 1 };
const ALL_TYPES: TransitionType[] = [
  'crossfade',
  'dissolve',
  'fadeToBlack',
  'wipeLeft',
  'wipeRight',
  'slideUp',
];

describe('transitionProgress (§5.3: p = (t - (T - D/2)) / D)', () => {
  it('is 0 at the window start, 0.5 at the cut, 1 at the window end', () => {
    expect(transitionProgress(6_000_000, 1_000_000, 5_500_000)).toBeCloseTo(0, 9);
    expect(transitionProgress(6_000_000, 1_000_000, 6_000_000)).toBeCloseTo(0.5, 9);
    expect(transitionProgress(6_000_000, 1_000_000, 6_500_000)).toBeCloseTo(1, 9);
  });
});

describe('crossfade / dissolve — the mix at p', () => {
  it('crossfade at p=0.5 is EXACTLY half of each source', () => {
    const mid = mixTransitionRef('crossfade', RED, BLUE, 0.5);
    expect(toBytes(mid)).toEqual([128, 0, 128]);
    // ...and the endpoints are the pure sources (no drift at the edges).
    expect(toBytes(mixTransitionRef('crossfade', RED, BLUE, 0))).toEqual([255, 0, 0]);
    expect(toBytes(mixTransitionRef('crossfade', RED, BLUE, 1))).toEqual([0, 0, 255]);
  });

  it('crossfade weights are linear in p (p=0.25 -> 3/4 A + 1/4 B)', () => {
    const q = mixTransitionRef('crossfade', RED, BLUE, 0.25);
    expect(q.r).toBeCloseTo(0.75, 9);
    expect(q.b).toBeCloseTo(0.25, 9);
  });

  it('mixStraight does NOT darken a picture that fades in over transparency', () => {
    // A absent (alpha 0), B opaque: at p=0.5 the colour must still be B's —
    // a naive straight-alpha mix would return half-black.
    const out = mixStraight({ r: 0, g: 0, b: 0, a: 0 }, BLUE, 0.5);
    expect(out.a).toBeCloseTo(0.5, 9);
    expect(toBytes(out)).toEqual([0, 0, 255]);
  });

  it('dissolve SELECTS a source per pixel — never an average', () => {
    // A pixel whose noise is below p flips to B, the rest stays A.
    expect(mixTransitionRef('dissolve', RED, BLUE, 0.5, { noise: 0.2 })).toEqual(BLUE);
    expect(mixTransitionRef('dissolve', RED, BLUE, 0.5, { noise: 0.8 })).toEqual(RED);
    expect(mixTransitionRef('dissolve', RED, BLUE, 0, { noise: 0 })).toEqual(RED);
    expect(mixTransitionRef('dissolve', RED, BLUE, 1, { noise: 0.999 })).toEqual(BLUE);
  });
});

describe('fadeToBlack — ffmpeg xfade fadeblack (phase 0.2), pixel-exact', () => {
  it('endpoints are the pure sources and stays opaque throughout', () => {
    expect(toBytes(mixTransitionRef('fadeToBlack', RED, BLUE, 0))).toEqual([255, 0, 0]);
    expect(toBytes(mixTransitionRef('fadeToBlack', RED, BLUE, 1))).toEqual([0, 0, 255]);
    const mid = mixTransitionRef('fadeToBlack', RED, BLUE, 0.5);
    expect(mid.a, 'opak girdide kare kararır ama KAYBOLMAZ (alpha siyahı opaktır)').toBe(1);
  });

  it('matches REAL ffmpeg 8.0 output (measured yuv vectors, ±4 per channel)', () => {
    // ÖLÇÜM DÜZENEĞİ (2026-08-21, ffmpeg 8.0 gyan build) — HİÇ RGB DÖNÜŞÜMSÜZ:
    // iki düz renk yuv444p kaynak, xfade=transition=fadeblack:duration=1:offset=0.5
    // @30fps, çıktı rawvideo yuv444p. Kaynak ve çıktı YUV baytları DOĞRUDAN
    // dosyadan okundu (p = (frame-15)/30). Üretim hattının iki yolunun da aynı
    // eğriyi verdiği C# tarafında koşarak sabitlenir (ExportRenderGoldenTests
    // FadeToBlack_* çifti). Ref'e girdi/beklenti bt709 sınırlı çözümle taşınır —
    // çözüm afin ve birebir olduğundan karışımın kendisi ölçüme karşı sınanmış olur.
    const SRC_A: [number, number, number] = [84, 104, 158];
    const SRC_B: [number, number, number] = [108, 170, 81];
    const measured: [number, [number, number, number]][] = [
      [1 / 30, [75, 106, 154]],
      [3 / 30, [38, 116, 140]],
      [5 / 30, [7, 126, 128]],
      [6 / 30, [3, 128, 125]],
      [10 / 30, [13, 132, 121]],
      [15 / 30, [36, 141, 111]],
      [20 / 30, [66, 153, 98]],
      [24 / 30, [86, 161, 90]],
      [27 / 30, [97, 165, 85]],
      [29 / 30, [104, 168, 82]],
    ];

    // bt709 sınırlı aralık çözümü (standart matris; test tarafında bağımsız kopya).
    const dec = ([y, u, v]: [number, number, number]): Rgba => {
      const yl = (y - 16) / 219;
      const pb = (u - 128) / 224;
      const pr = (v - 128) / 224;
      const c = (x: number): number => Math.min(1, Math.max(0, x));
      return {
        r: c(yl + 1.5748 * pr),
        g: c(yl - 0.1873 * pb - 0.4681 * pr),
        b: c(yl + 1.8556 * pb),
        a: 1,
      };
    };

    const A = dec(SRC_A);
    const B = dec(SRC_B);
    for (const [p, yuv] of measured) {
      const out = toBytes(mixTransitionRef('fadeToBlack', A, B, p));
      const expected = toBytes(dec(yuv));
      for (let c = 0; c < 3; c++) {
        // Tolerans 4: ffmpeg düzlem başına tam sayıya AŞAĞI kırpar (ölçülen
        // sistematik −1 sapma), ref sürekli hesaplar — fiziksel taban ±1 kod
        // birimi/düzlemdir. 1 kroma birimi rgb'ye 1.575/1.856·(255/224) ≈ 1.8-2.1
        // bayt, 1 Y birimi ≈ 1.2 bayt taşır; Y+kroma birleşik tavan ~4 bayttır
        // (p=0.5 B kanalında ölçüldü: 4).
        expect(
          Math.abs(out[c]! - expected[c]!),
          `p=${p.toFixed(3)} kanal ${c}: ref ${out[c]}, ffmpeg ${expected[c]}`,
        ).toBeLessThanOrEqual(4);
      }
    }
  });

  it('the curve is ASYMMETRIC: A dies inside the first 20%, B ramps over the rest', () => {
    // Eski önizleme simetrik V çiziyordu (yarıda tam siyah); ffmpeg'in eğrisi öyle
    // değil — p=0.25'te A tamamen gitmiştir, orta kare de TAM siyah değildir.
    expect(toBytes(mixTransitionRef('fadeToBlack', RED, BLUE, 0.25))[0]).toBe(0);
    const mid = toBytes(mixTransitionRef('fadeToBlack', RED, BLUE, 0.5));
    expect(mid[2], 'orta karede B zayıf ama sıfır değil (ölçülen ffmpeg davranışı)').toBeGreaterThan(0);
    expect(mid[2]).toBeLessThan(128);
  });

  it('alpha mixes against OPAQUE black — measured on semi-transparent inputs', () => {
    // Alpha düzlemi renk modelinden BAĞIMSIZDIR: vf_xfade'in alpha "siyahı" her
    // format ailesinde max'tır (opak). Ölçüm rgba düzeneğinden (A gri 200 @0.25,
    // B gri 100 @0.75 — lavfi color@, xfade fadeblack, rawvideo rgba): alpha baytları.
    const A: Rgba = { r: 200 / 255, g: 200 / 255, b: 200 / 255, a: 63 / 255 };
    const B: Rgba = { r: 100 / 255, g: 100 / 255, b: 100 / 255, a: 191 / 255 };
    const measuredAlpha: [number, number][] = [
      [3 / 30, 168],
      [6 / 30, 253],
      [15 / 30, 233],
      [27 / 30, 197],
    ];
    for (const [p, expected] of measuredAlpha) {
      const out = Math.round(mixTransitionRef('fadeToBlack', A, B, p).a * 255);
      expect(Math.abs(out - expected), `p=${p.toFixed(3)}: ref a=${out}, ffmpeg ${expected}`)
        .toBeLessThanOrEqual(1);
    }
  });
});

describe('wipes — a moving edge, both sources at full strength', () => {
  it('wipeLeft grows B from the RIGHT edge', () => {
    const at = (x: number, p: number) => mixTransitionRef('wipeLeft', RED, BLUE, p, { uv: { x, y: 0.5 } });
    // p = 0.05 puts the edge at x = 0.95: only the rightmost sliver is B.
    expect(at(0.98, 0.05), 'barely started: the right EDGE is already B').toEqual(BLUE);
    expect(at(0.9, 0.05), 'and 10% in from the right is still A').toEqual(RED);
    expect(at(0.1, 0.05)).toEqual(RED);
    expect(at(0.1, 0.95), 'almost done: left edge is B too').toEqual(BLUE);
  });

  it('wipeRight grows B from the LEFT edge (the mirror image)', () => {
    const at = (x: number, p: number) => mixTransitionRef('wipeRight', RED, BLUE, p, { uv: { x, y: 0.5 } });
    expect(at(0.1, 0.2)).toEqual(BLUE);
    expect(at(0.9, 0.2)).toEqual(RED);
    expect(at(0.9, 0.95)).toEqual(BLUE);
  });

  it('a wipe never averages: every pixel is one source or the other', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      for (const p of [0.1, 0.5, 0.9]) {
        const out = mixTransitionRef('wipeLeft', RED, BLUE, p, { uv: { x, y: 0.5 } });
        expect([JSON.stringify(RED), JSON.stringify(BLUE)]).toContain(JSON.stringify(out));
      }
    }
  });
});

describe('slideUp — composite of two translated pictures', () => {
  it('B over A where B exists, A elsewhere (straight-alpha over, §6.3)', () => {
    const nothing: Rgba = { r: 0, g: 0, b: 0, a: 0 };
    expect(mixTransitionRef('slideUp', RED, nothing, 0.3), 'above the seam: A').toEqual(RED);
    expect(mixTransitionRef('slideUp', nothing, BLUE, 0.3), 'below the seam: B').toEqual(BLUE);
  });

  it('overStraight matches the §6.3 blend equation on a half-transparent source', () => {
    const half: Rgba = { r: 1, g: 1, b: 1, a: 0.5 };
    const out = overStraight(half, BLUE);
    expect(out.a).toBeCloseTo(1, 9);
    // 0.5*white + 0.5*blue
    expect(out.r).toBeCloseTo(0.5, 9);
    expect(out.g).toBeCloseTo(0.5, 9);
    expect(out.b).toBeCloseTo(1, 9);
  });
});

describe('progress is clamped: a stale p can never invent a colour', () => {
  it('p outside [0,1] behaves like the nearest endpoint', () => {
    expect(mixTransitionRef('crossfade', RED, BLUE, -3)).toEqual(RED);
    expect(mixTransitionRef('crossfade', RED, BLUE, 42)).toEqual(BLUE);
  });
});

describe('shader-drift alarm: the GLSL agrees with the TS reference', () => {
  it('the mode numbering is the same on both sides', () => {
    expect(TRANSITION_MODE).toEqual(TRANSITION_MODE_GLSL);
  });

  it('every schema transition type has a distinct mode', () => {
    const values = ALL_TYPES.map((t) => TRANSITION_MODE[t]);
    expect(new Set(values).size, 'two types sharing a mode = one of them is wrong').toBe(
      ALL_TYPES.length,
    );
  });

  it('every non-default mode has a branch in the fragment shader', () => {
    for (const type of ALL_TYPES) {
      const mode = TRANSITION_MODE[type];
      if (mode === TRANSITION_MODE.crossfade) continue; // the else branch
      expect(
        TRANSITION_FRAGMENT_SHADER,
        `${type} (uMode ${mode}) has no branch — it would silently render a crossfade`,
      ).toMatch(new RegExp(`uMode\\s*==\\s*${mode}\\b`));
    }
  });

  it('the transition shader carries the SAME §4.1 constants as the layer shader', () => {
    const temp = /c\.r\s*=\s*clamp\(c\.r\s*\+\s*([0-9.]+)\s*\*\s*temperature/.exec(
      TRANSITION_FRAGMENT_SHADER,
    );
    const tint = /c\.g\s*=\s*clamp\(c\.g\s*-\s*([0-9.]+)\s*\*\s*tint/.exec(
      TRANSITION_FRAGMENT_SHADER,
    );
    const luma = /dot\(c\.rgb,\s*vec3\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)\)/.exec(
      TRANSITION_FRAGMENT_SHADER,
    );
    expect(temp).not.toBeNull();
    expect(tint).not.toBeNull();
    expect(luma).not.toBeNull();
    expect(parseFloat(temp![1]!)).toBe(K_TEMP);
    expect(parseFloat(tint![1]!)).toBe(K_TINT);
    expect(parseFloat(luma![1]!)).toBe(BT709_LUMA_R);
    expect(parseFloat(luma![2]!)).toBe(BT709_LUMA_G);
    expect(parseFloat(luma![3]!)).toBe(BT709_LUMA_B);
    expect(TRANSITION_FRAGMENT_SHADER).toMatch(
      /\(c\.rgb\s*-\s*0\.5\)\s*\*\s*\(1\.0\s*\+\s*contrast\)\s*\+\s*0\.5\s*\+\s*brightness/,
    );
  });

  it('BOTH sides are graded independently (a shared uniform would tint the pair)', () => {
    for (const side of ['A', 'B']) {
      for (const key of ['Exposure', 'Temperature', 'Tint', 'Brightness', 'Contrast', 'Saturation']) {
        expect(TRANSITION_FRAGMENT_SHADER).toContain(`uniform float u${key}${side};`);
      }
      expect(TRANSITION_FRAGMENT_SHADER).toContain(`uniform sampler2D uTex${side};`);
      expect(TRANSITION_FRAGMENT_SHADER).toContain(`uniform mat3 uInv${side};`);
    }
  });

  it('the shader clamps p, so a stale progress cannot brighten a frame', () => {
    expect(TRANSITION_FRAGMENT_SHADER).toMatch(/clamp\(uProgress,\s*0\.0,\s*1\.0\)/);
  });

  it('the fadeToBlack branch carries the ffmpeg fadeblack smoothstep edges (phase 0.2)', () => {
    // TS referansı ölçülü vektörlerle sabitlenir; GLSL kopyası da AYNI kenarları
    // taşımalı — aksi halde önizleme sessizce eski (simetrik) eğriye döner.
    expect(TRANSITION_FRAGMENT_SHADER).toMatch(/smoothstep\(0\.8,\s*1\.0,\s*P\)/);
    expect(TRANSITION_FRAGMENT_SHADER).toMatch(/smoothstep\(0\.2,\s*1\.0,\s*P\)/);
  });
});
