import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bezierValueExtrema,
  cubicBezierAt,
  EASING_PRESETS,
  easingProgress,
  easingToBezier,
  keyframeCurveExtrema,
  sampleKeyframes,
  type Keyframe,
} from '../src/easing.js';

interface EasingVectors {
  tolerance: number;
  cases: Array<{ preset: string; x1: number; y1: number; x2: number; y2: number; p: number; expected: number }>;
}

const easingVectors: EasingVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../test-vectors/easing-vectors.json', import.meta.url)), 'utf8'),
);

interface ExtremaVectors {
  tolerance: number;
  cases: Array<{ name: string; x1: number; y1: number; x2: number; y2: number; min: number; max: number }>;
}

const extremaVectors: ExtremaVectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../test-vectors/easing-extrema-vectors.json', import.meta.url)), 'utf8'),
);

describe('easing cross-language vectors', () => {
  it('matches all easing-vectors.json cases within tolerance', () => {
    expect(easingVectors.cases.length).toBeGreaterThanOrEqual(44);
    for (const c of easingVectors.cases) {
      const actual = cubicBezierAt(c.x1, c.y1, c.x2, c.y2, c.p);
      expect(Math.abs(actual - c.expected), `${c.preset} @ p=${c.p}`).toBeLessThanOrEqual(easingVectors.tolerance);
    }
  });
});

describe('EASING_PRESETS', () => {
  it('matches the CSS-equivalent coefficients from the contract', () => {
    expect(EASING_PRESETS.easeIn).toEqual({ x1: 0.42, y1: 0, x2: 1, y2: 1 });
    expect(EASING_PRESETS.easeOut).toEqual({ x1: 0, y1: 0, x2: 0.58, y2: 1 });
    expect(EASING_PRESETS.easeInOut).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
  });
});

describe('cubicBezierAt', () => {
  it('is clamped at the endpoints', () => {
    expect(cubicBezierAt(0.42, 0, 1, 1, 0)).toBe(0);
    expect(cubicBezierAt(0.42, 0, 1, 1, 1)).toBe(1);
    expect(cubicBezierAt(0.42, 0, 1, 1, -0.5)).toBe(0);
    expect(cubicBezierAt(0.42, 0, 1, 1, 1.5)).toBe(1);
  });

  it('easeInOut is symmetric around 0.5', () => {
    const { x1, y1, x2, y2 } = EASING_PRESETS.easeInOut;
    expect(cubicBezierAt(x1, y1, x2, y2, 0.5)).toBeCloseTo(0.5, 6);
    for (const t of [0.1, 0.2, 0.3, 0.4]) {
      const a = cubicBezierAt(x1, y1, x2, y2, t);
      const b = cubicBezierAt(x1, y1, x2, y2, 1 - t);
      expect(a + b).toBeCloseTo(1, 5);
    }
  });

  it('easeOut is the reflection of easeIn', () => {
    const ei = EASING_PRESETS.easeIn;
    const eo = EASING_PRESETS.easeOut;
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const out = cubicBezierAt(eo.x1, eo.y1, eo.x2, eo.y2, t);
      const reflected = 1 - cubicBezierAt(ei.x1, ei.y1, ei.x2, ei.y2, 1 - t);
      expect(out).toBeCloseTo(reflected, 5);
    }
  });

  it('is monotonically non-decreasing for the presets', () => {
    for (const { x1, y1, x2, y2 } of Object.values(EASING_PRESETS)) {
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const y = cubicBezierAt(x1, y1, x2, y2, i / 100);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
      expect(prev).toBeCloseTo(1, 6);
    }
  });

  it('a linear-shaped bezier reproduces identity', () => {
    for (const t of [0.1, 0.33, 0.5, 0.77]) {
      expect(cubicBezierAt(1 / 3, 1 / 3, 2 / 3, 2 / 3, t)).toBeCloseTo(t, 5);
    }
  });

  it('easeIn starts slow: value at 0.5 is below linear', () => {
    const { x1, y1, x2, y2 } = EASING_PRESETS.easeIn;
    expect(cubicBezierAt(x1, y1, x2, y2, 0.5)).toBeLessThan(0.5);
  });
});

