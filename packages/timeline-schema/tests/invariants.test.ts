import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_KEYFRAME_SAMPLES,
  MAX_LAYER_DIMENSION,
  TRANSFORM_SCALE_DECIMALS,
  TRANSFORM_SCALE_MIN,
  exportFrameGridIssues,
  intermediateCanvasLongSidePx,
  keyframeSampleUpperBound,
  maxScaleFor,
  maxScaleForFit,
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

  it('matches the shared keyframe-bounds vectors (zod <-> C# parity)', () => {
    // Aynı dosya backend'de KeyframeBoundsParityTests tarafından ExportCompiler.Validate'e
    // karşı koşulur: sınır sözleşmesi ([0, timelineDurationUs], iki uç kapsayıcı) iki dilde
    // tek kaynaktan ölçülür. Her vaka görsel (opacity) VE ses (volume) kanalında koşar.
    interface BoundsVectors {
      cases: { name: string; timelineDurationUs: number; timeUs: number; valid: boolean }[];
    }
    const vectors: BoundsVectors = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../test-vectors/keyframe-bounds-vectors.json', import.meta.url)),
        'utf8',
      ),
    );
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(vectors.cases.some((c) => c.valid)).toBe(true); // dosya iki YÖNÜ de taşımalı
    expect(vectors.cases.some((c) => !c.valid)).toBe(true);
    for (const c of vectors.cases) {
      for (const channel of ['opacity', 'volume'] as const) {
        const kfs = [{ timeUs: c.timeUs, value: 1, easing: { type: 'linear' as const } }];
        const doc = validDoc();
        const solo = mediaClip({
          timelineStartUs: 0,
          timelineDurationUs: c.timelineDurationUs,
          keyframes: channel === 'opacity' ? { opacity: kfs } : { volume: kfs },
        });
        doc.tracks[1].clips = [solo];
        const result = validateTimelineDoc(doc);
        expect(result.success, `${c.name} / ${channel}`).toBe(c.valid);
      }
    }
  });

  it('matches the shared source-range vectors (zod <-> C# parity)', () => {
    // Aynı dosya backend'de SourceRangeParityTests tarafından ExportCompiler.Validate'e karşı
    // koşulur: kaynak-aralığı belge-değişmezinin ([0 <= in < out], süre = roundHalfUp((out-in)/
    // rate)) KABUL/RET davranışı iki dilde tek kaynaktan ölçülür. Formülün sayısal paritesi
    // ayrıca time-vectors.json 'duration' ile ölçülür; bu dosya BELGE reddini ölçer (C1 sınıfı).
    interface SourceRangeVectors {
      cases: {
        name: string;
        sourceInUs: number;
        sourceOutUs: number;
        rate: number;
        timelineDurationUs: number;
        valid: boolean;
      }[];
    }
    const vectors: SourceRangeVectors = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../test-vectors/source-range-vectors.json', import.meta.url)),
        'utf8',
      ),
    );
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(vectors.cases.some((c) => c.valid)).toBe(true); // dosya iki YÖNÜ de taşımalı
    expect(vectors.cases.some((c) => !c.valid)).toBe(true);
    for (const c of vectors.cases) {
      const doc = validDoc();
      const solo = mediaClip({
        timelineStartUs: 0,
        timelineDurationUs: c.timelineDurationUs,
        sourceInUs: c.sourceInUs,
        sourceOutUs: c.sourceOutUs,
        speed: { rate: c.rate },
      });
      doc.tracks[1].clips = [solo];
      const result = validateTimelineDoc(doc);
      expect(result.success, `${c.name}`).toBe(c.valid);
    }
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

/**
 * Transition PLACEMENT — the compiler folds the two clips of a cut into one
 * xfade stream and requires both inputs to be the same size, so their transforms
 * must be equal (ExportCompiler.cs: "geçişli kliplerin yerleşimi aynı olmalıdır").
 *
 * This rule is the reason a document can no longer be queued and then die in the
 * worker: the compiler enforces it in COMPILE, not in `Validate`, so the API's
 * 422 pre-gate never saw it. Here it is a document invariant, which means the
 * editor's own commit gate refuses to write one.
 */
