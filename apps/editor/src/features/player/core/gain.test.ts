/**
 * Gain math tests against docs/rendering-semantics.md §8:
 * linear volume (§8.1), linear fades (§8.2), 5 ms micro-fade rules (§8.4)
 * and keyframed volume (§3 interpolation).
 */
import { describe, expect, it } from 'vitest';
import type { ClipAudio, Keyframe } from '@videoedit/timeline-schema';
import {
  buildGainCurve,
  clipGainAt,
  fadeEnvelopeAt,
  isSeamlessSplice,
  MICRO_FADE_US,
  shouldMicroFadeIn,
  shouldMicroFadeOut,
  spliceEdgeToleranceUs,
} from './gain';
import { mkMediaClip, UNITY_AUDIO } from './testFixtures';

const SEC = 1_000_000;
const DUR = 10 * SEC;

function audio(overrides: Partial<ClipAudio> = {}): ClipAudio {
  return { ...UNITY_AUDIO, ...overrides };
}

describe('fadeEnvelopeAt (§8.2: linear g = t/D in, 1 - t/D out)', () => {
  it('no fades: 1 inside the clip, 0 outside', () => {
    expect(fadeEnvelopeAt(audio(), DUR, 0)).toBe(1);
    expect(fadeEnvelopeAt(audio(), DUR, DUR)).toBe(1);
    expect(fadeEnvelopeAt(audio(), DUR, -1)).toBe(0);
    expect(fadeEnvelopeAt(audio(), DUR, DUR + 1)).toBe(0);
  });

  it('fade-in is linear: g(t) = t/D', () => {
    const a = audio({ fadeInUs: 1 * SEC });
    expect(fadeEnvelopeAt(a, DUR, 0)).toBe(0);
    expect(fadeEnvelopeAt(a, DUR, 250_000)).toBeCloseTo(0.25, 9);
    expect(fadeEnvelopeAt(a, DUR, 500_000)).toBeCloseTo(0.5, 9);
    expect(fadeEnvelopeAt(a, DUR, 1 * SEC)).toBe(1); // fade complete
  });

  it('fade-out is linear: g(t) = (dur - t)/D', () => {
    const a = audio({ fadeOutUs: 2 * SEC });
    expect(fadeEnvelopeAt(a, DUR, DUR)).toBe(0);
    expect(fadeEnvelopeAt(a, DUR, DUR - 500_000)).toBeCloseTo(0.25, 9);
    expect(fadeEnvelopeAt(a, DUR, DUR - 2 * SEC)).toBe(1);
  });

  it('overlapping fade-in and fade-out multiply', () => {
    // 2 s clip, 2 s in AND 2 s out: at t=1s -> in 0.5 * out 0.5 = 0.25
    const a = audio({ fadeInUs: 2 * SEC, fadeOutUs: 2 * SEC });
    expect(fadeEnvelopeAt(a, 2 * SEC, 1 * SEC)).toBeCloseTo(0.25, 9);
  });
});

describe('clipGainAt (§8.1 linear volume x envelope)', () => {
  it('volume is a LINEAR multiplier (2 = +6 dB, not dB math)', () => {
    expect(clipGainAt(audio({ volume: 2 }), DUR, 5 * SEC)).toBe(2);
    expect(clipGainAt(audio({ volume: 0.5 }), DUR, 5 * SEC)).toBe(0.5);
  });

  it('muted -> 0 regardless of volume/fades', () => {
    expect(clipGainAt(audio({ volume: 2, muted: true }), DUR, 5 * SEC)).toBe(0);
  });

  it('volume multiplies the fade envelope', () => {
    const a = audio({ volume: 1.5, fadeInUs: 1 * SEC });
    expect(clipGainAt(a, DUR, 500_000)).toBeCloseTo(0.75, 9);
  });

  it('keyframed volume overrides the base and interpolates linearly (§3)', () => {
    const kf: Keyframe[] = [
      { timeUs: 0, value: 0, easing: { type: 'linear' } },
      { timeUs: DUR, value: 2, easing: { type: 'linear' } },
    ];
    // base volume (ignored) = 1; midpoint keyframe value = 1
    expect(clipGainAt(audio({ volume: 1 }), DUR, 5 * SEC, kf)).toBeCloseTo(1, 9);
    expect(clipGainAt(audio(), DUR, 2_500_000, kf)).toBeCloseTo(0.5, 9);
  });
});