describe('easingToBezier / easingProgress', () => {
  it('linear maps to null / identity', () => {
    expect(easingToBezier({ type: 'linear' })).toBeNull();
    expect(easingProgress({ type: 'linear' }, 0.42)).toBe(0.42);
  });

  it('custom cubicBezier uses its own coefficients', () => {
    expect(easingToBezier({ type: 'cubicBezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })).toEqual({
      x1: 0.1,
      y1: 0.2,
      x2: 0.3,
      y2: 0.4,
    });
    expect(easingProgress({ type: 'cubicBezier', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }, 0.5)).toBeCloseTo(
      0.5,
      5,
    );
  });

  it('presets resolve to the preset coefficients', () => {
    expect(easingToBezier({ type: 'easeInOut' })).toBe(EASING_PRESETS.easeInOut);
  });
});

describe('bezierValueExtrema', () => {
  it('matches all easing-extrema-vectors.json cases within tolerance', () => {
    expect(extremaVectors.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of extremaVectors.cases) {
      const { min, max } = bezierValueExtrema(c.y1, c.y2);
      expect(Math.abs(min - c.min), `${c.name} min`).toBeLessThanOrEqual(extremaVectors.tolerance);
      expect(Math.abs(max - c.max), `${c.name} max`).toBeLessThanOrEqual(extremaVectors.tolerance);
    }
  });

  it('every editor preset stays exactly inside [0,1] (the measured no-overshoot fact)', () => {
    // Bu, "kapılar keyframe min/max okusun" varsayımını bugüne kadar ayakta tutan ölçümün
    // kalıcı hali: preset katalogu değişir de overshoot'lu bir preset eklenirse bu test
    // GÜNCELLENİR (yasak değildir) — kapılar zaten gerçek ekstremumu okuduğundan ürün
    // davranışı hazırdır.
    for (const { y1, y2 } of Object.values(EASING_PRESETS)) {
      expect(bezierValueExtrema(y1, y2)).toEqual({ min: 0, max: 1 });
    }
  });

  it('COVERS a dense scan of the operational curve (the closed form is never narrower)', () => {
    // Ölçüm kurumsallaştı: kapalı form, bisection'lı gerçek örnekleme fonksiyonunun 20k
    // noktalık taramasını her vektör vakasında kapsamalı ve tepe noktasında ~1e-6'dan
    // fazla sapmamalı (tarama çözünürlüğü sınırı; karar ölçümünde aynı yoğunlukta 3.1e-8
    // görüldü — 2k noktalı tarama ±10'luk uç vakada 1.5e-6 açık bırakıyordu).
    for (const c of extremaVectors.cases) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= 20000; i++) {
        const v = cubicBezierAt(c.x1, c.y1, c.x2, c.y2, i / 20000);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const { min, max } = bezierValueExtrema(c.y1, c.y2);
      expect(min, `${c.name}: closed min covers scan`).toBeLessThanOrEqual(lo + 1e-12);
      expect(max, `${c.name}: closed max covers scan`).toBeGreaterThanOrEqual(hi - 1e-12);
      expect(lo - min, `${c.name}: closed min is tight`).toBeLessThanOrEqual(1e-6);
      expect(max - hi, `${c.name}: closed max is tight`).toBeLessThanOrEqual(1e-6);
    }
  });
});

