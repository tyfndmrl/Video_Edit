/**
 * Clip-at-time resolver tests: activation windows, source-time mapping
 * (sourceIn + round((t-start)*rate), rendering-semantics §1), visual stacking
 * order (tracks[0] = top -> drawn last) and audio eligibility rules.
 */
import { describe, expect, it } from 'vitest';
import {
  clipAtTime,
  clipAudioOf,
  clipEndUs,
  colorAdjustOf,
  DEFAULT_CLIP_AUDIO,
  effectiveOpacity,
  effectiveTransform,
  isClipActiveAt,
  isClipMuted,
  nextClipAfter,
  projectDurationUs,
  resolveAudible,
  resolveVisualStack,
  sourceTimeUs,
} from './resolve';
import { mkDoc, mkMediaClip, mkTrack } from './testFixtures';

const SEC = 1_000_000;

describe('activation window (end-exclusive)', () => {
  const clip = mkMediaClip({ id: 'a', startUs: 2 * SEC, durationUs: 3 * SEC });

  it('is active on [start, end)', () => {
    expect(isClipActiveAt(clip, 2 * SEC)).toBe(true);
    expect(isClipActiveAt(clip, 4_999_999)).toBe(true);
    expect(isClipActiveAt(clip, 5 * SEC)).toBe(false); // end instant belongs to the NEXT clip
    expect(isClipActiveAt(clip, 1_999_999)).toBe(false);
  });

  it('clipEndUs = start + duration', () => {
    expect(clipEndUs(clip)).toBe(5 * SEC);
  });

  it('clipAtTime finds the right clip among several; gaps yield null', () => {
    const b = mkMediaClip({ id: 'b', startUs: 6 * SEC, durationUs: 2 * SEC });
    const track = mkTrack('t', [clip, b]);
    expect(clipAtTime(track, 3 * SEC)?.id).toBe('a');
    expect(clipAtTime(track, 5_500_000)).toBeNull(); // gap between a and b
    expect(clipAtTime(track, 6 * SEC)?.id).toBe('b');
    expect(clipAtTime(track, 9 * SEC)).toBeNull();
  });

  it('nextClipAfter returns the first clip starting strictly later', () => {
    const b = mkMediaClip({ id: 'b', startUs: 6 * SEC, durationUs: 2 * SEC });
    const track = mkTrack('t', [clip, b]);
    expect(nextClipAfter(track, 3 * SEC)?.id).toBe('b');
    expect(nextClipAfter(track, 6 * SEC)).toBeNull(); // b started AT 6s, not after
  });
});

describe('sourceTimeUs (sourceIn + roundHalfUp((t-start)*rate))', () => {
  it('rate 1: source advances 1:1 from sourceIn', () => {
    const clip = mkMediaClip({
      id: 'a',
      startUs: 10 * SEC,
      durationUs: 4 * SEC,
      sourceInUs: 2 * SEC,
      sourceOutUs: 6 * SEC,
    });
    expect(sourceTimeUs(clip, 10 * SEC)).toBe(2 * SEC);
    expect(sourceTimeUs(clip, 11 * SEC)).toBe(3 * SEC);
    expect(sourceTimeUs(clip, 13_500_000)).toBe(5_500_000);
  });

  it('rate 2: one timeline second consumes two source seconds', () => {
    const clip = mkMediaClip({
      id: 'a',
      startUs: 0,
      durationUs: 2 * SEC,
      sourceInUs: 1 * SEC,
      sourceOutUs: 5 * SEC,
      rate: 2,
    });
    expect(sourceTimeUs(clip, 0)).toBe(1 * SEC);
    expect(sourceTimeUs(clip, 1 * SEC)).toBe(3 * SEC);
    expect(sourceTimeUs(clip, 2 * SEC)).toBe(5 * SEC);
  });

  it('half-up rounding of the (t-start)*rate product', () => {
    // rate 0.333: (t-start)=1 -> 0.333 -> rounds to 0; (t-start)=2 -> 0.666 -> 1
    const clip = mkMediaClip({
      id: 'a',
      startUs: 0,
      durationUs: 3 * SEC,
      sourceInUs: 0,
      sourceOutUs: 1 * SEC,
      rate: 0.333,
    });
    expect(sourceTimeUs(clip, 1)).toBe(0);
    expect(sourceTimeUs(clip, 2)).toBe(1);
    // exact half: 1.5 -> floor(1.5+0.5) = 2
    const half = mkMediaClip({
      id: 'h',
      startUs: 0,
      durationUs: 2 * SEC,
      sourceInUs: 0,
      sourceOutUs: 1 * SEC,
      rate: 0.5,
    });
    expect(sourceTimeUs(half, 3)).toBe(2); // 3*0.5 = 1.5 -> 2 (half-up)
  });

  it('clamps into [sourceIn, sourceOut]', () => {
    const clip = mkMediaClip({
      id: 'a',
      startUs: 0,
      durationUs: 2 * SEC,
      sourceInUs: 1 * SEC,
      sourceOutUs: 3 * SEC,
    });
    expect(sourceTimeUs(clip, -1 * SEC)).toBe(1 * SEC);
    expect(sourceTimeUs(clip, 10 * SEC)).toBe(3 * SEC);
  });
});