describe('buildGainCurve (setValueCurveAtTime input)', () => {
  it('samples the window inclusively with the requested count', () => {
    // 100 ms window, 21 samples -> 5 ms step; volume 1, no fades, no micro
    const curve = buildGainCurve(audio(), 100_000, 0, 100_000, 21);
    expect(curve).toHaveLength(21);
    expect([...curve]).toEqual(new Array(21).fill(1));
  });

  it('renders an explicit fade-in linearly across the samples', () => {
    // dur 1 s, fadeIn 1 s, window [0, 1 s], 5 samples -> 0, .25, .5, .75, 1
    const curve = buildGainCurve(audio({ fadeInUs: 1 * SEC }), 1 * SEC, 0, 1 * SEC, 5);
    expect(curve[0]).toBeCloseTo(0, 6);
    expect(curve[1]).toBeCloseTo(0.25, 6);
    expect(curve[2]).toBeCloseTo(0.5, 6);
    expect(curve[3]).toBeCloseTo(0.75, 6);
    expect(curve[4]).toBeCloseTo(1, 6);
  });

  it('micro-fade-in zeroes the window start and ends 5 ms later (§8.4)', () => {
    // 100 ms window, 21 samples -> exactly one sample inside the 5 ms ramp edge
    const curve = buildGainCurve(audio(), 100_000, 0, 100_000, 21, { microFadeIn: true });
    expect(curve[0]).toBe(0); // hard boundary starts silent
    expect(curve[1]).toBeCloseTo(1, 6); // t = 5 ms -> ramp already complete
    expect(curve[20]).toBeCloseTo(1, 6); // no micro-fade-out requested
  });

  it('micro-fade-out zeroes the window end', () => {
    const curve = buildGainCurve(audio(), 100_000, 0, 100_000, 21, { microFadeOut: true });
    expect(curve[0]).toBeCloseTo(1, 6);
    expect(curve[20]).toBe(0);
    // halfway through the last 5 ms step: t=97.5ms -> (100-97.5)/5 = 0.5
    const fine = buildGainCurve(audio(), 100_000, 0, 100_000, 41, { microFadeOut: true });
    expect(fine[39]).toBeCloseTo(0.5, 6);
  });

  it("§8.4: the user's own fade at the edge SUPPRESSES the micro-fade", () => {
    // fadeIn 10 ms covers the start edge: at t=2.5ms the explicit fade gives
    // 0.25 — an (incorrect) extra micro-fade would halve it to 0.125.
    const a = audio({ fadeInUs: 10_000 });
    const curve = buildGainCurve(a, 100_000, 0, 100_000, 41, { microFadeIn: true });
    expect(curve[1]).toBeCloseTo(0.25, 6);
  });

  it('micro-fade-in still applies on a mid-clip resume even with a fadeIn', () => {
    // window starts at 50 ms (not the clip edge) -> user fade does not cover it
    const a = audio({ fadeInUs: 10_000 });
    const curve = buildGainCurve(a, 100_000, 50_000, 100_000, 21, { microFadeIn: true });
    expect(curve[0]).toBe(0); // resume ramps from silence (click prevention)
  });

  it('always returns at least 2 samples', () => {
    expect(buildGainCurve(audio(), DUR, 0, DUR, 0)).toHaveLength(2);
  });
});

