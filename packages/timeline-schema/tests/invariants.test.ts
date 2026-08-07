import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateTimelineDoc } from '../src/index.js';
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

  it('skips the handle rule when asset durations are not provided', () => {
    const doc = validDoc();
    const clipB = doc.tracks[1].clips[1] as MediaClip;
    clipB.sourceInUs = 0; // would fail the handle rule if durations were known
    clipB.sourceOutUs = 2_000_000;
    expect(validateTimelineDoc(doc).success).toBe(true);
    expect(validateTimelineDoc(doc, DURATIONS).success).toBe(false);
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
