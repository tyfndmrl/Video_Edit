import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cubicBezierAt,
  EASING_PRESETS,
  easingProgress,
  easingToBezier,
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