describe('isSeamlessSplice (§8.4 exception)', () => {
  const a = mkMediaClip({
    id: 'a',
    assetId: 'X',
    startUs: 0,
    durationUs: 2 * SEC,
    sourceInUs: 0,
    sourceOutUs: 2 * SEC,
  });

  it('true for a split pair: same asset+rate, contiguous timeline AND source', () => {
    const b = mkMediaClip({
      id: 'b',
      assetId: 'X',
      startUs: 2 * SEC,
      durationUs: 3 * SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 5 * SEC,
    });
    expect(isSeamlessSplice(a, b)).toBe(true);
  });

  it('false when any continuity condition breaks', () => {
    const otherAsset = mkMediaClip({
      id: 'b',
      assetId: 'Y',
      startUs: 2 * SEC,
      durationUs: SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 3 * SEC,
    });
    expect(isSeamlessSplice(a, otherAsset)).toBe(false);

    const timelineGap = mkMediaClip({
      id: 'b',
      assetId: 'X',
      startUs: 2 * SEC + 1,
      durationUs: SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 3 * SEC,
    });
    expect(isSeamlessSplice(a, timelineGap)).toBe(false);

    const sourceJump = mkMediaClip({
      id: 'b',
      assetId: 'X',
      startUs: 2 * SEC,
      durationUs: SEC,
      sourceInUs: 3 * SEC, // skips 1 s of source
      sourceOutUs: 4 * SEC,
    });
    expect(isSeamlessSplice(a, sourceJump)).toBe(false);

    const differentRate = mkMediaClip({
      id: 'b',
      assetId: 'X',
      startUs: 2 * SEC,
      durationUs: SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 4 * SEC,
      rate: 2,
    });
    expect(isSeamlessSplice(a, differentRate)).toBe(false);
  });
});

describe('micro-fade decisions at splice edges (clip-boundary based, §8.4)', () => {
  // 30 fps project: one frame = 33_333.3.. µs.
  const FRAME_US = 1e6 / 30;
  const a = mkMediaClip({
    id: 'a',
    assetId: 'X',
    startUs: 0,
    durationUs: 2 * SEC,
    sourceInUs: 0,
    sourceOutUs: 2 * SEC,
  });
  /** Seamless continuation of `a` (split pair). */
  const b = mkMediaClip({
    id: 'b',
    assetId: 'X',
    startUs: 2 * SEC,
    durationUs: 3 * SEC,
    sourceInUs: 2 * SEC,
    sourceOutUs: 5 * SEC,
  });
  /** Hard cut from a different asset at the same edge. */
  const other = mkMediaClip({
    id: 'o',
    assetId: 'Y',
    startUs: 2 * SEC,
    durationUs: 3 * SEC,
  });

  it('tolerance is one project frame + the 5 ms micro-fade margin', () => {
    expect(spliceEdgeToleranceUs(FRAME_US)).toBe(Math.round(FRAME_US) + MICRO_FADE_US);
    expect(spliceEdgeToleranceUs(0)).toBe(MICRO_FADE_US);
  });

  it('seamless splice: no fade-in even when the tick lands a FRAME into the clip', () => {
    // Envelope scheduling runs on the tick after the cut — at 30 fps that is
    // ~33 ms into the clip, far beyond the bare 5 ms MICRO_FADE_US. The old
    // `startClipUs <= MICRO_FADE_US` decision wrongly micro-faded here.
    expect(shouldMicroFadeIn(a, b, Math.round(FRAME_US), FRAME_US)).toBe(false);
    expect(shouldMicroFadeIn(a, b, Math.round(FRAME_US) + MICRO_FADE_US, FRAME_US)).toBe(false);
    expect(shouldMicroFadeIn(a, b, 0, FRAME_US)).toBe(false);
  });

  it('beyond the tolerance it is a mid-clip resume: fade-in even on a splice', () => {
    const beyond = Math.round(FRAME_US) + MICRO_FADE_US + 1;
    expect(shouldMicroFadeIn(a, b, beyond, FRAME_US)).toBe(true);
  });

  it('non-seamless neighbor (different asset) always micro-fades in at the edge', () => {
    expect(shouldMicroFadeIn(other, b, 0, FRAME_US)).toBe(true);
    expect(shouldMicroFadeIn(null, b, 0, FRAME_US)).toBe(true);
  });

  it('fade-out: suppressed only towards a seamless next clip', () => {
    expect(shouldMicroFadeOut(a, b)).toBe(false); // a -> b is seamless
    expect(shouldMicroFadeOut(a, other)).toBe(true);
    expect(shouldMicroFadeOut(a, null)).toBe(true);
  });
});
