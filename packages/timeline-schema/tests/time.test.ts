import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  formatTimecode,
  frameToUs,
  snapUsToFrameGrid,
  usToFrame,
  type Rational,
} from '../src/time.js';

interface Vectors {
  usToFrame: { fpsNum: number; fpsDen: number; timeUs: number; expected: number }[];
  frameToUs: { fpsNum: number; fpsDen: number; frame: number; expected: number }[];
  duration: { sourceInUs: number; sourceOutUs: number; rate: number; expected: number }[];
  timecode: { fpsNum: number; fpsDen: number; timeUs: number; expected: string }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../test-vectors/time-vectors.json', import.meta.url)), 'utf8'),
);

const ALL_FPS: Rational[] = [
  { num: 24000, den: 1001 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 30000, den: 1001 },
  { num: 60, den: 1 },
];

describe('cross-language test vectors', () => {
  it('has enough coverage', () => {
    const total =
      vectors.usToFrame.length + vectors.frameToUs.length + vectors.duration.length + vectors.timecode.length;
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it.each(vectors.usToFrame)('usToFrame($timeUs, $fpsNum/$fpsDen) = $expected', (c) => {
    expect(usToFrame(c.timeUs, { num: c.fpsNum, den: c.fpsDen })).toBe(c.expected);
  });

  it.each(vectors.frameToUs)('frameToUs($frame, $fpsNum/$fpsDen) = $expected', (c) => {
    expect(frameToUs(c.frame, { num: c.fpsNum, den: c.fpsDen })).toBe(c.expected);
  });

  it.each(vectors.duration)(
    'clipTimelineDurationUs($sourceInUs, $sourceOutUs, $rate) = $expected',
    (c) => {
      expect(clipTimelineDurationUs(c.sourceInUs, c.sourceOutUs, c.rate)).toBe(c.expected);
    },
  );

  it.each(vectors.timecode)('formatTimecode($timeUs, $fpsNum/$fpsDen) = $expected', (c) => {
    expect(formatTimecode(c.timeUs, { num: c.fpsNum, den: c.fpsDen })).toBe(c.expected);
  });
});

describe('usToFrame / frameToUs', () => {
  it('round-trips frame indices exactly on every project fps', () => {
    for (const fps of ALL_FPS) {
      for (let frame = 0; frame <= 200; frame++) {
        expect(usToFrame(frameToUs(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it('rounds half-up at the midpoint (25 fps: 20000us -> frame 1)', () => {
    expect(usToFrame(20000, { num: 25, den: 1 })).toBe(1);
  });
});

describe('snapUsToFrameGrid', () => {
  it('returns a value on the frame grid and is idempotent', () => {
    for (const fps of ALL_FPS) {
      for (const timeUs of [0, 12345, 999999, 41708, 33366, 3600000000]) {
        const snapped = snapUsToFrameGrid(timeUs, fps);
        expect(snapped).toBe(frameToUs(usToFrame(timeUs, fps), fps));
        expect(snapUsToFrameGrid(snapped, fps)).toBe(snapped);
      }
    }
  });
});

describe('formatTimecode', () => {
  it('pads all fields to two digits', () => {
    expect(formatTimecode(0, { num: 25, den: 1 })).toBe('00:00:00:00');
  });

  it('uses floor for the frame count (not round)', () => {
    // 41708us at 23.976 rounds to frame 1 but floors to frame 0.
    expect(usToFrame(41708, { num: 24000, den: 1001 })).toBe(1);
    expect(formatTimecode(41708, { num: 24000, den: 1001 })).toBe('00:00:00:00');
  });

  it('rejects negative time', () => {
    expect(() => formatTimecode(-1, { num: 25, den: 1 })).toThrow(RangeError);
  });
});

describe('integer discipline', () => {
  it('rejects non-integer time inputs', () => {
    expect(() => usToFrame(0.5, { num: 25, den: 1 })).toThrow(RangeError);
    expect(() => frameToUs(1.5, { num: 25, den: 1 })).toThrow(RangeError);
    expect(() => clipTimelineDurationUs(0.5, 100, 1)).toThrow(RangeError);
    expect(() => clipTimelineDurationUs(0, 100.5, 1)).toThrow(RangeError);
    expect(() => snapUsToFrameGrid(0.1, { num: 25, den: 1 })).toThrow(RangeError);
    expect(() => formatTimecode(1.2, { num: 25, den: 1 })).toThrow(RangeError);
  });

  it('rejects non-integer or non-positive fps rationals', () => {
    expect(() => usToFrame(0, { num: 29.97, den: 1 })).toThrow(RangeError);
    expect(() => usToFrame(0, { num: 0, den: 1 })).toThrow(RangeError);
    expect(() => usToFrame(0, { num: 25, den: 0 })).toThrow(RangeError);
  });

  it('rejects invalid speed rates', () => {
    expect(() => clipTimelineDurationUs(0, 100, 0)).toThrow(RangeError);
    expect(() => clipTimelineDurationUs(0, 100, -1)).toThrow(RangeError);
    expect(() => clipTimelineDurationUs(0, 100, Number.NaN)).toThrow(RangeError);
  });
});
