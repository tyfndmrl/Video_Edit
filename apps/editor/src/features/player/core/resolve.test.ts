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
  sourceTimeUsInWindow,
  transitionAtPlayhead,
  transitionHandleUs,
  transitionWindowAt,
} from './resolve';
import { linkTransition, mkDoc, mkMediaClip, mkTrack } from './testFixtures';

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

// ---------------------------------------------------------------------------
// Transitions (rendering-semantics §5.3) — the preview half
// ---------------------------------------------------------------------------

/**
 * Two adjacent 6 s clips cut at 6 s with a 1 s crossfade, i.e. the window is
 * [5.5 s, 6.5 s). clipB carries a source handle (sourceIn = 1 s) so the doc is
 * the same shape the editor writes (§5.5 handle rule).
 */
function transitionFixture(durationUs = SEC) {
  const a = mkMediaClip({ id: 'a', startUs: 0, durationUs: 6 * SEC });
  const b = mkMediaClip({
    id: 'b',
    startUs: 6 * SEC,
    durationUs: 6 * SEC,
    sourceInUs: 1 * SEC,
    sourceOutUs: 7 * SEC,
  });
  linkTransition(a, b, durationUs);
  return { a, b, track: mkTrack('t0', [a, b]), doc: mkDoc([mkTrack('t0', [a, b])]) };
}

describe('transitionWindowAt (§5.3 window [T-D/2, T+D/2), p linear)', () => {
  it('opens D/2 BEFORE the cut and closes D/2 after it', () => {
    const { track } = transitionFixture();
    expect(transitionWindowAt(track, 5_499_999), 'before the window: hard cut').toBeNull();
    expect(transitionWindowAt(track, 5_500_000), 'window opens at T - D/2').not.toBeNull();
    expect(transitionWindowAt(track, 6_499_999)).not.toBeNull();
    expect(transitionWindowAt(track, 6_500_000), 'end-exclusive, like clips').toBeNull();
  });

  it('p is 0 at the opening edge, 0.5 exactly AT the cut, ->1 at the closing edge', () => {
    const { track } = transitionFixture();
    expect(transitionWindowAt(track, 5_500_000)!.p).toBeCloseTo(0, 9);
    expect(transitionWindowAt(track, 6 * SEC)!.p, 'the cut is the halfway point').toBeCloseTo(
      0.5,
      9,
    );
    expect(transitionWindowAt(track, 6_499_999)!.p).toBeCloseTo(0.999999, 6);
  });

  it('names the OUTGOING clip as from and the INCOMING one as to, on both sides of T', () => {
    const { track } = transitionFixture();
    // Before the cut the playhead is over A (found via A.transitionOut)...
    const before = transitionWindowAt(track, 5_600_000)!;
    // ...after it, over B (found via B.transitionIn). Same pair either way.
    const after = transitionWindowAt(track, 6_400_000)!;
    expect([before.from.id, before.to.id]).toEqual(['a', 'b']);
    expect([after.from.id, after.to.id]).toEqual(['a', 'b']);
    expect(before.cutUs).toBe(6 * SEC);
    expect(after.cutUs).toBe(6 * SEC);
  });

  it('a gap between the clips is NOT a cut, so no window opens', () => {
    const a = mkMediaClip({ id: 'a', startUs: 0, durationUs: 6 * SEC });
    const b = mkMediaClip({ id: 'b', startUs: 7 * SEC, durationUs: 6 * SEC });
    linkTransition(a, b, SEC); // stale metadata after a move: must not blend
    expect(transitionWindowAt(mkTrack('t', [a, b]), 6 * SEC)).toBeNull();
  });

  it('no transition metadata -> null everywhere around the cut', () => {
    const a = mkMediaClip({ id: 'a', startUs: 0, durationUs: 6 * SEC });
    const b = mkMediaClip({ id: 'b', startUs: 6 * SEC, durationUs: 6 * SEC });
    const track = mkTrack('t', [a, b]);
    for (const t of [5_500_000, 6 * SEC, 6_400_000]) {
      expect(transitionWindowAt(track, t)).toBeNull();
    }
  });
});