describe('resolveVisualStack (bottom track first; tracks[0] = TOP layer)', () => {
  it('returns bottom-first so the top layer is drawn last', () => {
    const top = mkMediaClip({ id: 'top', startUs: 0, durationUs: SEC });
    const bottom = mkMediaClip({ id: 'bottom', startUs: 0, durationUs: SEC });
    const doc = mkDoc([mkTrack('t0', [top]), mkTrack('t1', [bottom])]);
    const stack = resolveVisualStack(doc, 0);
    expect(stack.map((s) => s.clip.id)).toEqual(['bottom', 'top']);
    expect(stack.map((s) => s.trackIndex)).toEqual([1, 0]);
  });

  it('skips hidden tracks and audio-kind clips', () => {
    const hidden = mkMediaClip({ id: 'hidden', startUs: 0, durationUs: SEC });
    const audio = mkMediaClip({ id: 'aud', startUs: 0, durationUs: SEC, kind: 'audio' });
    const visible = mkMediaClip({ id: 'vis', startUs: 0, durationUs: SEC });
    const doc = mkDoc([
      mkTrack('t0', [hidden], { hidden: true }),
      mkTrack('t1', [audio], { type: 'audio' }),
      mkTrack('t2', [visible]),
    ]);
    expect(resolveVisualStack(doc, 0).map((s) => s.clip.id)).toEqual(['vis']);
  });

  it('empty timeline -> empty stack (black canvas)', () => {
    expect(resolveVisualStack(mkDoc([]), 0)).toEqual([]);
  });
});

describe('audio eligibility', () => {
  it('clipAudioOf: video detached -> null, audio kind falls back to defaults, image -> null', () => {
    const detached = mkMediaClip({ id: 'v', startUs: 0, durationUs: SEC, audio: null });
    expect(clipAudioOf(detached)).toBeNull();
    const audioClip = mkMediaClip({ id: 'a', startUs: 0, durationUs: SEC, kind: 'audio', audio: null });
    expect(clipAudioOf(audioClip)).toEqual(DEFAULT_CLIP_AUDIO);
    const image = mkMediaClip({ id: 'i', startUs: 0, durationUs: SEC, kind: 'image', audio: null });
    expect(clipAudioOf(image)).toBeNull();
  });

  it('resolveAudible excludes detached/image clips, keeps muted ones (gain handles mute)', () => {
    const withAudio = mkMediaClip({ id: 'v1', startUs: 0, durationUs: SEC });
    const detached = mkMediaClip({ id: 'v2', startUs: 0, durationUs: SEC, audio: null });
    const image = mkMediaClip({ id: 'img', startUs: 0, durationUs: SEC, kind: 'image', audio: null });
    const muted = mkMediaClip({
      id: 'v3',
      startUs: 0,
      durationUs: SEC,
      audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: true },
    });
    const doc = mkDoc([
      mkTrack('t0', [withAudio]),
      mkTrack('t1', [detached]),
      mkTrack('t2', [image]),
      mkTrack('t3', [muted]),
    ]);
    expect(resolveAudible(doc, 0).map((s) => s.clip.id)).toEqual(['v1', 'v3']);
  });

  it('audible clips on a HIDDEN track still count (hidden = visual only)', () => {
    const clip = mkMediaClip({ id: 'v', startUs: 0, durationUs: SEC });
    const doc = mkDoc([mkTrack('t0', [clip], { hidden: true })]);
    expect(resolveAudible(doc, 0).map((s) => s.clip.id)).toEqual(['v']);
  });

  it('isClipMuted honors track.muted, clip audio muted and detached audio', () => {
    const clip = mkMediaClip({ id: 'v', startUs: 0, durationUs: SEC });
    expect(isClipMuted(mkTrack('t', [clip], { muted: true }), clip)).toBe(true);
    expect(isClipMuted(mkTrack('t', [clip]), clip)).toBe(false);
    const muted = mkMediaClip({
      id: 'm',
      startUs: 0,
      durationUs: SEC,
      audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: true },
    });
    expect(isClipMuted(mkTrack('t', [muted]), muted)).toBe(true);
    const detached = mkMediaClip({ id: 'd', startUs: 0, durationUs: SEC, audio: null });
    expect(isClipMuted(mkTrack('t', [detached]), detached)).toBe(true);
  });
});

