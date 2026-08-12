import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_LAYER_DIMENSION,
  TRANSFORM_SCALE_DECIMALS,
  TRANSFORM_SCALE_MIN,
  exportFrameGridIssues,
  maxScaleFor,
  validateTimelineDoc,
} from '../src/index.js';
import type { Effect, MediaClip, TextClip, TimelineDoc, Track, Transform } from '../src/schema.js';

// Deterministic UUIDv7-shaped ids for fixtures.
const uid = (n: number): string => `01890000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const ASSET_A = uid(101);
const ASSET_B = uid(102);

const defaultTransform = (): Transform => ({
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
});

let nextId = 1000;

function mediaClip(partial: Partial<MediaClip> & Pick<MediaClip, 'timelineStartUs' | 'timelineDurationUs'>): MediaClip {
  const duration = partial.timelineDurationUs;
  return {
    id: uid(nextId++),
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: partial.timelineStartUs,
    timelineDurationUs: duration,
    sourceInUs: 0,
    sourceOutUs: duration, // rate 1 -> duration formula holds by construction
    speed: { rate: 1 },
    audio: null,
    transform: defaultTransform(),
    keyframes: {},
    effects: [],
    opacity: 1,
    ...partial,
  };
}

function textClip(timelineStartUs: number, timelineDurationUs: number): TextClip {
  return {
    id: uid(nextId++),
    kind: 'text',
    timelineStartUs,
    timelineDurationUs,
    transform: defaultTransform(),
    keyframes: {},
    effects: [],
    opacity: 1,
    text: {
      content: 'Hello',
      fontId: 'inter-v1',
      fontSizePx: 48,
      fontWeight: 700,
      italic: false,
      fill: '#ffffff',
      align: 'center',
      lineHeight: 1.2,
    },
  };
}

function videoTrack(clips: MediaClip[]): Track {
  return { id: uid(nextId++), type: 'video', muted: false, hidden: false, locked: false, clips };
}

/**
 * Valid baseline: two adjacent 2s clips with a 1s crossfade on the cut
 * (B.sourceIn = 500000 = D/2 handle), plus an overlay text clip and a marker.
 */
function validDoc(): TimelineDoc {
  const clipA = mediaClip({
    timelineStartUs: 0,
    timelineDurationUs: 2_000_000,
    assetId: ASSET_A,
    transitionOut: { type: 'crossfade', durationUs: 1_000_000 },
    keyframes: {
      opacity: [
        { timeUs: 0, value: 0, easing: { type: 'easeInOut' } },
        { timeUs: 500_000, value: 1, easing: { type: 'linear' } },
      ],
    },
    effects: [
      {
        id: uid(900),
        type: 'colorAdjust',
        enabled: true,
        params: { brightness: 0.1, contrast: 0, saturation: 0.2, temperature: 0, tint: 0, exposure: 0 },
      },
    ],
  });
  const clipB = mediaClip({
    timelineStartUs: 2_000_000,
    timelineDurationUs: 2_000_000,
    assetId: ASSET_B,
    sourceInUs: 500_000,
    sourceOutUs: 2_500_000,
    transitionIn: { type: 'crossfade', durationUs: 1_000_000 },
  });
  return {
    schemaVersion: 1,
    projectId: uid(1),
    settings: {
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      backgroundColor: '#000000',
    },
    tracks: [
      { id: uid(2), type: 'overlay', muted: false, hidden: false, locked: false, clips: [textClip(0, 1_000_000)] },
      videoTrack([clipA, clipB]),
    ],
    markers: [{ id: uid(3), timeUs: 1_000_000, label: 'intro', color: '#ff8800' }],
  };
}

const DURATIONS = { [ASSET_A]: 10_000_000, [ASSET_B]: 10_000_000 };

function expectIssue(doc: unknown, messagePart: string, assetDurations?: Record<string, number>): void {
  const result = validateTimelineDoc(doc, assetDurations);
  expect(result.success).toBe(false);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('\n');
    expect(messages).toContain(messagePart);
  }
}

describe('valid documents', () => {
  it('accepts the baseline document (no asset durations)', () => {
    const result = validateTimelineDoc(validDoc());
    expect(result.success).toBe(true);
  });

  it('accepts the baseline document with asset durations (handles are sufficient)', () => {
    const result = validateTimelineDoc(validDoc(), DURATIONS);
    expect(result.success).toBe(true);
  });
});

describe('clip ordering and overlap', () => {
  it('rejects overlapping clips', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[1] as MediaClip).timelineStartUs = 1_500_000;
    expectIssue(doc, 'must not overlap');
  });

  it('rejects unsorted clips', () => {
    const doc = validDoc();
    doc.tracks[1].clips.reverse();
    expectIssue(doc, 'sorted by timelineStartUs');
  });
});

describe('source range and duration formula', () => {
  it('rejects sourceOutUs <= sourceInUs', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.sourceInUs = 2_000_000; // == sourceOutUs
    expectIssue(doc, 'must be greater than sourceInUs');
  });

  it('rejects timelineDurationUs that violates round((out-in)/rate)', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.speed = { rate: 2 }; // expected duration becomes 1_000_000, stored stays 2_000_000
    expectIssue(doc, 'round((sourceOutUs - sourceInUs) / speed.rate)');
  });

  it('accepts the half-up rounded duration for fractional rates', () => {
    const doc = validDoc();
    const track = doc.tracks[1];
    const solo = mediaClip({
      timelineStartUs: 0,
      timelineDurationUs: 666_667, // round(1_000_000 / 1.5)
      sourceInUs: 0,
      sourceOutUs: 1_000_000,
      speed: { rate: 1.5 },
    });
    track.clips = [solo];
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('rejects sourceOutUs beyond the known asset duration', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.sourceOutUs = 11_000_000;
    clip.timelineDurationUs = 11_000_000;
    clip.transitionOut = undefined;
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = undefined;
    (doc.tracks[1].clips[1] as MediaClip).timelineStartUs = 11_000_000;
    expectIssue(doc, 'exceeds asset duration', DURATIONS);
  });
});

describe('keyframes', () => {
  it('rejects keyframes outside [0, timelineDurationUs]', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.keyframes = {
      opacity: [{ timeUs: 2_000_001, value: 1, easing: { type: 'linear' } }],
    };
    expectIssue(doc, 'outside [0, 2000000]');
  });

  it('rejects unsorted keyframes', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.keyframes = {
      x: [
        { timeUs: 500_000, value: 0, easing: { type: 'linear' } },
        { timeUs: 100_000, value: 1, easing: { type: 'linear' } },
      ],
    };
    expectIssue(doc, 'strictly sorted');
  });

  it('rejects duplicate keyframe times', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.keyframes = {
      scale: [
        { timeUs: 100_000, value: 1, easing: { type: 'linear' } },
        { timeUs: 100_000, value: 2, easing: { type: 'linear' } },
      ],
    };
    expectIssue(doc, 'strictly sorted');
  });

  it('rejects fx.* keyframe keys (effect params are not keyframable in MVP)', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    (clip.keyframes as Record<string, unknown>)['fx.abc.brightness'] = [
      { timeUs: 0, value: 0, easing: { type: 'linear' } },
    ];
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(false); // strictObject rejects unknown keys
  });
});

describe('transitions', () => {
  it('rejects a transition longer than half of the shorter neighbor', () => {
    const doc = validDoc();
    const clipA = doc.tracks[1].clips[0] as MediaClip;
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipA.transitionOut = { type: 'crossfade', durationUs: 1_100_000 }; // 2.2s > 2s
    clipB.transitionIn = undefined;
    expectIssue(doc, 'exceeds half of the shorter neighboring clip');
  });

  it('rejects a transition on a non-adjacent edge (gap)', () => {
    const doc = validDoc();
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipB.timelineStartUs = 2_500_000; // gap of 0.5s
    expectIssue(doc, 'requires an adjacent');
  });

  it('rejects a transitionIn with no preceding clip', () => {
    const doc = validDoc();
    const track = doc.tracks[1];
    const solo = mediaClip({
      timelineStartUs: 0,
      timelineDurationUs: 2_000_000,
      transitionIn: { type: 'dissolve', durationUs: 200_000 },
    });
    track.clips = [solo];
    expectIssue(doc, 'requires an adjacent preceding media clip');
  });

  it('rejects a missing incoming handle (sourceInUs < D/2) when asset durations are known', () => {
    const doc = validDoc();
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipB.sourceInUs = 0;
    clipB.sourceOutUs = 2_000_000;
    expectIssue(doc, 'incoming clip needs sourceInUs >= 500000', DURATIONS);
  });

  it('rejects a missing outgoing handle (sourceOutUs + D/2 > asset duration)', () => {
    const doc = validDoc();
    // Asset A is exactly as long as clip A's sourceOut -> no D/2 slack after the cut.
    expectIssue(doc, 'outgoing clip needs sourceOutUs', { [ASSET_A]: 2_000_000, [ASSET_B]: 10_000_000 });
  });

  /**
   * The HEAD handle is bounded by sourceInUs alone — no asset duration needed —
   * and the export compiler enforces it unconditionally
   * (`if (!next.IsStillInput && next.SourceInUs < halfSourceUs)` → 422). A
   * validator that skipped it without durations would green-light a document
   * the renderer rejects.
   */
  it('checks the incoming handle even when asset durations are NOT provided', () => {
    const doc = validDoc();
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipB.sourceInUs = 0;
    clipB.sourceOutUs = 2_000_000;
    expectIssue(doc, 'incoming clip needs sourceInUs >= 500000');
    expectIssue(doc, 'incoming clip needs sourceInUs >= 500000', DURATIONS);
  });

  /** The TAIL handle genuinely needs the asset duration; without it, no check. */
  it('skips the outgoing (tail) handle rule when asset durations are not provided', () => {
    const doc = validDoc();
    expect(validateTimelineDoc(doc).success).toBe(true);
    expect(
      validateTimelineDoc(doc, { [ASSET_A]: 2_000_000, [ASSET_B]: 10_000_000 }).success,
    ).toBe(false);
  });

  it('accepts a Map as the asset duration source', () => {
    const map = new Map<string, number>([
      [ASSET_A, 10_000_000],
      [ASSET_B, 10_000_000],
    ]);
    expect(validateTimelineDoc(validDoc(), map).success).toBe(true);
  });
});

describe('transition handles are speed-aware (rendering-semantics §5.2)', () => {
  /** Cut at 2s with a 1s crossfade; incoming clip B runs at the given rate. */
  function docWithIncomingRate(rate: number, sourceInUs: number): TimelineDoc {
    const doc = validDoc();
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipB.speed = { rate };
    clipB.sourceInUs = sourceInUs;
    // Keep the duration formula intact: span = round(duration * rate).
    clipB.sourceOutUs = sourceInUs + Math.round(clipB.timelineDurationUs * rate);
    return doc;
  }

  it('rejects an incoming handle short of roundHalfUp((D/2)*rate) at rate 2.0', () => {
    // D/2 = 500000, rate 2.0 -> required sourceInUs >= 1000000. 999999 would
    // pass the old rate-blind formula (>= 500000) but violates the contract.
    expectIssue(docWithIncomingRate(2.0, 999_999), 'incoming clip needs sourceInUs >= 1000000', DURATIONS);
  });

  it('accepts an incoming handle of exactly roundHalfUp((D/2)*rate) at rate 2.0', () => {
    expect(validateTimelineDoc(docWithIncomingRate(2.0, 1_000_000), DURATIONS).success).toBe(true);
  });

  /** Outgoing clip A runs at rate 0.5; D/2 = 500000 -> handle = 250000 in source domain. */
  function docWithOutgoingHalfRate(): TimelineDoc {
    const doc = validDoc();
    const clipA = doc.tracks[1].clips[0] as MediaClip;
    clipA.speed = { rate: 0.5 };
    clipA.sourceInUs = 0;
    clipA.sourceOutUs = 1_000_000; // round(1_000_000 / 0.5) = 2_000_000 = timelineDurationUs
    return doc;
  }

  it('accepts an outgoing handle of exactly roundHalfUp((D/2)*rate) at rate 0.5', () => {
    // Asset ends exactly 250000us after sourceOut; the old rate-blind formula
    // (500000) would reject this document, the normative formula accepts it.
    const durations = { [ASSET_A]: 1_250_000, [ASSET_B]: 10_000_000 };
    expect(validateTimelineDoc(docWithOutgoingHalfRate(), durations).success).toBe(true);
  });

  it('rejects an outgoing handle short of roundHalfUp((D/2)*rate) at rate 0.5', () => {
    const durations = { [ASSET_A]: 1_249_999, [ASSET_B]: 10_000_000 };
    expectIssue(docWithOutgoingHalfRate(), 'outgoing clip needs sourceOutUs + 250000', durations);
  });
});

/**
 * A still image has no source time axis, so it has no D/2 handle to run out of:
 * the export compiler opens it with `-loop 1` and skips exactly these checks
 * (`ExportClipPlan.IsStillInput`, `!next.IsStillInput && ...`). Applying the
 * handle rule to images made the single most common transition — a crossfade
 * between two photographs — impossible to express, while the renderer accepts
 * it. These tests pin the three layers (invariants / editor ops / compiler) to
 * the same reading.
 */
describe('transition handles skip sources with no time axis (image clips)', () => {
  const IMG_A = uid(201);
  const IMG_B = uid(202);

  /** Two adjacent 4s image clips (sourceIn 0, sourceOut 4s) with a 1s crossfade. */
  function slideshowDoc(): TimelineDoc {
    const doc = validDoc();
    doc.tracks[1].clips = [
      mediaClip({
        kind: 'image',
        assetId: IMG_A,
        timelineStartUs: 0,
        timelineDurationUs: 4_000_000,
        sourceInUs: 0,
        sourceOutUs: 4_000_000,
        transitionOut: { type: 'crossfade', durationUs: 1_000_000 },
      }),
      mediaClip({
        kind: 'image',
        assetId: IMG_B,
        timelineStartUs: 4_000_000,
        timelineDurationUs: 4_000_000,
        sourceInUs: 0,
        sourceOutUs: 4_000_000,
        transitionIn: { type: 'crossfade', durationUs: 1_000_000 },
      }),
    ];
    return doc;
  }

  it('accepts a crossfade between two photographs (sourceIn = 0 on both sides)', () => {
    expect(validateTimelineDoc(slideshowDoc()).success).toBe(true);
    // Even with the image "durations" known and exactly equal to sourceOut —
    // there is no tail to reserve either.
    expect(
      validateTimelineDoc(slideshowDoc(), { [IMG_A]: 4_000_000, [IMG_B]: 4_000_000 }).success,
    ).toBe(true);
  });

  it('still enforces the length cap on an image cut (D*2 <= shorter neighbor)', () => {
    const doc = slideshowDoc();
    const [a, b] = doc.tracks[1].clips as MediaClip[];
    a.transitionOut = { type: 'crossfade', durationUs: 2_100_000 };
    b.transitionIn = { type: 'crossfade', durationUs: 2_100_000 };
    expectIssue(doc, 'exceeds half of the shorter neighboring clip');
  });

  it('checks ONLY the video side on a mixed image|video cut (video is incoming)', () => {
    const doc = slideshowDoc();
    const clips = doc.tracks[1].clips as MediaClip[];
    // B becomes a VIDEO with no head handle -> that side must fail.
    clips[1].kind = 'video';
    clips[1].assetId = ASSET_B;
    expectIssue(doc, 'incoming clip needs sourceInUs >= 500000');
    // Give the video its handle: the image side (sourceOut == asset end) must
    // NOT be asked for a tail.
    clips[1].sourceInUs = 500_000;
    clips[1].sourceOutUs = 4_500_000;
    expect(validateTimelineDoc(doc, { [IMG_A]: 4_000_000, [ASSET_B]: 10_000_000 }).success).toBe(
      true,
    );
  });

  it('checks ONLY the video side on a mixed video|image cut (video is outgoing)', () => {
    const doc = slideshowDoc();
    const clips = doc.tracks[1].clips as MediaClip[];
    // A becomes a VIDEO sitting exactly at the end of its asset -> no tail.
    clips[0].kind = 'video';
    clips[0].assetId = ASSET_A;
    clips[0].sourceInUs = 0;
    clips[0].sourceOutUs = 4_000_000;
    expectIssue(doc, 'outgoing clip needs sourceOutUs', {
      [ASSET_A]: 4_000_000,
      [IMG_B]: 4_000_000,
    });
    // With tail slack the cut is legal although the incoming IMAGE has sourceIn 0.
    expect(
      validateTimelineDoc(doc, { [ASSET_A]: 10_000_000, [IMG_B]: 4_000_000 }).success,
    ).toBe(true);
  });
});

describe('transition duration even-frame grid snap (rendering-semantics §5.2)', () => {
  function docWithTransitionDuration(durationUs: number): TimelineDoc {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transitionOut = { type: 'crossfade', durationUs };
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = { type: 'crossfade', durationUs };
    return doc;
  }

  it('accepts an even on-grid duration (200000us = 6 frames @ 30fps)', () => {
    expect(validateTimelineDoc(docWithTransitionDuration(200_000)).success).toBe(true);
  });

  it('rejects an odd frame count (100000us = 3 frames @ 30fps)', () => {
    expectIssue(docWithTransitionDuration(100_000), 'must be an even frame count >= 2');
  });

  it('rejects a duration below 2 frames (33333us = 1 frame @ 30fps)', () => {
    expectIssue(docWithTransitionDuration(33_333), 'must be an even frame count >= 2');
  });

  it('rejects a duration off the project fps grid (150000us is between frames 4 and 5 @ 30fps)', () => {
    expectIssue(docWithTransitionDuration(150_000), 'not on the project fps frame grid');
  });
});

describe('transition symmetry', () => {
  it('rejects a one-sided transitionOut (missing transitionIn on the incoming clip)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = undefined;
    expectIssue(doc, 'transition symmetry violated: transitionOut has no matching transitionIn');
  });

  it('rejects a one-sided transitionIn (missing transitionOut on the outgoing clip)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transitionOut = undefined;
    expectIssue(doc, 'transition symmetry violated: transitionIn has no matching transitionOut');
  });

  it('rejects transitions that differ in type across the cut', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = { type: 'dissolve', durationUs: 1_000_000 };
    expectIssue(doc, 'both sides of the cut must be deep-equal');
  });

  it('rejects transitions that differ in durationUs across the cut', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = { type: 'crossfade', durationUs: 200_000 };
    expectIssue(doc, 'both sides of the cut must be deep-equal');
  });
});

describe('effect params (rendering-semantics §4)', () => {
  function docWithEffect(effect: Effect): TimelineDoc {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).effects = [effect];
    return doc;
  }

  it('accepts a valid colorAdjust effect (subset of the allowed keys)', () => {
    const doc = docWithEffect({
      id: uid(910),
      type: 'colorAdjust',
      enabled: true,
      params: { brightness: -1, contrast: 1, exposure: 0.25 },
    });
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('rejects an unrecognized colorAdjust param key', () => {
    const doc = docWithEffect({
      id: uid(911),
      type: 'colorAdjust',
      enabled: true,
      params: { brightness: 0, blur: 0.5 },
    });
    expectIssue(doc, "unrecognized colorAdjust param 'blur'");
  });

  it('rejects a colorAdjust param outside [-1, 1]', () => {
    const doc = docWithEffect({
      id: uid(912),
      type: 'colorAdjust',
      enabled: true,
      params: { brightness: 1.5 },
    });
    expectIssue(doc, "colorAdjust param 'brightness' must be a number in [-1, 1]");
  });

  it('rejects a non-numeric colorAdjust param', () => {
    const doc = docWithEffect({
      id: uid(913),
      type: 'colorAdjust',
      enabled: true,
      params: { contrast: '0.5' },
    });
    expectIssue(doc, "colorAdjust param 'contrast' must be a number in [-1, 1]");
  });

  it('accepts a valid lut effect', () => {
    const doc = docWithEffect({
      id: uid(914),
      type: 'lut',
      enabled: true,
      params: { assetId: uid(500), intensity: 0.75 },
    });
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('rejects a lut effect without a UUID assetId', () => {
    const doc = docWithEffect({
      id: uid(915),
      type: 'lut',
      enabled: true,
      params: { assetId: 'not-a-uuid', intensity: 0.5 },
    });
    expectIssue(doc, "lut param 'assetId' must be a UUID string");
  });

  it('rejects a lut effect with a missing assetId', () => {
    const doc = docWithEffect({
      id: uid(916),
      type: 'lut',
      enabled: true,
      params: { intensity: 0.5 },
    });
    expectIssue(doc, "lut param 'assetId' must be a UUID string");
  });

  it('rejects a lut intensity outside [0, 1]', () => {
    const doc = docWithEffect({
      id: uid(917),
      type: 'lut',
      enabled: true,
      params: { assetId: uid(500), intensity: 1.5 },
    });
    expectIssue(doc, "lut param 'intensity' must be a number in [0, 1]");
  });

  it('rejects an unrecognized lut param key', () => {
    const doc = docWithEffect({
      id: uid(918),
      type: 'lut',
      enabled: true,
      params: { assetId: uid(500), intensity: 1, strength: 0.5 },
    });
    expectIssue(doc, "unrecognized lut param 'strength'");
  });
});

// ---------------------------------------------------------------------------
// Rule 8 — audio fades (mirrors ExportCompiler.ValidateMediaClip)
// ---------------------------------------------------------------------------

describe('audio fades (rule 8)', () => {
  const withAudio = (fadeInUs: number, fadeOutUs: number, durationUs = 2_000_000): TimelineDoc => {
    const doc = validDoc();
    doc.tracks[1].clips = [
      mediaClip({
        timelineStartUs: 0,
        timelineDurationUs: durationUs,
        sourceOutUs: durationUs,
        audio: { volume: 1, fadeInUs, fadeOutUs, muted: false },
      }),
    ];
    return doc;
  };

  it('accepts fades that exactly fill the clip', () => {
    expect(validateTimelineDoc(withAudio(1_200_000, 800_000)).success).toBe(true);
  });

  it('rejects fadeIn + fadeOut longer than the clip', () => {
    expectIssue(withAudio(1_200_000, 900_000), 'exceed the clip duration');
  });

  it('rejects a single fade longer than the clip (the trim regression)', () => {
    // 10 s clip with a 5 s fade-in trimmed down to 2 s WITHOUT re-clamping is
    // exactly the document the export compiler answers with HTTP 422.
    expectIssue(withAudio(5_000_000, 0), 'exceed the clip duration');
  });

  it('ignores clips whose audio was detached (audio === null)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).audio = null;
    expect(validateTimelineDoc(doc).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 9 + shared transform bounds (mirrors ExportCompiler.ValidateGeometry)
// ---------------------------------------------------------------------------

describe('transform scale bounds (rule 9)', () => {
  it('rejects scale 0 on a drawn clip — the compiler requires scale > 0', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 0;
    expectIssue(doc, 'transform.scale must be greater than 0');
  });

  it('rejects a negative scale', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = -1;
    expectIssue(doc, 'transform.scale must be greater than 0');
  });

  it('accepts scale 0 on an AUDIO clip (no visual layer, compiler skips it)', () => {
    const doc = validDoc();
    const audioOnly = mediaClip({ timelineStartUs: 0, timelineDurationUs: 1_000_000 });
    audioOnly.kind = 'audio';
    audioOnly.transform.scale = 0;
    doc.tracks.push({
      id: uid(4),
      type: 'audio',
      muted: false,
      hidden: false,
      locked: false,
      clips: [audioOnly],
    });
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('accepts a large-but-renderable scale (the ceiling is NOT a doc invariant)', () => {
    // Changing the project resolution can legitimately push an existing clip
    // past maxScaleFor(); the write-time clamp handles that, the document
    // validator must not brick every later op over it.
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 9;
    expect(validateTimelineDoc(doc).success).toBe(true);
  });
});

describe('maxScaleFor (shared with the export compiler)', () => {
  const roundHalfUpPx = (v: number): number => Math.floor(v + 0.5);

  it('mirrors the backend LayerGeometry.MaxLayerDimension constant', () => {
    expect(MAX_LAYER_DIMENSION).toBe(8192);
  });

  it('derives the ceiling from the longest composition side', () => {
    expect(maxScaleFor({ width: 1920, height: 1080 })).toBe(4.266);
    expect(maxScaleFor({ width: 3840, height: 2160 })).toBe(2.133);
    // Portrait: the LONGEST side binds, not the width.
    expect(maxScaleFor({ width: 1080, height: 1920 })).toBe(4.266);
  });

  it('floors at the stored precision so the compiler bound is never crossed', () => {
    for (const settings of [
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 },
      { width: 1080, height: 1920 },
      { width: 1280, height: 720 },
      { width: 720, height: 1280 },
    ]) {
      const scale = maxScaleFor(settings);
      // The compiler computes roundHalfUp(dimension * scale) and rejects > MAX.
      expect(roundHalfUpPx(settings.width * scale)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
      expect(roundHalfUpPx(settings.height * scale)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
      // One step above the ceiling MUST cross it, or the bound is too loose.
      const overshoot = scale + 10 ** -TRANSFORM_SCALE_DECIMALS;
      const longest = Math.max(settings.width, settings.height);
      expect(roundHalfUpPx(longest * overshoot)).toBeGreaterThan(MAX_LAYER_DIMENSION);
    }
  });

  it('never returns a ceiling below the floor', () => {
    expect(maxScaleFor({ width: 10_000_000, height: 10_000_000 })).toBe(TRANSFORM_SCALE_MIN);
    expect(maxScaleFor({ width: 0, height: 0 })).toBe(TRANSFORM_SCALE_MIN);
  });
});

describe('exportFrameGridIssues (compiler gate replica)', () => {
  it('accepts the valid baseline document', () => {
    expect(exportFrameGridIssues(validDoc())).toEqual([]);
  });

  it('reports a duration that is off the project frame grid', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    // 33_334us is one microsecond past frame 1 at 30 fps (33_333us) — exactly
    // the shape `timelineDurationUs = roundHalfUp((out-in)/rate)` produces on
    // its own, and exactly what ExportCompiler.CompileInternal rejects.
    clip.timelineDurationUs = 33_334;
    clip.sourceOutUs = 33_334;
    const issues = exportFrameGridIssues(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      trackIndex: 1,
      clipIndex: 0,
      clipId: clip.id,
      field: 'timelineDurationUs',
      valueUs: 33_334,
      snappedUs: 33_333,
    });
  });

  it('reports an off-grid start as well, and both fields on the same clip', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.timelineStartUs = 1;
    clip.timelineDurationUs = 33_334;
    clip.sourceOutUs = 33_334;
    expect(exportFrameGridIssues(doc).map((i) => i.field)).toEqual([
      'timelineStartUs',
      'timelineDurationUs',
    ]);
  });

  it('is not wired into validateTimelineDoc (documented, deliberate)', () => {
    // The gate cannot be a document invariant: outside 25 fps the grid is not
    // closed under addition, so adjacent clips (which transitions REQUIRE)
    // cannot all have grid starts and grid durations at once. The document
    // below is a legitimate schema-valid document that the gate still flags.
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.timelineDurationUs = 33_334;
    clip.sourceOutUs = 33_334;
    clip.keyframes = {};
    doc.tracks[1].clips[1].timelineStartUs = 33_334;
    (doc.tracks[1].clips[0] as MediaClip).transitionOut = undefined;
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = undefined;
    expect(validateTimelineDoc(doc, DURATIONS).success).toBe(true);
    expect(exportFrameGridIssues(doc).length).toBeGreaterThan(0);
  });
});

describe('canonical fixtures (test-vectors/*.fixture.json)', () => {
  const vectorsDir = fileURLToPath(new URL('../test-vectors/', import.meta.url));

  it('the canonical empty document passes full validation', () => {
    const doc: unknown = JSON.parse(readFileSync(new URL('../test-vectors/empty-doc.fixture.json', import.meta.url), 'utf8'));
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(true);
  });

  const fixtureFiles = readdirSync(vectorsDir).filter((f) => f.endsWith('.fixture.json'));

  it('has at least one fixture', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(1);
  });

  it.each(fixtureFiles)('%s passes validateTimelineDoc', (file) => {
    const doc: unknown = JSON.parse(readFileSync(new URL(`../test-vectors/${file}`, import.meta.url), 'utf8'));
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(true);
  });
});

describe('structural schema', () => {
  it('rejects negative *Us values', () => {
    const doc = validDoc();
    doc.markers[0].timeUs = -1;
    expect(validateTimelineDoc(doc).success).toBe(false);
  });

  it('rejects non-integer *Us values', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).timelineStartUs = 0.5 as never;
    expect(validateTimelineDoc(doc).success).toBe(false);
  });

  it('rejects effect types outside the MVP set (blur/chromaKey removed)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).effects = [
      { id: uid(901), type: 'blur' as never, enabled: true, params: { radius: 5 } },
    ];
    expect(validateTimelineDoc(doc).success).toBe(false);
  });

  it('rejects a text clip without fontId', () => {
    const doc = validDoc();
    const clip = doc.tracks[0].clips[0] as TextClip;
    delete (clip.text as Record<string, unknown>).fontId;
    (clip.text as Record<string, unknown>).fontFamily = 'Inter'; // legacy field is not a substitute
    expect(validateTimelineDoc(doc).success).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    const doc = validDoc();
    (doc as Record<string, unknown>).schemaVersion = 2;
    expect(validateTimelineDoc(doc).success).toBe(false);
  });

  it('rejects an invalid transition type', () => {
    const doc = validDoc();
    const clipA = doc.tracks[1].clips[0] as MediaClip;
    clipA.transitionOut = { type: 'starWipe' as never, durationUs: 100_000 };
    expect(validateTimelineDoc(doc).success).toBe(false);
  });
});
