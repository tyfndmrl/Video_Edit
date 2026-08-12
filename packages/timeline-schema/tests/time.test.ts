import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  floorDurationToFrameSpan,
  formatTimecode,
  frameSpanCount,
  frameSpanUs,
  frameToUs,
  isClipOnFrameGrid,
  isOnFrameGrid,
  snapDurationToFrameSpan,
  snapUsToFrameGrid,
  solveSpeedChange,
  sourceSpanForDuration,
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

describe('solveSpeedChange', () => {
  /**
   * The two gates the export compiler applies to the SAME clip, restated here
   * exactly as the C# enforces them:
   *   (i)  ExportCompiler.ValidateMediaClip — `TimelineDurationUs ==
   *        Timecode.ClipTimelineDurationUs(SourceInUs, SourceOutUs, rate)`;
   *   (ii) ExportCompiler.Validate — both clip EDGES on the grid; with the
   *        default start of 0 that reduces to `SnapUs(duration) == duration`,
   *        which is what these cases assert. The general case (a clip that does
   *        NOT start at 0) is covered in the timelineStartUs block below.
   * A solution is only correct when it satisfies BOTH.
   */
  function expectBothGates(
    solution: { durationUs: number; durationFrames: number; sourceOutUs: number },
    sourceInUs: number,
    rate: number,
    fps: Rational,
  ): void {
    expect(clipTimelineDurationUs(sourceInUs, solution.sourceOutUs, rate)).toBe(solution.durationUs);
    expect(snapUsToFrameGrid(solution.durationUs, fps)).toBe(solution.durationUs);
    expect(frameToUs(solution.durationFrames, fps)).toBe(solution.durationUs);
    expect(solution.sourceOutUs).toBeGreaterThan(sourceInUs);
  }

  it('solves the shipped defect vector (30 fps, 3 s at 0.7x)', () => {
    const fps = { num: 30, den: 1 };
    // The formula alone gives 4_285_714 us, which is NOT on the 30 fps grid —
    // the compiler rejected exactly this value.
    expect(clipTimelineDurationUs(0, 3_000_000, 0.7)).toBe(4_285_714);
    expect(snapUsToFrameGrid(4_285_714, fps)).toBe(4_300_000);

    const solved = solveSpeedChange(0, 3_000_000, 0.7, fps);
    expect(solved).not.toBeNull();
    expect(solved!.durationUs).toBe(4_300_000);
    expect(solved!.sourceOutUs).toBe(3_010_000);
    expectBothGates(solved!, 0, 0.7, fps);
  });

  it('NEGATIVE CONTROL: snapping the duration alone breaks the duration formula', () => {
    const fps = { num: 30, den: 1 };
    const snappedOnly = snapUsToFrameGrid(clipTimelineDurationUs(0, 3_000_000, 0.7), fps);
    // Gate (ii) passes...
    expect(snapUsToFrameGrid(snappedOnly, fps)).toBe(snappedOnly);
    // ...and gate (i) now fails, which is why the fix has to move sourceOut too.
    expect(clipTimelineDurationUs(0, 3_000_000, 0.7)).not.toBe(snappedOnly);
  });

  it('NEGATIVE CONTROL: the naive re-derivation fails below 1x', () => {
    const fps = { num: 30, den: 1 };
    const rate = 0.1;
    // `sourceOut = sourceIn + roundHalfUp(gridDuration * rate)` only round-trips
    // while rate >= 1: at 0.1 the source span is a TENTH of the duration, so
    // rounding it to whole microseconds moves the duration by up to 5 us — and
    // frame 1 at 30 fps (33_333 us) is not reachable from any integer span.
    const naiveDuration = snapUsToFrameGrid(clipTimelineDurationUs(0, 3_333, rate), fps);
    expect(naiveDuration).toBe(33_333);
    const naiveOut = Math.floor(naiveDuration * rate + 0.5);
    expect(clipTimelineDurationUs(0, naiveOut, rate)).toBe(33_330);
    expect(clipTimelineDurationUs(0, naiveOut, rate)).not.toBe(naiveDuration);

    // The solver walks past the unreachable frame counts instead of writing a
    // document that fails gate (i).
    const solved = solveSpeedChange(0, 3_333, rate, fps);
    expect(solved).not.toBeNull();
    expectBothGates(solved!, 0, rate, fps);
  });

  it('satisfies both gates for every fps x rate x span combination', () => {
    const rates = [0.1, 0.125, 0.199, 0.25, 0.333, 0.5, 0.7, 0.99, 1, 1.001, 1.5, 2, 3.7, 5, 7.25, 10];
    const spans = [1, 1000, 33_333, 100_000, 500_000, 2_000_000, 10_000_000];
    for (const fps of ALL_FPS) {
      for (const rate of rates) {
        for (const span of spans) {
          const solved = solveSpeedChange(1_234, 1_234 + span, rate, fps);
          expect(solved, `fps=${fps.num}/${fps.den} rate=${rate} span=${span}`).not.toBeNull();
          expectBothGates(solved!, 1_234, rate, fps);
        }
      }
    }
  });

  it('lands on the NEAREST frame whenever every frame is reachable (rate >= 1)', () => {
    // At rate >= 1 the admissible source window is at least one microsecond
    // wide, so no frame count is ever skipped and the answer must be the plain
    // grid snap of the ideal duration.
    for (const fps of ALL_FPS) {
      for (const rate of [1, 1.001, 1.5, 2, 3.7, 10]) {
        for (const span of [7_777, 500_000, 5_000_000]) {
          const ideal = clipTimelineDurationUs(0, span, rate);
          const solved = solveSpeedChange(0, span, rate, fps)!;
          // ...bounded below by the one-frame floor: a clip shorter than a
          // single project frame cannot be rendered at all.
          const expectedFrames = Math.max(1, usToFrame(ideal, fps));
          expect(solved.durationUs, `fps=${fps.num}/${fps.den} rate=${rate} span=${span}`).toBe(
            frameToUs(expectedFrames, fps),
          );
        }
      }
    }
  });

  it('picks the CLOSEST reachable frame count (no nearer one is admissible)', () => {
    // Independent re-derivation of "reachable": gate (i) inverted says the
    // source span must satisfy rate*(D-0.5) <= span < rate*(D+0.5); scan that
    // window directly instead of trusting the solver's own search.
    const reachable = (durationUs: number, rate: number): boolean => {
      const lo = Math.max(1, Math.floor(rate * (durationUs - 0.5)) - 2);
      const hi = Math.ceil(rate * (durationUs + 0.5)) + 2;
      for (let span = lo; span <= hi; span++) {
        if (clipTimelineDurationUs(0, span, rate) === durationUs) return true;
      }
      return false;
    };

    for (const fps of ALL_FPS) {
      for (const rate of [0.1, 0.125, 0.199, 0.25, 0.333, 0.5, 0.7, 0.99]) {
        for (const span of [3_333, 40_000, 500_000, 5_000_000]) {
          const ideal = clipTimelineDurationUs(0, span, rate);
          const solved = solveSpeedChange(0, span, rate, fps)!;
          const distance = Math.abs(solved.durationUs - ideal);
          const solvedFrames = solved.durationFrames;
          for (let frames = Math.max(1, solvedFrames - 8); frames <= solvedFrames + 8; frames++) {
            const durationUs = frameToUs(frames, fps);
            if (Math.abs(durationUs - ideal) >= distance) continue;
            expect(
              reachable(durationUs, rate),
              `fps=${fps.num}/${fps.den} rate=${rate} span=${span}: ${durationUs}us is nearer than the chosen ${solved.durationUs}us`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('never reads past maxSourceOutUs', () => {
    const fps = { num: 30, den: 1 };
    // Unconstrained, 0.7x grows the out point from 3_000_000 to 3_010_000.
    expect(solveSpeedChange(0, 3_000_000, 0.7, fps)!.sourceOutUs).toBe(3_010_000);
    // With the asset ending at exactly 3 s the solver must settle lower.
    const capped = solveSpeedChange(0, 3_000_000, 0.7, fps, { maxSourceOutUs: 3_000_000 })!;
    expect(capped.sourceOutUs).toBeLessThanOrEqual(3_000_000);
    expectBothGates(capped, 0, 0.7, fps);
  });

  it('honours minFrames and refuses when the cap leaves no room', () => {
    const fps = { num: 30, den: 1 };
    const solved = solveSpeedChange(0, 1_000, 10, fps, { minFrames: 2 })!;
    expect(solved.durationFrames).toBeGreaterThanOrEqual(2);
    expectBothGates(solved, 0, 10, fps);

    expect(solveSpeedChange(500, 1_000, 1, fps, { maxSourceOutUs: 500 })).toBeNull();
    expect(solveSpeedChange(1_000, 1_000, 1, fps)).toBeNull();
  });

  it('leaves sourceIn alone and is stable at 1x on a grid-aligned clip', () => {
    const fps = { num: 30, den: 1 };
    const solved = solveSpeedChange(500_000, 3_500_000, 1, fps)!;
    expect(solved.sourceOutUs).toBe(3_500_000);
    expect(solved.durationUs).toBe(3_000_000);
  });

  it('rejects invalid rates and non-integer inputs', () => {
    const fps = { num: 30, den: 1 };
    expect(() => solveSpeedChange(0, 1_000, 0, fps)).toThrow(RangeError);
    expect(() => solveSpeedChange(0, 1_000, Number.NaN, fps)).toThrow(RangeError);
    expect(() => solveSpeedChange(0.5, 1_000, 1, fps)).toThrow(RangeError);
    expect(() => solveSpeedChange(0, 1_000, 1, { num: 0, den: 1 })).toThrow(RangeError);
  });
});

describe('isOnFrameGrid', () => {
  it('is true exactly for frame boundaries', () => {
    const fps = { num: 30, den: 1 };
    expect(isOnFrameGrid(frameToUs(7, fps), fps)).toBe(true);
    expect(isOnFrameGrid(33_334, fps)).toBe(false);
    expect(isOnFrameGrid(0, fps)).toBe(true);
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

// ---------------------------------------------------------------------------
// Frame SPANS — the rule the export compiler actually enforces
// ---------------------------------------------------------------------------

describe('frame spans (frameSpanUs / frameSpanCount / isClipOnFrameGrid)', () => {
  it('proves the premise: the grid is NOT closed under addition outside 25 fps', () => {
    const fps30 = { num: 30, den: 1 };
    expect(frameToUs(1, fps30)).toBe(33_333);
    expect(frameToUs(2, fps30)).toBe(66_667);
    // Two "one frame" durations do not add up to a grid value...
    expect(isOnFrameGrid(33_333 + 33_333, fps30)).toBe(false);
    // ...so a one-frame clip starting on frame 1 is 33_334 us long, and that
    // length is not a grid value either. Only the EDGES are.
    expect(frameSpanUs(33_333, 1, fps30)).toBe(33_334);
    expect(isOnFrameGrid(33_334, fps30)).toBe(false);
    expect(isClipOnFrameGrid(33_333, 33_334, fps30)).toBe(true);
    expect(isClipOnFrameGrid(33_333, 33_333, fps30)).toBe(false);

    // 25 fps is the exception that hid the bug: 40_000 us per frame, closed.
    const fps25 = { num: 25, den: 1 };
    expect(frameSpanUs(40_000, 1, fps25)).toBe(40_000);
    expect(isClipOnFrameGrid(40_000, 40_000, fps25)).toBe(true);
  });

  it('lands the clip END on the grid from EVERY grid start, at every fps', () => {
    for (const fps of ALL_FPS) {
      for (let startFrame = 0; startFrame < 12; startFrame++) {
        const startUs = frameToUs(startFrame, fps);
        for (let frames = 1; frames <= 12; frames++) {
          const durationUs = frameSpanUs(startUs, frames, fps);
          expect(isOnFrameGrid(startUs + durationUs, fps)).toBe(true);
          expect(isClipOnFrameGrid(startUs, durationUs, fps)).toBe(true);
          expect(frameSpanCount(startUs, durationUs, fps)).toBe(frames);
        }
      }
    }
  });

  it('floorDurationToFrameSpan never exceeds the source, snapDurationToFrameSpan is nearest', () => {
    for (const fps of ALL_FPS) {
      for (const startFrame of [0, 1, 2, 5]) {
        const startUs = frameToUs(startFrame, fps);
        // Real ffprobe durations.
        for (const sourceUs of [7_307_300, 12_679_333, 4_000_000, 1_001_000]) {
          const floored = floorDurationToFrameSpan(startUs, sourceUs, fps);
          expect(floored).toBeGreaterThan(0);
          expect(floored).toBeLessThanOrEqual(sourceUs);
          expect(isClipOnFrameGrid(startUs, floored, fps)).toBe(true);
          // ...and it is the LARGEST such span: one more frame overshoots.
          const oneMore = frameSpanUs(startUs, frameSpanCount(startUs, floored, fps) + 1, fps);
          expect(oneMore).toBeGreaterThan(sourceUs);

          const snapped = snapDurationToFrameSpan(startUs, sourceUs, fps);
          expect(isClipOnFrameGrid(startUs, snapped, fps)).toBe(true);
          expect(Math.abs(snapped - sourceUs)).toBeLessThanOrEqual(frameToUs(1, fps));
        }
      }
    }
  });

  it('floorDurationToFrameSpan returns 0 below one frame (callers must refuse)', () => {
    const fps = { num: 30, den: 1 };
    expect(floorDurationToFrameSpan(0, 33_332, fps)).toBe(0);
    expect(floorDurationToFrameSpan(0, 33_333, fps)).toBe(33_333);
    expect(floorDurationToFrameSpan(0, 0, fps)).toBe(0);
  });

  it('snapDurationToFrameSpan never returns less than one frame', () => {
    const fps = { num: 30, den: 1 };
    expect(snapDurationToFrameSpan(33_333, 1, fps)).toBe(33_334);
    expect(snapDurationToFrameSpan(0, 1, fps)).toBe(33_333);
  });
});

describe('solveSpeedChange with timelineStartUs (edge-based gate)', () => {
  it('returns a duration whose END is on the grid, for every start x rate x fps', () => {
    for (const fps of ALL_FPS) {
      for (const startFrame of [0, 1, 2, 7]) {
        const startUs = frameToUs(startFrame, fps);
        for (const rate of [0.5, 0.7, 1, 1.235, 2, 4]) {
          const solved = solveSpeedChange(0, 3_000_000, rate, fps, { timelineStartUs: startUs });
          expect(solved, `fps=${fps.num}/${fps.den} start=${startUs} rate=${rate}`).not.toBeNull();
          // Gate (i): the duration formula stays exact.
          expect(clipTimelineDurationUs(0, solved!.sourceOutUs, rate)).toBe(solved!.durationUs);
          // Gate (ii): BOTH edges on the grid.
          expect(isClipOnFrameGrid(startUs, solved!.durationUs, fps)).toBe(true);
        }
      }
    }
  });

  it('defaults to a start of 0 (the historical behaviour)', () => {
    const fps = { num: 30, den: 1 };
    expect(solveSpeedChange(0, 3_000_000, 0.7, fps)!.durationUs).toBe(
      solveSpeedChange(0, 3_000_000, 0.7, fps, { timelineStartUs: 0 })!.durationUs,
    );
  });

  it('NEGATIVE CONTROL: ignoring the start puts the clip END off the grid', () => {
    const fps = { num: 30, den: 1 };
    const startUs = 33_333; // frame 1
    // Solving as if the clip started at 0 (what the shipped code did) gives a
    // duration that IS a grid value...
    const asIfAtZero = solveSpeedChange(0, 33_333, 1, fps)!;
    expect(isOnFrameGrid(asIfAtZero.durationUs, fps)).toBe(true);
    // ...and whose end, placed at frame 1, is NOT — an HTTP 422 at export.
    expect(isOnFrameGrid(startUs + asIfAtZero.durationUs, fps)).toBe(false);
    // Told where the clip sits, the solver answers correctly.
    const solved = solveSpeedChange(0, 33_333, 1, fps, { timelineStartUs: startUs })!;
    expect(isClipOnFrameGrid(startUs, solved.durationUs, fps)).toBe(true);
  });
});

describe('sourceSpanForDuration', () => {
  it('inverts the duration formula exactly, or reports that it cannot', () => {
    for (const rate of [0.1, 0.5, 1, 1.235, 2, 10]) {
      for (const durationUs of [33_333, 33_334, 40_000, 1_001_000]) {
        const span = sourceSpanForDuration(durationUs, rate);
        if (span === null) continue;
        expect(clipTimelineDurationUs(0, span, rate)).toBe(durationUs);
      }
    }
  });

  it('respects the maximum span (the asset can be shorter than the ask)', () => {
    expect(sourceSpanForDuration(1_000_000, 1, 999_999)).toBeNull();
    expect(sourceSpanForDuration(1_000_000, 1, 1_000_000)).toBe(1_000_000);
  });
});