describe('projectDurationUs', () => {
  it('is the max clip end across tracks; empty doc -> 0', () => {
    const doc = mkDoc([
      mkTrack('t0', [mkMediaClip({ id: 'a', startUs: 0, durationUs: 3 * SEC })]),
      mkTrack('t1', [mkMediaClip({ id: 'b', startUs: 5 * SEC, durationUs: 2 * SEC })]),
    ]);
    expect(projectDurationUs(doc)).toBe(7 * SEC);
    expect(projectDurationUs(mkDoc([]))).toBe(0);
  });
});

describe('keyframe-effective properties', () => {
  it('effectiveTransform samples x keyframes linearly at clip-local time', () => {
    const clip = mkMediaClip({ id: 'a', startUs: 2 * SEC, durationUs: 2 * SEC });
    clip.keyframes = {
      x: [
        { timeUs: 0, value: -0.5, easing: { type: 'linear' } },
        { timeUs: 2 * SEC, value: 0.5, easing: { type: 'linear' } },
      ],
    };
    // t = start + 1s -> local 1s -> midpoint -> x = 0
    expect(effectiveTransform(clip, 3 * SEC).x).toBeCloseTo(0, 9);
    // base values untouched for non-keyframed props
    expect(effectiveTransform(clip, 3 * SEC).scale).toBe(1);
    // before/after: clamped to first/last keyframe value
    expect(effectiveTransform(clip, 2 * SEC).x).toBe(-0.5);
    expect(effectiveTransform(clip, 4 * SEC).x).toBe(0.5);
  });

  it('effectiveOpacity samples keyframes and clamps to [0,1]', () => {
    const clip = mkMediaClip({ id: 'a', startUs: 0, durationUs: 2 * SEC, opacity: 0.8 });
    expect(effectiveOpacity(clip, SEC)).toBe(0.8); // no keyframes -> base
    clip.keyframes = {
      opacity: [
        { timeUs: 0, value: 0, easing: { type: 'linear' } },
        { timeUs: 2 * SEC, value: 1, easing: { type: 'linear' } },
      ],
    };
    expect(effectiveOpacity(clip, SEC)).toBeCloseTo(0.5, 9);
  });
});

describe('colorAdjustOf', () => {
  it('extracts the first ENABLED colorAdjust with 0 defaults; ignores lut/disabled', () => {
    const clip = mkMediaClip({ id: 'a', startUs: 0, durationUs: SEC });
    clip.effects = [
      { id: 'e0', type: 'lut', enabled: true, params: { intensity: 1 } },
      { id: 'e1', type: 'colorAdjust', enabled: false, params: { brightness: 0.9 } },
      { id: 'e2', type: 'colorAdjust', enabled: true, params: { exposure: 0.3, saturation: -0.2 } },
    ];
    expect(colorAdjustOf(clip)).toEqual({
      exposure: 0.3,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 0,
      saturation: -0.2,
    });
  });

  it('returns null when no enabled colorAdjust exists', () => {
    const clip = mkMediaClip({ id: 'a', startUs: 0, durationUs: SEC });
    expect(colorAdjustOf(clip)).toBeNull();
  });
});