describe('transition placement (both clips of a cut share one transform)', () => {
  /** Every field of the transform, since every one of them moves the layout. */
  const FIELDS = ['x', 'y', 'scale', 'rotationDeg', 'anchorX', 'anchorY'] as const;

  it.each(FIELDS)('rejects a cut whose two clips differ in transform.%s', (field) => {
    const doc = validDoc();
    const outgoing = doc.tracks[1].clips[0] as MediaClip;
    // A value that is legal on its own (inside the schema bounds — anchors are
    // capped at 1) but different from the incoming clip's.
    outgoing.transform[field] = field === 'anchorX' || field === 'anchorY' ? 0.25 : 1.75;
    expectIssue(doc, 'transition placement violated');
  });

  it('names the differing field and both values (the message has to be actionable)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 2;
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.message.includes('transition placement'));
    expect(issue?.message).toContain('scale: 2 vs 1');
    // Reported on the OUTGOING clip's transform, so the path points at a clip
    // the user can actually select.
    expect(issue?.path.join('.')).toBe('tracks.1.clips.0.transform');
  });

  it('reports the cut ONCE, not once per side', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 2;
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.filter((i) => i.message.includes('transition placement')),
    ).toHaveLength(1);
  });

  it('accepts differing transforms when there is NO transition on the cut', () => {
    // The rule is about the cut, not about the track: two ordinary neighbours
    // are free to be laid out differently and always were.
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transitionOut = undefined;
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = undefined;
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 2;
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('accepts a transition cut whose clips share a NON-default transform', () => {
    const doc = validDoc();
    const shared = { x: 0.1, y: -0.2, scale: 1.5, rotationDeg: 30, anchorX: 0.25, anchorY: 0.75 };
    (doc.tracks[1].clips[0] as MediaClip).transform = { ...shared };
    (doc.tracks[1].clips[1] as MediaClip).transform = { ...shared };
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('does not fire on a one-sided transition (symmetry is the more basic failure)', () => {
    const doc = validDoc();
    (doc.tracks[1].clips[1] as MediaClip).transitionIn = undefined;
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 2;
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('transition symmetry violated');
    expect(messages).not.toContain('transition placement violated');
  });
});

describe('cross-language document-invariant vectors (zod <-> C# parity)', () => {
  // Üç aile de backend'de birebir aynı dosyalardan koşulur:
  //   keyframe-order-vectors.json      -> KeyframeOrderParityTests.cs
  //   clip-placement-vectors.json      -> ClipPlacementParityTests.cs
  //   transition-symmetry-vectors.json -> TransitionSymmetryParityTests.cs
  // Hakem orada ExportCompiler.Validate'tir; burada validateTimelineDoc. Vektör dosyası
  // iki YÖNÜ de (kabul + ret) taşımak zorundadır — tek yönlü dosya sınırı ölçmez.
  function loadVectors<TCase>(file: string): { cases: TCase[] } {
    const vectors = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../test-vectors/${file}`, import.meta.url)), 'utf8'),
    ) as { cases: (TCase & { valid: boolean })[] };
    expect(vectors.cases.length).toBeGreaterThan(0);
    expect(vectors.cases.some((c) => c.valid)).toBe(true);
    expect(vectors.cases.some((c) => !c.valid)).toBe(true);
    return vectors;
  }

  function bareDoc(clips: MediaClip[]): TimelineDoc {
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
      tracks: [videoTrack(clips)],
      markers: [],
    };
  }

  it('matches the shared keyframe-order vectors', () => {
    interface OrderCase {
      name: string;
      timelineDurationUs: number;
      timesUs: number[];
      valid: boolean;
    }
    const vectors = loadVectors<OrderCase>('keyframe-order-vectors.json');
    for (const c of vectors.cases) {
      for (const channel of ['opacity', 'volume'] as const) {
        const kfs = c.timesUs.map((timeUs) => ({ timeUs, value: 1, easing: { type: 'linear' as const } }));
        const clip = mediaClip({
          timelineStartUs: 0,
          timelineDurationUs: c.timelineDurationUs,
          keyframes: channel === 'opacity' ? { opacity: kfs } : { volume: kfs },
        });
        const result = validateTimelineDoc(bareDoc([clip]));
        expect(result.success, `${c.name} / ${channel}`).toBe(c.valid);
      }
    }
  });

  it('matches the shared clip-placement vectors', () => {
    interface PlacementCase {
      name: string;
      clips: { startUs: number; durationUs: number }[];
      valid: boolean;
    }
    const vectors = loadVectors<PlacementCase>('clip-placement-vectors.json');
    for (const c of vectors.cases) {
      const clips = c.clips.map((spec) =>
        mediaClip({ timelineStartUs: spec.startUs, timelineDurationUs: spec.durationUs }),
      );
      const result = validateTimelineDoc(bareDoc(clips));
      expect(result.success, c.name).toBe(c.valid);
    }
  });

  it('matches the shared transition-symmetry vectors', () => {
    interface TransitionSpec {
      type: 'crossfade' | 'dissolve';
      durationUs: number;
    }
    interface TransitionCase {
      name: string;
      aDurationUs: number;
      bDurationUs: number;
      gapUs: number;
      aRate: number;
      bRate: number;
      bSourceInUs: number;
      aTransition: TransitionSpec | null;
      bTransition: TransitionSpec | null;
      bStill: boolean;
      valid: boolean;
    }
    const vectors = loadVectors<TransitionCase>('transition-symmetry-vectors.json');
    for (const c of vectors.cases) {
      const a = mediaClip({
        timelineStartUs: 0,
        timelineDurationUs: c.aDurationUs,
        sourceInUs: 0,
        sourceOutUs: c.aDurationUs * c.aRate,
        speed: { rate: c.aRate },
        assetId: ASSET_A,
        transitionOut: c.aTransition ?? undefined,
      });
      const bStart = c.aDurationUs + c.gapUs;
      const b = c.bStill
        ? mediaClip({
            kind: 'image',
            timelineStartUs: bStart,
            timelineDurationUs: c.bDurationUs,
            sourceInUs: 0,
            sourceOutUs: c.bDurationUs,
            assetId: ASSET_B,
            transitionIn: c.bTransition ?? undefined,
          })
        : mediaClip({
            timelineStartUs: bStart,
            timelineDurationUs: c.bDurationUs,
            sourceInUs: c.bSourceInUs,
            sourceOutUs: c.bSourceInUs + c.bDurationUs * c.bRate,
            speed: { rate: c.bRate },
            assetId: ASSET_B,
            transitionIn: c.bTransition ?? undefined,
          });
      // assetDurations BİLEREK verilmez: kuyruk (tail) payı asset süresi ister; C# hakemi
      // (ExportCompiler.Validate) de o süreyi göremez — parite ancak aynı bilgiyle ölçülür.
      const result = validateTimelineDoc(bareDoc([a, b]));
      expect(result.success, c.name).toBe(c.valid);
    }
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
    //
    // The two video clips of validDoc() share a crossfade, so the scale goes on
    // BOTH sides: leaving one behind would fail the transition-placement rule
    // instead and this test would stop saying anything about the ceiling.
    const doc = validDoc();
    (doc.tracks[1].clips[0] as MediaClip).transform.scale = 9;
    (doc.tracks[1].clips[1] as MediaClip).transform.scale = 9;
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

describe('intermediateCanvasLongSidePx (LayerGeometry.Compute ledger twin)', () => {
  const centered = { rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 };

  it('unrotated: the canvas IS the scale box (long side)', () => {
    expect(intermediateCanvasLongSidePx(7137, 4014, centered)).toBe(7137);
    // Multiples of 360 produce no rotate filter — same as the compiler's
    // `rotationDeg % 360` normalization.
    expect(intermediateCanvasLongSidePx(7137, 4014, { ...centered, rotationDeg: 360 })).toBe(7137);
    expect(intermediateCanvasLongSidePx(7137, 4014, { ...centered, rotationDeg: -720 })).toBe(7137);
  });

  it('rotated + centered anchor: smallest EVEN integer covering the diagonal', () => {
    // hypot(7137, 4014) = 8188.34…; ceil -> 8189; even -> 8190. The angle only
    // matters as zero/non-zero — the square canvas covers every rotation, which
    // is exactly the compiler's `2*ceil(hypot(iw,ih)/2)` square.
    for (const deg of [45, 90, 10, 359]) {
      expect(intermediateCanvasLongSidePx(7137, 4014, { ...centered, rotationDeg: deg })).toBe(8190);
    }
  });

  it('rotated + off-center anchor: the anchor pad widens the box first', () => {
    // anchor (0,0): mx = my = 1 -> pad = ceil(box*2). hypot(2000,1000)=2236.07;
    // ceil 2237; even 2238.
    expect(
      intermediateCanvasLongSidePx(1000, 500, { rotationDeg: 90, anchorX: 0, anchorY: 0 }),
    ).toBe(2238);
    // anchor (0.75, 0.5): padW = ceil(100*1.5) = 150, padH = ceil(100*1.0) = 100;
    // hypot(150,100) = 180.27…; ceil 181; even 182.
    expect(
      intermediateCanvasLongSidePx(100, 100, { rotationDeg: 10, anchorX: 0.75, anchorY: 0.5 }),
    ).toBe(182);
  });
});

describe('maxScaleForFit (rotation-aware scale ceiling)', () => {
  const roundHalfUpPx = (v: number): number => Math.floor(v + 0.5);
  const centered = { rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 };

  it('reduces to maxScaleFor with no rotation', () => {
    for (const [w, h] of [[1920, 1080], [3840, 2160], [720, 1280]] as const) {
      expect(maxScaleForFit(w, h, centered)).toBe(maxScaleFor({ width: w, height: h }));
    }
  });

  it('rotation lowers the ceiling by the diagonal (pinned values)', () => {
    // 1080p: unrotated 4.266; rotated the DIAGONAL must fit into 8192.
    expect(maxScaleForFit(1920, 1080, { ...centered, rotationDeg: 45 })).toBe(3.718);
    expect(maxScaleForFit(1920, 1080, { ...centered, rotationDeg: 90 })).toBe(3.718);
    // Off-center anchor pads the canvas by 2x on top of the diagonal.
    expect(maxScaleForFit(1920, 1080, { rotationDeg: 90, anchorX: 0, anchorY: 0 })).toBe(1.859);
    expect(maxScaleForFit(3840, 2160, { ...centered, rotationDeg: 30 })).toBe(1.859);
  });

  it('is SAFE and MAXIMAL against the ledger predicate across a sweep', () => {
    const step = 10 ** -TRANSFORM_SCALE_DECIMALS;
    for (const [w, h] of [[1920, 1080], [3840, 2160], [1280, 720], [720, 1280], [100, 100], [223, 104]] as const) {
      for (const rotationDeg of [0, 15, 45, 90, 180, 359, -45]) {
        for (const [anchorX, anchorY] of [[0.5, 0.5], [0, 0], [1, 0.25]] as const) {
          const pose = { rotationDeg, anchorX, anchorY };
          const s = maxScaleForFit(w, h, pose);
          const at = (scale: number): number =>
            intermediateCanvasLongSidePx(roundHalfUpPx(w * scale), roundHalfUpPx(h * scale), pose);
          // Safe: the offered ceiling passes the compiler's gate…
          expect(at(s), `${w}x${h} rot=${rotationDeg} a=(${anchorX},${anchorY}) s=${s}`).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
          // …and maximal UP TO the ledger's own resolution: one scale-grid
          // step above either violates the gate or leaves the gated quantity
          // (the canvas LONG side) exactly where it was — at tiny fit sizes a
          // 0.001 step moves the box under half a pixel, and the unrotated
          // closed form deliberately floors on the longest side only (the
          // pre-existing maxScaleFor contract, unchanged by this wave).
          const above = Math.round((s + step) * 1000) / 1000;
          if (s > TRANSFORM_SCALE_MIN && at(above) <= MAX_LAYER_DIMENSION) {
            expect(
              at(above),
              `${w}x${h} rot=${rotationDeg} a=(${anchorX},${anchorY}) s+1grid=${above} passes AND grew the gated canvas`,
            ).toBe(at(s));
          }
        }
      }
    }
  });

  it('one zero axis binds on the other alone (font-independent text bound has no width)', () => {
    // (0, 2400) rotated: the diagonal of a (0, 2400s) box is 2400s itself.
    expect(maxScaleForFit(0, 2400, { rotationDeg: 45, anchorX: 0.5, anchorY: 0.5 })).toBe(3.413);
    // Unrotated it reduces to the longest-side closed form.
    expect(maxScaleForFit(0, 2400, centered)).toBe(3.413);
  });

  it('degenerate fit sizes fall to the floor instead of NaN/Infinity', () => {
    expect(maxScaleForFit(0, 0, { rotationDeg: 45, anchorX: 0.5, anchorY: 0.5 })).toBe(TRANSFORM_SCALE_MIN);
    expect(maxScaleForFit(Number.NaN, 1080, { rotationDeg: 45, anchorX: 0.5, anchorY: 0.5 })).toBe(TRANSFORM_SCALE_MIN);
  });
});

describe('keyframeSampleUpperBound (compiler sample-budget upper bound)', () => {
  it('mirrors the backend KeyframeCompiler.MaxSamples constant', () => {
    expect(MAX_KEYFRAME_SAMPLES).toBe(60_000);
  });

  const kf = (timeUs: number, value: number, easing: 'linear' | 'easeIn' = 'linear') => ({
    timeUs,
    value,
    easing: { type: easing } as const,
  });

  const docOf = (tracks: Track[]): TimelineDoc => {
    const base = validDoc();
    return { ...base, tracks };
  };

  /** 10 s clip at the 30 fps project = 300 frames. `audio` defaults to owned. */
  const clipWith = (keyframes: MediaClip['keyframes'], over: Partial<MediaClip> = {}): TimelineDoc =>
    docOf([
      videoTrack([
        mediaClip({
          timelineStartUs: 0,
          timelineDurationUs: 10_000_000,
          keyframes,
          audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
          ...over,
        }),
      ]),
    ]);

  it('a fully linear visual channel costs 0 (closed-form path)', () => {
    expect(keyframeSampleUpperBound(clipWith({ x: [kf(0, 0), kf(9_000_000, 0.5)] }))).toBe(0);
  });

  it('a curved segment samples per frame; the LAST keyframe easing is inert', () => {
    expect(
      keyframeSampleUpperBound(clipWith({ x: [kf(0, 0, 'easeIn'), kf(9_000_000, 0.5)] })),
    ).toBe(300);
    // Easing on the last keyframe has no segment after it — same as the
    // compiler's AllLinear (Keys.Take(Count-1)).
    expect(
      keyframeSampleUpperBound(clipWith({ x: [kf(0, 0), kf(9_000_000, 0.5, 'easeIn')] })),
    ).toBe(0);
  });

  it('scale charges TWICE (ScaleWidth + ScaleHeight are sampled separately)', () => {
    expect(
      keyframeSampleUpperBound(clipWith({ scale: [kf(0, 1, 'easeIn'), kf(9_000_000, 2)] })),
    ).toBe(600);
  });

  it('opacity charges even when linear (colorchannelmixer has no closed form)', () => {
    expect(
      keyframeSampleUpperBound(clipWith({ opacity: [kf(0, 0), kf(9_000_000, 1)] })),
    ).toBe(300);
  });

  it('volume charges only when the clip still owns audio', () => {
    const volume = { volume: [kf(0, 1), kf(9_000_000, 0.5)] };
    expect(keyframeSampleUpperBound(clipWith(volume))).toBe(300);
    expect(keyframeSampleUpperBound(clipWith(volume, { audio: null }))).toBe(0);
  });

  it('an audio-kind clip spends no visual samples (nothing draws them)', () => {
    const d = clipWith(
      { x: [kf(0, 0, 'easeIn'), kf(9_000_000, 0.5)], volume: [kf(0, 1), kf(9_000_000, 0.5)] },
      { kind: 'audio' },
    );
    // volume: 300; the curved x channel would be 300 more on a visual clip.
    expect(keyframeSampleUpperBound(d)).toBe(300);
  });

  it('sums across clips and channels (the budget is compile-wide)', () => {
    const d = docOf([
      videoTrack([
        mediaClip({
          timelineStartUs: 0,
          timelineDurationUs: 10_000_000,
          keyframes: {
            x: [kf(0, 0, 'easeIn'), kf(9_000_000, 0.5)],
            scale: [kf(0, 1, 'easeIn'), kf(9_000_000, 2)],
          },
        }),
        mediaClip({
          timelineStartUs: 10_000_000,
          timelineDurationUs: 10_000_000,
          keyframes: { opacity: [kf(0, 0), kf(9_000_000, 1)] },
        }),
      ]),
    ]);
    // 300 (x curved) + 600 (scale curved, twice) + 300 (opacity) = 1200.
    expect(keyframeSampleUpperBound(d)).toBe(1200);
  });
});

describe('exportFrameGridIssues (compiler gate replica)', () => {
  it('accepts the valid baseline document', () => {
    expect(exportFrameGridIssues(validDoc())).toEqual([]);
  });

  it('reports a clip END that is off the project frame grid', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    // Start 0, duration 33_334 -> end 33_334, one microsecond past frame 1 at
    // 30 fps (33_333 us). That is exactly what ExportCompiler.Validate rejects,
    // because its ledger turns the end into a frame number.
    clip.timelineStartUs = 0;
    clip.timelineDurationUs = 33_334;
    clip.sourceOutUs = 33_334;
    clip.keyframes = {};
    const issues = exportFrameGridIssues(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      trackIndex: 1,
      clipIndex: 0,
      clipId: clip.id,
      field: 'timelineEndUs',
      valueUs: 33_334,
      snappedUs: 33_333,
    });
  });

  it('reports an off-grid start as well, and both edges on the same clip', () => {
    const doc = validDoc();
    const clip = doc.tracks[1].clips[0] as MediaClip;
    clip.timelineStartUs = 1;
    clip.timelineDurationUs = 33_334;
    clip.sourceOutUs = 33_334;
    clip.keyframes = {};
    expect(exportFrameGridIssues(doc).map((i) => i.field)).toEqual([
      'timelineStartUs',
      'timelineEndUs',
    ]);
  });

  it('accepts an off-grid DURATION when both edges are on the grid', () => {
    // THE regression this gate was rewritten for. At 30 fps frame 1 is 33_333
    // us and frame 2 is 66_667 us, so a clip from frame 1 to frame 2 is 33_334
    // us long — a duration that is NOT a grid value. The old duration-based
    // gate rejected it, which made splitting a clip produce a document the
    // editor saved happily (PUT 200) and the export refused (422).
    const doc = validDoc();
    doc.tracks[1].clips = [
      mediaClip({ timelineStartUs: 0, timelineDurationUs: 33_333 }),
      mediaClip({ timelineStartUs: 33_333, timelineDurationUs: 33_334 }),
      mediaClip({ timelineStartUs: 66_667, timelineDurationUs: 33_333 }),
    ];
    expect(exportFrameGridIssues(doc)).toEqual([]);
    // ... and the same document is a legal document.
    expect(validateTimelineDoc(doc, DURATIONS).success).toBe(true);
  });

  it('is not wired into validateTimelineDoc (documented, deliberate)', () => {
    // The gate stays opt-in: a document can arrive from an older revision (or
    // from a project whose fps changed) with clips off the grid, and failing
    // every later edit would be worse than one actionable message. The document
    // below is schema-valid and still flagged by the gate.
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

describe('link / group / kind-placement invariants (rules 10-12)', () => {
  function audioTrack(clips: MediaClip[]): Track {
    return { id: uid(nextId++), type: 'audio', muted: false, hidden: false, locked: false, clips };
  }

  function audioClip(
    partial: Partial<MediaClip> & Pick<MediaClip, 'timelineStartUs' | 'timelineDurationUs'>,
  ): MediaClip {
    return mediaClip({
      kind: 'audio',
      audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
      ...partial,
    });
  }

  const LINK_1 = uid(7001);
  const GROUP_1 = uid(8001);

  /** validDoc + a linked AV pair: video twin on the video track, audio twin below. */
  function docWithLinkedPair(): { doc: TimelineDoc; video: MediaClip; audio: MediaClip } {
    const doc = validDoc();
    const video = mediaClip({
      timelineStartUs: 5_000_000,
      timelineDurationUs: 1_000_000,
      linkId: LINK_1,
    });
    const audio = audioClip({
      timelineStartUs: 5_000_000,
      timelineDurationUs: 1_000_000,
      linkId: LINK_1,
    });
    doc.tracks[1].clips.push(video);
    doc.tracks.push(audioTrack([audio]));
    return { doc, video, audio };
  }

  it('accepts a linked video+audio pair (rule 10 baseline)', () => {
    expect(validateTimelineDoc(docWithLinkedPair().doc).success).toBe(true);
  });

  it('accepts a linked pair whose two sides carry the SAME groupId (rule 10 consistency)', () => {
    const { doc, video, audio } = docWithLinkedPair();
    video.groupId = GROUP_1;
    audio.groupId = GROUP_1;
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('accepts a cross-kind group (text + video member) with >= 2 members (rule 11 baseline)', () => {
    const doc = validDoc();
    doc.tracks[0].clips[0].groupId = GROUP_1; // text overlay
    doc.tracks[1].clips[0].groupId = GROUP_1; // video clip
    expect(validateTimelineDoc(doc).success).toBe(true);
  });

  it('rejects a dangling linkId (1 clip)', () => {
    const { doc, audio } = docWithLinkedPair();
    audio.linkId = undefined;
    expectIssue(doc, 'link invariant violated');
    expectIssue(doc, 'a link is exactly 2 clips');
  });

  it('rejects a linkId shared by 3 clips', () => {
    const { doc } = docWithLinkedPair();
    const third = mediaClip({
      timelineStartUs: 8_000_000,
      timelineDurationUs: 1_000_000,
      linkId: LINK_1,
    });
    doc.tracks[1].clips.push(third);
    expectIssue(doc, 'appears on 3 clip(s)');
  });

  it('rejects a video+video link pair (rule 10 pair shape)', () => {
    const { doc, audio } = docWithLinkedPair();
    audio.linkId = undefined;
    const secondVideo = mediaClip({
      timelineStartUs: 8_000_000,
      timelineDurationUs: 1_000_000,
      linkId: LINK_1,
    });
    doc.tracks[1].clips.push(secondVideo);
    expectIssue(doc, 'must pair one video and one audio media clip, got video + video');
  });

  it('rejects link partners with DIFFERENT groupIds (rule 10 consistency)', () => {
    const { doc, video, audio } = docWithLinkedPair();
    // Anchor the group on a third clip so rule 11 stays satisfied and the
    // failure below is unambiguously the consistency half of rule 10.
    video.groupId = GROUP_1;
    doc.tracks[1].clips[0].groupId = GROUP_1;
    audio.groupId = undefined;
    expectIssue(doc, 'link/group consistency violated');
  });

  it('rejects a single-member group (rule 11)', () => {
    const doc = validDoc();
    doc.tracks[1].clips[0].groupId = GROUP_1;
    expectIssue(doc, 'group invariant violated');
    expectIssue(doc, 'has 1 member(s)');
  });

  it('rejects an audio clip on a video track (rule 12)', () => {
    const doc = validDoc();
    doc.tracks[1].clips.push(
      audioClip({ timelineStartUs: 5_000_000, timelineDurationUs: 1_000_000 }),
    );
    expectIssue(doc, "a 'audio' clip belongs on a 'audio' track, got a 'video' track");
  });

  it('rejects a video clip on an audio track (rule 12 — the export-side gap)', () => {
    const doc = validDoc();
    doc.tracks.push(
      audioTrack([mediaClip({ timelineStartUs: 0, timelineDurationUs: 1_000_000 })]),
    );
    expectIssue(doc, "a 'video' clip belongs on a 'video' track, got a 'audio' track");
  });

  it('rejects a text clip on a video track (rule 12)', () => {
    const doc = validDoc();
    doc.tracks[1].clips.push(textClip(5_000_000, 1_000_000));
    expectIssue(doc, "a 'text' clip belongs on a 'overlay' track");
  });

  it('rejects a video clip on an overlay track (rule 12)', () => {
    const doc = validDoc();
    doc.tracks[0].clips.push(
      mediaClip({ timelineStartUs: 2_000_000, timelineDurationUs: 1_000_000 }),
    );
    expectIssue(doc, "a 'video' clip belongs on a 'video' track, got a 'overlay' track");
  });

  it('keeps pre-link/group documents valid UNCHANGED (backward-compat pin)', () => {
    // A document written before these fields existed must parse exactly as it
    // did: valid, and with no linkId/groupId materialized onto its clips.
    const doc = validDoc();
    const result = validateTimelineDoc(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      for (const track of result.data.tracks) {
        for (const clip of track.clips) {
          expect('linkId' in clip).toBe(false);
          expect('groupId' in clip).toBe(false);
        }
      }
    }
  });
});