describe('keyframeCurveExtrema', () => {
  const bez = (y1: number, y2: number) =>
    ({ type: 'cubicBezier', x1: 0.3, y1, x2: 0.6, y2 }) as const;

  it('equals the keyframe hull for linear and preset tracks (editor-produced documents)', () => {
    const track: Keyframe[] = [
      { timeUs: 0, value: 0.5, easing: { type: 'easeInOut' } },
      { timeUs: 1000, value: 2, easing: { type: 'linear' } },
      { timeUs: 2000, value: 1, easing: { type: 'easeOut' } },
      { timeUs: 3000, value: 1.5, easing: { type: 'easeIn' } },
    ];
    expect(keyframeCurveExtrema(track)).toEqual({ min: 0.5, max: 2 });
  });

  it('a single keyframe is a constant', () => {
    expect(keyframeCurveExtrema([{ timeUs: 0, value: 7, easing: { type: 'linear' } }])).toEqual({
      min: 7,
      max: 7,
    });
  });

  it('an undershooting bezier widens the floor below the keyframe minimum (the measured hole)', () => {
    // Karar ölçümünün vakası: scale 0.02 -> 1.0, (0.3,-4,0.6,1). 30fps kare örneklemi
    // -1.499'a inmişti; eğri tabanı 0.02 + 0.98*(-1.5510204081632655).
    const track: Keyframe[] = [
      { timeUs: 0, value: 0.02, easing: bez(-4, 1) },
      { timeUs: 1_000_000, value: 1, easing: { type: 'linear' } },
    ];
    const { min, max } = keyframeCurveExtrema(track);
    expect(min).toBeCloseTo(0.02 + 0.98 * -1.5510204081632655, 12);
    expect(max).toBe(1);
  });

  it('an overshooting bezier widens the ceiling above the keyframe maximum', () => {
    const track: Keyframe[] = [
      { timeUs: 0, value: 1, easing: bez(0, 6) },
      { timeUs: 1_000_000, value: 2, easing: { type: 'linear' } },
    ];
    const { min, max } = keyframeCurveExtrema(track);
    expect(min).toBe(1);
    expect(max).toBeCloseTo(1 + 2.9896193771626294, 12);
  });

  it('a zero-delta segment is constant no matter how wild its easing is', () => {
    const track: Keyframe[] = [
      { timeUs: 0, value: 1, easing: bez(-10, 10) },
      { timeUs: 1000, value: 1, easing: { type: 'linear' } },
    ];
    expect(keyframeCurveExtrema(track)).toEqual({ min: 1, max: 1 });
  });

  it('COVERS dense integer-µs sampling of sampleKeyframes itself', () => {
    // Kapalı formun kapsadığı şey OPERASYONEL eğridir: 2001 gerçek örnek (tamsayı µs,
    // sampleKeyframes'in kendisi) hull'un dışına asla çıkmamalı.
    const track: Keyframe[] = [
      { timeUs: 0, value: 0.4, easing: bez(-2, 3) },
      { timeUs: 400_000, value: 1.6, easing: { type: 'easeInOut' } },
      { timeUs: 1_000_000, value: 0.9, easing: bez(1.8, -0.9) },
      { timeUs: 1_500_000, value: 1.1, easing: { type: 'linear' } },
    ];
    const { min, max } = keyframeCurveExtrema(track);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const v = sampleKeyframes(track, Math.round((i / 2000) * 1_500_000));
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(min).toBeLessThanOrEqual(lo + 1e-12);
    expect(max).toBeGreaterThanOrEqual(hi - 1e-12);
    // Ve hull gevşek de değil: yoğun tarama tepelere 1e-3 bandında yaklaşır.
    expect(lo - min).toBeLessThanOrEqual(1e-3);
    expect(max - hi).toBeLessThanOrEqual(1e-3);
  });

  it('rejects empty tracks', () => {
    expect(() => keyframeCurveExtrema([])).toThrow();
  });
});

describe('sampleKeyframes', () => {
  const linear: Keyframe[] = [
    { timeUs: 0, value: 0, easing: { type: 'linear' } },
    { timeUs: 1000, value: 100, easing: { type: 'linear' } },
  ];

  it('interpolates linearly between keyframes', () => {
    expect(sampleKeyframes(linear, 500)).toBeCloseTo(50, 9);
    expect(sampleKeyframes(linear, 250)).toBeCloseTo(25, 9);
  });

  it('holds the first value before and the last value after the track', () => {
    expect(sampleKeyframes(linear, 0)).toBe(0);
    expect(sampleKeyframes(linear, 1000)).toBe(100);
    expect(sampleKeyframes(linear, 5000)).toBe(100);
  });

  it('applies the easing of the keyframe that starts the segment', () => {
    const eased: Keyframe[] = [
      { timeUs: 0, value: 0, easing: { type: 'easeIn' } },
      { timeUs: 1000, value: 100, easing: { type: 'linear' } },
    ];
    // easeIn starts slow, so the midpoint must be below the linear midpoint.
    expect(sampleKeyframes(eased, 500)).toBeLessThan(50);
    expect(sampleKeyframes(eased, 500)).toBeGreaterThan(0);
  });

  it('supports multi-segment tracks', () => {
    const kfs: Keyframe[] = [
      { timeUs: 0, value: 0, easing: { type: 'linear' } },
      { timeUs: 1000, value: 10, easing: { type: 'linear' } },
      { timeUs: 2000, value: -10, easing: { type: 'linear' } },
    ];
    expect(sampleKeyframes(kfs, 1500)).toBeCloseTo(0, 9);
    expect(sampleKeyframes(kfs, 1000)).toBe(10);
  });

  it('a single keyframe is a constant', () => {
    const kfs: Keyframe[] = [{ timeUs: 500, value: 7, easing: { type: 'linear' } }];
    expect(sampleKeyframes(kfs, 0)).toBe(7);
    expect(sampleKeyframes(kfs, 500)).toBe(7);
    expect(sampleKeyframes(kfs, 9999)).toBe(7);
  });

  it('rejects empty tracks and non-integer time', () => {
    expect(() => sampleKeyframes([], 0)).toThrow();
    expect(() => sampleKeyframes(linear, 0.5)).toThrow(RangeError);
  });
});