describe('resolveVisualStack inside a transition window', () => {
  it('returns BOTH clips (outgoing first) — the bug that made the preview a hard cut', () => {
    const { doc } = transitionFixture();
    const stack = resolveVisualStack(doc, 6 * SEC);
    expect(stack.map((s) => s.clip.id)).toEqual(['a', 'b']);
    expect(stack.map((s) => s.transition?.role)).toEqual(['from', 'to']);
    expect(stack[0]!.transition!.p).toBeCloseTo(0.5, 9);
    expect(stack[0]!.transition!.partnerClipId).toBe('b');
    expect(stack[1]!.transition!.partnerClipId).toBe('a');
    // Both entries belong to the SAME track (the compositor pairs them by that).
    expect(stack.map((s) => s.trackIndex)).toEqual([0, 0]);
  });

  it('outside the window it is one clip and no transition marker (negative control)', () => {
    const { doc } = transitionFixture();
    const before = resolveVisualStack(doc, 5_000_000);
    expect(before.map((s) => s.clip.id)).toEqual(['a']);
    expect(before[0]!.transition).toBeUndefined();
    const after = resolveVisualStack(doc, 7 * SEC);
    expect(after.map((s) => s.clip.id)).toEqual(['b']);
    expect(after[0]!.transition).toBeUndefined();
  });

  it('a hidden track contributes neither side (hiding still frees the decoder)', () => {
    const { a, b } = transitionFixture();
    const doc = mkDoc([mkTrack('t0', [a, b], { hidden: true })]);
    expect(resolveVisualStack(doc, 6 * SEC)).toEqual([]);
  });

  it('audio-kind clips never enter the VISUAL stack, transition or not', () => {
    const a = mkMediaClip({ id: 'a', startUs: 0, durationUs: 6 * SEC, kind: 'audio' });
    const b = mkMediaClip({
      id: 'b',
      startUs: 6 * SEC,
      durationUs: 6 * SEC,
      kind: 'audio',
      sourceInUs: SEC,
      sourceOutUs: 7 * SEC,
    });
    linkTransition(a, b, SEC);
    const doc = mkDoc([mkTrack('t0', [a, b], { type: 'audio' })]);
    expect(resolveVisualStack(doc, 6 * SEC)).toEqual([]);
    // ...but they ARE both audible (§5.4 acrossfade).
    expect(resolveAudible(doc, 6 * SEC).map((s) => s.clip.id)).toEqual(['a', 'b']);
  });
});

describe('transition source time (§5.3 handle material)', () => {
  it('transitionHandleUs mirrors the schema invariant: roundHalfUp((D/2)*rate)', () => {
    expect(transitionHandleUs(1_000_000, 1)).toBe(500_000);
    expect(transitionHandleUs(1_000_000, 2)).toBe(1_000_000);
    expect(transitionHandleUs(999_999, 1)).toBe(500_000); // .5 rounds half UP
  });

  it('the outgoing clip keeps ADVANCING past sourceOut instead of freezing', () => {
    const { a } = transitionFixture();
    const handle = transitionHandleUs(SEC, 1);
    // t = 6.4 s is 0.4 s past A's end: plain sourceTimeUs clamps, the window
    // version reads 0.4 s of handle material.
    expect(sourceTimeUs(a, 6_400_000)).toBe(6 * SEC);
    expect(sourceTimeUsInWindow(a, 6_400_000, handle)).toBe(6_400_000);
    // ...but never further than one handle (that is all the export extends by).
    expect(sourceTimeUsInWindow(a, 9 * SEC, handle)).toBe(6 * SEC + handle);
  });

  it('the incoming clip reads BEFORE sourceIn, never below 0', () => {
    const { b } = transitionFixture();
    const handle = transitionHandleUs(SEC, 1);
    expect(sourceTimeUs(b, 5_600_000)).toBe(1 * SEC); // clamped to sourceIn
    expect(sourceTimeUsInWindow(b, 5_600_000, handle)).toBe(600_000);
    const noHandle = mkMediaClip({ id: 'n', startUs: 6 * SEC, durationUs: SEC, sourceInUs: 0 });
    expect(sourceTimeUsInWindow(noHandle, 5_000_000, handle)).toBe(0);
  });
});

describe('transitionAtPlayhead (the player badge)', () => {
  it('finds the window on any visible track, top track first', () => {
    const { a, b } = transitionFixture();
    const other = mkMediaClip({ id: 'x', startUs: 0, durationUs: 20 * SEC });
    const doc = mkDoc([mkTrack('top', [other]), mkTrack('bottom', [a, b])]);
    expect(transitionAtPlayhead(doc, 6 * SEC)?.from.id).toBe('a');
    expect(transitionAtPlayhead(doc, 3 * SEC)).toBeNull();
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
