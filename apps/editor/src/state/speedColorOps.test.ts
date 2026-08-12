/**
 * M5 clip ops: SPEED and COLOR ADJUST.
 *
 * These two are the ops a reviewer cannot check by looking at the panel:
 * - speed rewrites the timeline LAYOUT (duration formula, neighbours,
 *   keyframes, fades, transition handles) and every one of those has a
 *   normative rule behind it (rendering-semantics §1.3 / §5.2, invariants 3/4/8);
 * - colorAdjust writes an effect whose param shape invariant rule 6 pins down
 *   exactly, and whose values must arrive UNCHANGED at the preview shader
 *   (`colorAdjustOf` -> compositor uniforms).
 *
 * Every case re-validates the whole document against the SHARED schema — the
 * same rules the export compiler enforces, so a document that passes here
 * cannot come back as an HTTP 422.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  exportFrameGridIssues,
  snapUsToFrameGrid,
  validateTimelineDoc,
  type Clip,
  type Keyframe,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { colorAdjustOf } from '../features/player/core/resolve';
import {
  COLOR_ADJUST_DEDUPED,
  COLOR_ADJUST_KEYS,
  SPEED_DURATION_SNAPPED,
  SPEED_KEYFRAMES_MERGED,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  TRANSITION_DROPPED,
  TRANSITION_SHORTENED_HANDLE,
  addTransition,
  colorAdjustEffectOf,
  knownAssetDurations,
  planClipSpeed,
  resetClipColorAdjust,
  setClipAudio,
  setClipColorAdjust,
  setClipColorAdjustEnabled,
  setClipSpeed,
} from './timelineOps';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const A1 = '01890000-0000-7000-8000-000000000102';
const OV1 = '01890000-0000-7000-8000-000000000103';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const CLIP_C = '01890000-0000-7000-8000-000000000203';
const EFFECT_1 = '01890000-0000-7000-8000-000000000301';
const EFFECT_2 = '01890000-0000-7000-8000-000000000302';

function videoClip(
  id: string,
  startUs: number,
  durationUs: number,
  overrides: Partial<MediaClip> = {},
): MediaClip {
  return {
    id,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    ...overrides,
  };
}

function track(id: string, type: Track['type'], clips: Clip[], flags: Partial<Track> = {}): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
}

function load(tracks: Track[]): void {
  useDocStore
    .getState()
    .loadDoc({ ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks });
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function findClip(id: string): Clip {
  for (const t of currentDoc().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  throw new Error(`clip ${id} not found`);
}

function findMedia(id: string): MediaClip {
  return findClip(id) as MediaClip;
}

function expectValid(): void {
  const result = validateTimelineDoc(currentDoc(), knownAssetDurations());
  expect(result.success, JSON.stringify(!result.success ? result.error.issues : null)).toBe(true);
}

function historyLength(): number {
  return useDocStore.getState().history.length;
}

function kf(timeUs: number, value: number): Keyframe {
  return { timeUs, value, easing: { type: 'linear' } };
}

beforeEach(() => {
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore
    .getState()
    .setAssets([{ id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 60 * US }]);
});

// ---------------------------------------------------------------------------
// setClipSpeed — the duration contract
// ---------------------------------------------------------------------------

describe('setClipSpeed — duration formula (rendering-semantics §1.3, invariant 3)', () => {
  it('2x halves the timeline duration and leaves the SOURCE range alone', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipSpeed([CLIP_A], 2)).toEqual({ ok: true });

    const clip = findMedia(CLIP_A);
    expect(clip.speed.rate).toBe(2);
    expect(clip.timelineDurationUs).toBe(5 * US);
    expect(clip.timelineDurationUs).toBe(clipTimelineDurationUs(0, 10 * US, 2));
    // Speed re-times the SAME source material; trimming is a different op.
    expect(clip.sourceInUs).toBe(0);
    expect(clip.sourceOutUs).toBe(10 * US);
    expect(clip.timelineStartUs).toBe(0);
    expectValid();
  });

  it('0.5x doubles it (slow motion) when there is room', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(setClipSpeed([CLIP_A], 0.5).ok).toBe(true);
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(20 * US);
    expectValid();
  });

  it('the STORED rate is what the duration is derived from (rate rounded to 3 decimals)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipSpeed([CLIP_A], 1.23456).ok).toBe(true);

    const clip = findMedia(CLIP_A);
    expect(clip.speed.rate).toBe(1.235);
    // The raw formula on the STORED rate gives 8_097_166us, which is NOT on the
    // 30 fps grid — the export compiler rejects that. The op solves for the
    // nearest frame count instead and moves sourceOut with it, so BOTH export
    // gates hold (see the cross-boundary block below).
    expect(clipTimelineDurationUs(0, 10 * US, 1.235)).toBe(8_097_166);
    expect(clip.timelineDurationUs).toBe(8_100_000);
    expect(clip.timelineDurationUs).toBe(snapUsToFrameGrid(8_097_166, currentDoc().settings.fps));
    expect(clip.timelineDurationUs).toBe(
      clipTimelineDurationUs(clip.sourceInUs, clip.sourceOutUs, 1.235),
    );
    expectValid();
  });

  it('clamps the rate into the schema range [0.1, 10]', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipSpeed([CLIP_A], 99).ok).toBe(true);
    expect(findMedia(CLIP_A).speed.rate).toBe(SPEED_MAX);
    expect(setClipSpeed([CLIP_A], 0.0001).ok).toBe(true);
    expect(findMedia(CLIP_A).speed.rate).toBe(SPEED_MIN);
    expectValid();
  });

  it('refuses a rate that leaves less than one frame on the timeline', () => {
    // 300 ms source at 10x = 30 ms; one frame at 30 fps is 33.3 ms.
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 300_000)])]);

    const result = setClipSpeed([CLIP_A], 10);

    expect(result).toEqual({ ok: false, reason: 'speed leaves less than one frame' });
    expect(findMedia(CLIP_A).speed.rate, 'a refused op must not touch the clip').toBe(1);
    expect(historyLength(), 'a refused op leaves no history entry').toBe(0);
  });

  it('refuses non-finite input instead of writing NaN into the document', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(setClipSpeed([CLIP_A], Number.NaN)).toEqual({ ok: false, reason: 'invalid speed' });
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(10 * US);
  });

  it('images have no time axis — speed does not apply to them', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 4 * US, { kind: 'image', audio: null })]),
    ]);
    expect(setClipSpeed([CLIP_A], 2)).toEqual({
      ok: false,
      reason: 'no video/audio clip in selection',
    });
  });

  it('a locked track refuses (never silently edits behind the lock)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true })]);
    expect(setClipSpeed([CLIP_A], 2)).toEqual({ ok: false, reason: 'track is locked' });
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(10 * US);
  });

  it('one call over a multi-clip selection is ONE history entry', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US), videoClip(CLIP_B, 20 * US, 10 * US)]),
    ]);

    expect(setClipSpeed([CLIP_A, CLIP_B], 2).ok).toBe(true);

    expect(historyLength()).toBe(1);
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(5 * US);
    expect(findMedia(CLIP_B).timelineDurationUs).toBe(5 * US);
    useDocStore.getState().undo();
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(10 * US);
    expect(findMedia(CLIP_B).timelineDurationUs).toBe(10 * US);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(20 * US);
    expectValid();
  });
});

// ---------------------------------------------------------------------------
// setClipSpeed — CROSS-BOUNDARY: the document must clear the EXPORT gates
//
// The editor's own validator (`validateTimelineDoc`) and the export compiler do
// NOT check the same things, and the difference is what shipped as a defect:
// the compiler applies two independent rules to every clip and the editor only
// mirrored the first one, so a plain speed edit produced a document that
// validated locally and came back as HTTP 422 from the export endpoint.
//
//   gate (i)  ExportCompiler.ValidateMediaClip:
//             TimelineDurationUs == Timecode.ClipTimelineDurationUs(in, out, rate)
//   gate (ii) ExportCompiler.CompileInternal:
//             SnapUs(TimelineStartUs) == TimelineStartUs
//             && SnapUs(TimelineDurationUs) == TimelineDurationUs
//
// `exportFrameGridIssues` is gate (ii) restated in the shared schema package,
// so these tests fail here the same way the compiler fails there.
// ---------------------------------------------------------------------------

describe('setClipSpeed — export compiler gates (cross-boundary)', () => {
  function expectClearsBothExportGates(): void {
    const d = currentDoc();
    // Gate (i) — the editor's own invariant 3, restated per clip.
    for (const t of d.tracks) {
      for (const c of t.clips) {
        if (c.kind !== 'video' && c.kind !== 'audio') continue;
        const media = c as MediaClip;
        expect(
          media.timelineDurationUs,
          `gate (i) failed for clip ${media.id}`,
        ).toBe(clipTimelineDurationUs(media.sourceInUs, media.sourceOutUs, media.speed.rate));
      }
    }
    // Gate (ii) — the frame grid.
    expect(exportFrameGridIssues(d), 'gate (ii) failed').toEqual([]);
    // ...and the document is still schema-valid, which is the whole point:
    // ONE fixture has to satisfy both sides of the boundary at once.
    expectValid();
  }

  it('REGRESSION: 0.7x on a 3 s clip no longer lands off the frame grid', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US)])]);

    expect(setClipSpeed([CLIP_A], 0.7).ok).toBe(true);

    const clip = findMedia(CLIP_A);
    // What the old implementation wrote — schema-valid, compiler-rejected.
    expect(clipTimelineDurationUs(0, 3 * US, 0.7)).toBe(4_285_714);
    expect(snapUsToFrameGrid(4_285_714, currentDoc().settings.fps)).not.toBe(4_285_714);
    // What it writes now: a whole frame count, with sourceOut moved to match.
    expect(clip.timelineDurationUs).toBe(4_300_000);
    expect(clip.sourceOutUs).toBe(3_010_000);
    expect(clip.sourceInUs, 'the in point is where the user trimmed').toBe(0);
    expectClearsBothExportGates();
  });

  it('clears both gates for every preset and every awkward rate', () => {
    for (const rate of [...SPEED_PRESETS, 0.1, 0.3, 0.7, 0.999, 1.235, 3.7, 6.66, SPEED_MAX]) {
      load([track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US)])]);
      const result = setClipSpeed([CLIP_A], rate);
      expect(result.ok, `rate ${rate}`).toBe(true);
      expectClearsBothExportGates();
    }
  });

  it('clears both gates on an NTSC project (23.976 fps)', () => {
    useDocStore.getState().loadDoc({
      ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings, fps: { num: 24000, den: 1001 } }),
      tracks: [track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US)])],
    });

    for (const rate of [0.25, 0.5, 0.7, 2, 4]) {
      expect(setClipSpeed([CLIP_A], rate).ok, `rate ${rate}`).toBe(true);
      expectClearsBothExportGates();
    }
  });

  it('never reads past the end of the asset when the grid snap wants MORE source', () => {
    // The asset is exactly as long as the clip, so the 0.7x snap-up that would
    // ask for 3_010_000us of source has nowhere to go: the op must settle on a
    // shorter frame count instead of writing an unexportable sourceOut.
    useAssetStore
      .getState()
      .setAssets([{ id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 3 * US }]);
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US)])]);

    expect(setClipSpeed([CLIP_A], 0.7).ok).toBe(true);

    const clip = findMedia(CLIP_A);
    expect(clip.sourceOutUs).toBeLessThanOrEqual(3 * US);
    expect(clip.timelineDurationUs).toBe(4_266_667); // one frame below 4_300_000
    expectClearsBothExportGates();
  });

  it('fills the room between two neighbours EXACTLY when the rate allows it', () => {
    // 30 fps: frame 2 = 66_667 us, frame 4 = 133_333 us, so the room between
    // two grid-aligned clips is 66_666 us — NOT itself a grid value (the grid
    // is not closed under subtraction outside integer fps). It IS a legal
    // length here though, because a length is the distance between two EDGES:
    // frames 2..4 measured from frame 2. The solver is told where the clip
    // starts, so at 0.5x (the rate the Inspector advertises as "the slowest
    // without ripple", clipInspectorModel.minRateWithoutRipple) the clip lands
    // on exactly that length instead of one microsecond past it.
    const startUs = 66_667;
    const nextStartUs = 133_333;
    load([
      track(V1, 'video', [
        // Frame 2 -> 3 (33_333 us) and frame 4 -> 5 (33_334 us). The two
        // lengths differ although both clips are one frame long: that IS the
        // grid, and both clips sit on it edge to edge.
        videoClip(CLIP_A, startUs, 33_333, { sourceInUs: 0, sourceOutUs: 33_333 }),
        videoClip(CLIP_B, nextStartUs, 33_334, { sourceInUs: 0, sourceOutUs: 33_334 }),
      ]),
    ]);

    expect(setClipSpeed([CLIP_A], 0.5)).toEqual({ ok: true });
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(66_666);
    const a = findMedia(CLIP_A);
    expect(a.timelineStartUs + a.timelineDurationUs).toBe(nextStartUs); // butt-joined
    expect(findMedia(CLIP_B).timelineStartUs).toBe(nextStartUs);
    expectClearsBothExportGates();
  });

  it('a slow-down that does NOT fit refuses atomically — it never overlaps, and never quietly shortens', () => {
    // Same geometry, but 0.25x asks for 4 frames where only 2 fit. Both
    // alternatives to refusing are worse: overlapping breaks invariant 1 (and
    // the export), and dropping to the next admissible frame count below the
    // room silently halves the clip. So the op refuses, atomically, with the
    // reason the UI turns into the "Sonrakileri kaydır" (ripple) offer.
    const startUs = 66_667;
    const nextStartUs = 133_333;
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, startUs, 33_333, { sourceInUs: 0, sourceOutUs: 33_333 }),
        videoClip(CLIP_B, nextStartUs, 33_334, { sourceInUs: 0, sourceOutUs: 33_334 }),
      ]),
    ]);

    expect(setClipSpeed([CLIP_A], 0.25)).toEqual({
      ok: false,
      reason: 'speed change overlaps the next clip',
    });
    expect(findMedia(CLIP_A).timelineDurationUs, 'refusal is atomic').toBe(33_333);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(nextStartUs);
    expect(historyLength()).toBe(0);

    // ...and the ripple escape hatch does work, still clearing both gates —
    // including clip B, which is rippled by whole FRAMES and re-fitted so its
    // own end stays on the grid.
    // The frame count it settles on is NOT the nearest one, so the op SAYS so.
    expect(setClipSpeed([CLIP_A], 0.25, { ripple: true })).toEqual({
      ok: true,
      notice: SPEED_DURATION_SNAPPED,
    });
    // Only every third frame count is reachable at 0.25x (the admissible
    // source window is a quarter of a microsecond wide), so the clip lands on
    // 3 frames measured from frame 2 — 100_000 us — not on the 4 it asked for.
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(100_000);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(200_000); // frame 6
    expectClearsBothExportGates();
  });

  it('stays SILENT when the snap costs less than half a frame (the unavoidable part)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US)])]);
    // 0.7x: ideal 4_285_714us -> 4_300_000us, 14_286us away — well inside the
    // half frame (16_666us) that putting a duration on the grid always costs.
    expect(setClipSpeed([CLIP_A], 0.7)).toEqual({ ok: true });
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(4_300_000);
  });

  it('keeps both gates satisfied after a ripple speed change', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 3 * US), videoClip(CLIP_B, 3 * US, 3 * US)]),
    ]);

    expect(setClipSpeed([CLIP_A], 0.7, { ripple: true }).ok).toBe(true);

    expect(findMedia(CLIP_B).timelineStartUs).toBe(4_300_000);
    expectClearsBothExportGates();
  });
});

// ---------------------------------------------------------------------------
// setClipSpeed — neighbours (reject vs ripple)
// ---------------------------------------------------------------------------

describe('setClipSpeed — neighbouring clips', () => {
  const layout = (): Track[] => [
    track(V1, 'video', [
      videoClip(CLIP_A, 0, 10 * US),
      videoClip(CLIP_B, 12 * US, 4 * US),
      videoClip(CLIP_C, 20 * US, 4 * US),
    ]),
  ];

  it('refuses (with a reason) when slowing down would run into the next clip', () => {
    load(layout());

    const result = setClipSpeed([CLIP_A], 0.5); // 10 s -> 20 s, but B starts at 12 s

    expect(result).toEqual({ ok: false, reason: 'speed change overlaps the next clip' });
    expect(findMedia(CLIP_A).timelineDurationUs, 'refusal is atomic').toBe(10 * US);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(12 * US);
    expect(historyLength()).toBe(0);
  });

  it('shrinking into free space is fine — later clips stay put by default', () => {
    load(layout());
    expect(setClipSpeed([CLIP_A], 2).ok).toBe(true);
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(5 * US);
    expect(findMedia(CLIP_B).timelineStartUs, 'no ripple was asked for').toBe(12 * US);
    expectValid();
  });

  it('ripple shifts the following clips and PRESERVES the gaps between them', () => {
    load(layout());

    expect(setClipSpeed([CLIP_A], 0.5, { ripple: true }).ok).toBe(true);

    // A grew by 10 s, so everything after it moved by exactly 10 s.
    expect(findMedia(CLIP_A).timelineDurationUs).toBe(20 * US);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(22 * US);
    expect(findMedia(CLIP_C).timelineStartUs).toBe(30 * US);
    expectValid();
  });

  it('ripple with a shrink pulls the tail back by the same delta', () => {
    load(layout());
    expect(setClipSpeed([CLIP_A], 2, { ripple: true }).ok).toBe(true);
    expect(findMedia(CLIP_B).timelineStartUs).toBe(7 * US);
    expect(findMedia(CLIP_C).timelineStartUs).toBe(15 * US);
    expectValid();
  });

  it('clips on OTHER tracks are never touched (the plan is per track)', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(A1, 'audio', [videoClip(CLIP_B, 0, 10 * US, { kind: 'audio' })]),
    ]);

    expect(setClipSpeed([CLIP_A], 2, { ripple: true }).ok).toBe(true);

    expect(findMedia(CLIP_B).timelineStartUs).toBe(0);
    expect(findMedia(CLIP_B).timelineDurationUs).toBe(10 * US);
  });

  it('planClipSpeed reports the layout WITHOUT touching the document', () => {
    load(layout());
    const plan = planClipSpeed(currentDoc(), [CLIP_A], 2, true);
    expect('reason' in plan).toBe(false);
    expect(findMedia(CLIP_A).timelineDurationUs, 'planning is pure').toBe(10 * US);
    if (!('reason' in plan)) {
      expect(plan.targetCount).toBe(1);
      expect(plan.tracks[0].clips.map((c) => c.startUs)).toEqual([0, 7 * US, 15 * US]);
    }
  });
});

// ---------------------------------------------------------------------------
// setClipSpeed — everything that hangs off the duration
// ---------------------------------------------------------------------------

describe('setClipSpeed — derived state', () => {
  it('keyframe times rescale with the new duration (invariant 4 stays satisfied)', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          keyframes: { opacity: [kf(0, 0), kf(5 * US, 1), kf(10 * US, 0)] },
        }),
      ]),
    ]);

    expect(setClipSpeed([CLIP_A], 2).ok).toBe(true);

    const kfs = findClip(CLIP_A).keyframes.opacity!;
    expect(kfs.map((k) => k.timeUs)).toEqual([0, 2.5 * US, 5 * US]);
    expect(kfs.map((k) => k.value), 'values are untouched — only time rescales').toEqual([0, 1, 0]);
    expectValid();
  });

  it('reports a NOTICE when the new length collapses two keyframes onto one instant', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          keyframes: { opacity: [kf(0, 0), kf(1, 0.5), kf(10 * US, 1)] },
        }),
      ]),
    ]);

    const result = setClipSpeed([CLIP_A], 10); // 10 s -> 1 s, so 1 us -> 0 us

    expect(result).toEqual({ ok: true, notice: SPEED_KEYFRAMES_MERGED });
    const kfs = findClip(CLIP_A).keyframes.opacity!;
    expect(kfs.map((k) => k.timeUs), 'first one wins; the array stays strictly sorted').toEqual([
      0,
      1 * US,
    ]);
    expect(kfs[0].value, 'the kept keyframe is the FIRST of the collapsed pair').toBe(0);
    expectValid();
  });

  it('re-clamps audio fades that no longer fit the shorter clip (invariant 8)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(setClipAudio([CLIP_A], { fadeInUs: 4 * US }).ok).toBe(true);
    expect(setClipAudio([CLIP_A], { fadeOutUs: 4 * US }).ok).toBe(true);

    expect(setClipSpeed([CLIP_A], 4).ok).toBe(true); // 10 s -> 2.5 s

    const audio = findMedia(CLIP_A).audio!;
    expect(audio.fadeInUs + audio.fadeOutUs).toBeLessThanOrEqual(
      findMedia(CLIP_A).timelineDurationUs,
    );
    expect(audio.fadeInUs, 'proportional shrink keeps the shape symmetric').toBe(audio.fadeOutUs);
    expectValid();
  });

  it('re-validates the transition handle: a faster clip needs MORE source slack (§5.2)', () => {
    // B starts 5 s into the asset, so it can carry a 1 s transition at rate 1
    // (handle = 0.5 s) but not at rate 10 (handle = 5 s > sourceIn... just).
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US),
        videoClip(CLIP_B, 10 * US, 10 * US, { sourceInUs: 400_000, sourceOutUs: 10_400_000 }),
      ]),
    ]);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', 800_000).ok).toBe(true);
    const before = findMedia(CLIP_A).transitionOut!;
    expect(before.durationUs).toBe(800_000);

    // Speeding B up multiplies its handle demand by the rate: 0.4 s of source
    // slack no longer covers (D/2)*4.
    const result = setClipSpeed([CLIP_B], 4, { ripple: true });

    expect(result).toEqual({ ok: true, notice: TRANSITION_SHORTENED_HANDLE });
    const after = findMedia(CLIP_A).transitionOut;
    expect(after, 'a handle shortage shortens the transition, it does not drop it').toBeDefined();
    expect(after!.durationUs, 'the transition must have been SHORTENED').toBeLessThan(800_000);
    // The stored duration must satisfy the handle rule at the NEW rate.
    expect(Math.round((after!.durationUs / 2) * 4)).toBeLessThanOrEqual(findMedia(CLIP_B).sourceInUs);
    expect(findMedia(CLIP_B).transitionIn, 'both sides stay symmetric').toEqual(after);
    expectValid();
  });

  it('a shrink that breaks adjacency drops the transition — with a notice, never silently', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US),
        videoClip(CLIP_B, 10 * US, 10 * US, { sourceInUs: 5 * US, sourceOutUs: 15 * US }),
      ]),
    ]);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', 1 * US).ok).toBe(true);

    const result = setClipSpeed([CLIP_A], 2); // no ripple -> a 5 s gap appears

    expect(result).toEqual({ ok: true, notice: TRANSITION_DROPPED });
    expect(findMedia(CLIP_A).transitionOut).toBeUndefined();
    expect(findMedia(CLIP_B).transitionIn).toBeUndefined();
    expectValid();
  });

  it('ripple keeps an adjacent cut adjacent, so the transition survives', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US),
        videoClip(CLIP_B, 10 * US, 10 * US, { sourceInUs: 5 * US, sourceOutUs: 15 * US }),
      ]),
    ]);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', 1 * US).ok).toBe(true);

    expect(setClipSpeed([CLIP_A], 2, { ripple: true }).ok).toBe(true);

    expect(findMedia(CLIP_B).timelineStartUs).toBe(5 * US);
    expect(findMedia(CLIP_A).transitionOut?.durationUs).toBe(1 * US);
    expect(findMedia(CLIP_B).transitionIn?.durationUs).toBe(1 * US);
    expectValid();
  });
});

// ---------------------------------------------------------------------------
// colorAdjust
// ---------------------------------------------------------------------------

describe('setClipColorAdjust — effect shape (invariant rule 6, §4.1)', () => {
  it('creates exactly ONE effect carrying all six params', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipColorAdjust([CLIP_A], { brightness: 0.4 })).toEqual({ ok: true });

    const clip = findClip(CLIP_A);
    expect(clip.effects).toHaveLength(1);
    const effect = clip.effects[0];
    expect(effect.type).toBe('colorAdjust');
    expect(effect.enabled).toBe(true);
    expect(Object.keys(effect.params).sort()).toEqual([...COLOR_ADJUST_KEYS].sort());
    expect(effect.params.brightness).toBe(0.4);
    expect(effect.params.saturation, 'untouched params are the §4.1 identity').toBe(0);
    expectValid();
  });

  it('a second edit REUSES the same effect (never stacks a second colorAdjust)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    setClipColorAdjust([CLIP_A], { brightness: 0.4 });
    const firstId = colorAdjustEffectOf(findClip(CLIP_A))!.id;
    setClipColorAdjust([CLIP_A], { saturation: -0.25 });

    const clip = findClip(CLIP_A);
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0].id).toBe(firstId);
    expect(clip.effects[0].params).toMatchObject({ brightness: 0.4, saturation: -0.25 });
    expectValid();
  });

  it('clamps to [-1, 1] and rounds to 3 decimals', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    setClipColorAdjust([CLIP_A], { exposure: 5, contrast: -9, tint: 0.123456 });

    const params = colorAdjustEffectOf(findClip(CLIP_A))!.params;
    expect(params.exposure).toBe(1);
    expect(params.contrast).toBe(-1);
    expect(params.tint).toBe(0.123);
    expectValid();
  });

  it('normalizes a pre-existing effect: foreign params (rule 6 killers) are dropped', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          effects: [
            {
              id: EFFECT_1,
              type: 'colorAdjust',
              enabled: true,
              // `gamma` is not in the allowed set — a document carrying it is
              // rejected WHOLESALE by the validator (and by the compiler).
              params: { brightness: 0.2, gamma: 0.5 },
            },
          ],
        }),
      ]),
    ]);

    setClipColorAdjust([CLIP_A], { contrast: 0.1 });

    const params = colorAdjustEffectOf(findClip(CLIP_A))!.params;
    expect(Object.keys(params).sort()).toEqual([...COLOR_ADJUST_KEYS].sort());
    expect(params.brightness, 'valid params survive normalization').toBe(0.2);
    expectValid();
  });

  it('merges duplicate colorAdjust effects (single-effect rule) and SAYS so', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          effects: [
            { id: EFFECT_1, type: 'colorAdjust', enabled: true, params: { brightness: 0.2 } },
            { id: EFFECT_2, type: 'colorAdjust', enabled: true, params: { brightness: -0.9 } },
          ],
        }),
      ]),
    ]);

    const result = setClipColorAdjust([CLIP_A], { saturation: 0.5 });

    expect(result).toEqual({ ok: true, notice: COLOR_ADJUST_DEDUPED });
    const clip = findClip(CLIP_A);
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0].id, 'the FIRST one is what the preview was showing').toBe(EFFECT_1);
    expect(clip.effects[0].params.brightness).toBe(0.2);
    expectValid();
  });

  it('applies to every visual clip of a multi-selection, in one history entry', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)]),
      track(OV1, 'overlay', [
        {
          id: CLIP_B,
          kind: 'shape',
          timelineStartUs: 0,
          timelineDurationUs: 5 * US,
          shape: { type: 'rect', fill: '#ff0000' },
          transform: { x: 0, y: 0, scale: 0.5, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
          keyframes: {},
          effects: [],
          opacity: 1,
        },
      ]),
    ]);

    expect(setClipColorAdjust([CLIP_A, CLIP_B], { saturation: -1 }).ok).toBe(true);

    expect(historyLength()).toBe(1);
    expect(colorAdjustEffectOf(findClip(CLIP_A))!.params.saturation).toBe(-1);
    expect(colorAdjustEffectOf(findClip(CLIP_B))!.params.saturation).toBe(-1);
    expectValid();
  });

  it('audio clips draw nothing, so colour is refused there', () => {
    load([track(A1, 'audio', [videoClip(CLIP_A, 0, 10 * US, { kind: 'audio' })])]);
    expect(setClipColorAdjust([CLIP_A], { brightness: 0.5 })).toEqual({
      ok: false,
      reason: 'no visual clip in selection',
    });
    expect(findClip(CLIP_A).effects).toHaveLength(0);
  });

  it('a locked track is left alone', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true })]);
    expect(setClipColorAdjust([CLIP_A], { brightness: 0.5 }).ok).toBe(false);
    expect(findClip(CLIP_A).effects).toHaveLength(0);
  });
});

describe('colorAdjust enable / reset', () => {
  it('the toggle creates the identity effect when there is none (never a dead control)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipColorAdjustEnabled([CLIP_A], true).ok).toBe(true);

    const effect = colorAdjustEffectOf(findClip(CLIP_A))!;
    expect(effect.enabled).toBe(true);
    expect(effect.params).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      exposure: 0,
    });
    expectValid();
  });

  it('disabling KEEPS the params (compare on/off) but stops the preview shader', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipColorAdjust([CLIP_A], { brightness: 0.3 });

    expect(setClipColorAdjustEnabled([CLIP_A], false).ok).toBe(true);

    const effect = colorAdjustEffectOf(findClip(CLIP_A))!;
    expect(effect.enabled).toBe(false);
    expect(effect.params.brightness).toBe(0.3);
    expect(colorAdjustOf(findClip(CLIP_A)), 'a disabled effect is invisible to the shader').toBeNull();
    expectValid();
  });

  it('moving a slider on a disabled effect turns it back on', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipColorAdjust([CLIP_A], { brightness: 0.3 });
    setClipColorAdjustEnabled([CLIP_A], false);

    setClipColorAdjust([CLIP_A], { brightness: 0.6 });

    expect(colorAdjustEffectOf(findClip(CLIP_A))!.enabled).toBe(true);
  });

  it('"Sıfırla" REMOVES the effect (an all-zero effect still trips the export gate)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipColorAdjust([CLIP_A], { brightness: 0.3, saturation: 0.7 });

    expect(resetClipColorAdjust([CLIP_A]).ok).toBe(true);

    expect(findClip(CLIP_A).effects).toHaveLength(0);
    expect(colorAdjustOf(findClip(CLIP_A))).toBeNull();
    expectValid();
  });

  it('undo brings the whole colour edit back in one step', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipColorAdjust([CLIP_A], { brightness: 0.3 });
    resetClipColorAdjust([CLIP_A]);

    useDocStore.getState().undo();

    expect(colorAdjustEffectOf(findClip(CLIP_A))!.params.brightness).toBe(0.3);
    expectValid();
  });
});

// ---------------------------------------------------------------------------
// The chain that actually matters: op -> document -> preview shader uniforms
// ---------------------------------------------------------------------------

describe('inspector value -> shader uniform (no drift between op and preview)', () => {
  it('colorAdjustOf reads back EXACTLY what the op wrote', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    setClipColorAdjust([CLIP_A], {
      brightness: 0.1,
      contrast: -0.2,
      saturation: 0.3,
      temperature: -0.4,
      tint: 0.5,
      exposure: -0.6,
    });

    expect(colorAdjustOf(findClip(CLIP_A))).toEqual({
      brightness: 0.1,
      contrast: -0.2,
      saturation: 0.3,
      temperature: -0.4,
      tint: 0.5,
      exposure: -0.6,
    });
  });

  it('a clip with no colorAdjust hands the compositor null (uniforms fall to identity)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(colorAdjustOf(findClip(CLIP_A))).toBeNull();
  });
});
