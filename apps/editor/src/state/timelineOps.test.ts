import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  exportFrameGridIssues,
  frameSpanCount,
  frameSpanUs,
  frameToUs,
  usToFrame,
  validateTimelineDoc,
  type MediaClip,
  type Rational,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { useEditorStore } from './editorStore';
import {
  addClipFromAsset,
  addTextClip,
  addTrack,
  clearClipboardForTests,
  copyClips,
  deleteClips,
  deleteTrack,
  duplicateBlockReason,
  duplicateClips,
  knownAssetDurations,
  moveClips,
  moveTrack,
  pasteAtPlayhead,
  pasteBlockReason,
  planMoveClips,
  renameTrack,
  splitClipAt,
  splitKeyframes,
  toggleTrackLocked,
  trackDeleteBlockReason,
  trackMoveBlockReason,
  trackRenameBlockReason,
  trimClip,
} from './timelineOps';
import { resolveVisualStack } from '../features/player/core/resolve';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const ASSET_B = '01890000-0000-7000-8000-00000000000b';
const TRACK_1 = '01890000-0000-7000-8000-000000000101';

const US = 1_000_000;
const FPS30: Rational = { num: 30, den: 1 };

function mediaClip(
  id: string,
  assetId: string,
  startUs: number,
  sourceInUs: number,
  sourceOutUs: number,
  rate = 1,
): MediaClip {
  return {
    id,
    kind: 'video',
    assetId,
    timelineStartUs: startUs,
    timelineDurationUs: clipTimelineDurationUs(sourceInUs, sourceOutUs, rate),
    sourceInUs,
    sourceOutUs,
    speed: { rate },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function docWith(tracks: Track[]): TimelineDoc {
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks };
}

function videoTrack(id: string, clips: MediaClip[]): Track {
  return { id, type: 'video', muted: false, hidden: false, locked: false, clips };
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function expectValid(): void {
  const result = validateTimelineDoc(currentDoc(), knownAssetDurations());
  expect(result.success, JSON.stringify(!result.success ? result.error.issues : null)).toBe(true);
}

beforeEach(() => {
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
    { id: ASSET_B, kind: 'video', name: 'b.mp4', status: 'ready', durationUs: 10 * US },
  ]);
  useEditorStore.getState().clearSelection();
  useEditorStore.getState().setPlayheadUs(0);
});

describe('addTrack / addClipFromAsset', () => {
  it('creates a valid MediaClip from asset metadata (sourceIn=0, sourceOut=duration, rate 1)', () => {
    const trackId = addTrack('video');
    const res = addClipFromAsset(ASSET_A, { trackId }, 2 * US);
    expect(res.ok).toBe(true);
    const clip = currentDoc().tracks[0].clips[0] as MediaClip;
    expect(clip.sourceInUs).toBe(0);
    expect(clip.sourceOutUs).toBe(10 * US);
    expect(clip.speed.rate).toBe(1);
    expect(clip.timelineStartUs).toBe(2 * US);
    expect(clip.timelineDurationUs).toBe(10 * US);
    expect(clip.audio).not.toBeNull();
    expectValid();
  });

  it('rejects overlap and track-type mismatch', () => {
    const trackId = addTrack('video');
    const audioTrackId = addTrack('audio');
    expect(addClipFromAsset(ASSET_A, { trackId }, 0).ok).toBe(true);
    const overlap = addClipFromAsset(ASSET_B, { trackId }, 5 * US);
    expect(overlap.ok).toBe(false);
    const mismatch = addClipFromAsset(ASSET_B, { trackId: audioTrackId }, 0);
    expect(mismatch.ok).toBe(false);
    expect(currentDoc().tracks[0].clips).toHaveLength(1);
    expectValid();
  });

  it('newTrack target appends a matching track', () => {
    const res = addClipFromAsset(ASSET_A, { newTrack: true }, 0);
    expect(res.ok).toBe(true);
    expect(currentDoc().tracks).toHaveLength(1);
    expect(currentDoc().tracks[0].type).toBe('video');
    expectValid();
  });

  /**
   * Real files, real numbers. ffprobe reports 7.307300 s and 12.679333 s, not
   * the round 10 s of the fixtures above — and those microsecond values are not
   * frame boundaries at ANY project rate. Before the tail snap this was the
   * shortest path to an unexportable document in the product: drop a file on the
   * timeline, hit export, get HTTP 422.
   */
  describe.each([
    { durationUs: 7_307_300, name: '7.3073 s' },
    { durationUs: 12_679_333, name: '12.679333 s' },
    { durationUs: 1, name: '1 us (shorter than a frame)' },
  ])('ffprobe duration $name', ({ durationUs }) => {
    it.each([
      { label: '30 fps', fps: { num: 30, den: 1 } },
      { label: '29.97 fps', fps: { num: 30000, den: 1001 } },
      { label: '25 fps', fps: { num: 25, den: 1 } },
      { label: '23.976 fps', fps: { num: 24000, den: 1001 } },
    ])('lands both edges on the $label grid', ({ fps }) => {
      useDocStore
        .getState()
        .loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings, fps }));
      useAssetStore.getState().setAssets([
        { id: ASSET_A, kind: 'video', name: 'real.mp4', status: 'ready', durationUs },
      ]);
      const trackId = addTrack('video');
      const res = addClipFromAsset(ASSET_A, { trackId }, 1_234_567);

      if (durationUs < frameToUs(1, fps)) {
        // Shorter than one frame: refused, never rounded up to a frame of
        // source the file does not have.
        expect(res).toEqual({ ok: false, reason: 'asset has no known duration' });
        expect(currentDoc().tracks[0].clips).toHaveLength(0);
        return;
      }

      expect(res.ok).toBe(true);
      const clip = currentDoc().tracks[0].clips[0] as MediaClip;
      // 1. both edges on the grid (the export compiler's gate),
      expect(exportFrameGridIssues(currentDoc())).toEqual([]);
      // 2. duration formula exact at rate 1, and
      expect(clip.timelineDurationUs).toBe(clip.sourceOutUs - clip.sourceInUs);
      // 3. never reads past the end of the file — the snap only shortens.
      expect(clip.sourceOutUs).toBeLessThanOrEqual(durationUs);
      expect(durationUs - clip.timelineDurationUs).toBeLessThan(frameToUs(1, fps) + 1);
      expectValid();
    });
  });
});

/**
 * Still images on the timeline.
 *
 * A photo gets a 4 s clip whose `sourceOut` the FILE knows nothing about, so an
 * "asset duration" reported for a still is a cap with no meaning behind it —
 * and the two values the server actually reports are both wrong caps:
 *
 *   PNG  -> ffprobe (png_pipe) reports NO duration -> API sends JSON `null`.
 *           `4000000 > null` is TRUE in JS, so the invariant fired on a
 *           comparison with a value that was supposed to mean "unknown".
 *   JPEG -> ffprobe (image2) reports 0.04 s -> 40000 µs, a perfectly ordinary
 *           number that caps the clip 100x below its own length.
 *
 * Both landed as `sourceOutUs (4000000) exceeds asset duration (...)` thrown by
 * assertDocValidDev AFTER the mutation had been committed, which also broke
 * selecting the clip that had just been added. `it()` bodies below therefore
 * assert on the op result AND on the validator, since a throw would fail the
 * test either way — that is the point.
 */
describe('addClipFromAsset — still images have no source time axis', () => {
  const IMAGE_PNG = '01890000-0000-7000-8000-00000000000c';
  const IMAGE_JPG = '01890000-0000-7000-8000-00000000000d';

  it('accepts a photo whose duration the server reported as null (PNG)', () => {
    useAssetStore.getState().setAssets([
      // `durationUs: null` is what the wire delivers; the type says it cannot
      // happen, which is exactly why it went unnoticed.
      {
        id: IMAGE_PNG,
        kind: 'image',
        name: 'foto.png',
        status: 'ready',
        durationUs: null as unknown as undefined,
      },
    ]);
    const trackId = addTrack('video');
    const res = addClipFromAsset(IMAGE_PNG, { trackId }, 0);
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);

    const clip = currentDoc().tracks[0].clips[0] as MediaClip;
    expect(clip.kind).toBe('image');
    expect(clip.sourceOutUs).toBe(4 * US);
    expect(clip.timelineDurationUs).toBe(4 * US);
    expect(clip.audio, 'A still carries no audio.').toBeNull();
    expectValid();
    // The clip the user just added must be selectable — the throw used to
    // abort addClipFromAsset before it ever got here.
    expect([...useEditorStore.getState().selection]).toEqual([clip.id]);
  });

  it('accepts a photo whose duration the server reported as 0.04 s (JPEG)', () => {
    useAssetStore
      .getState()
      .setAssets([
        { id: IMAGE_JPG, kind: 'image', name: 'foto.jpg', status: 'ready', durationUs: 40_000 },
      ]);
    const trackId = addTrack('video');
    const res = addClipFromAsset(IMAGE_JPG, { trackId }, 0);
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);
    expect((currentDoc().tracks[0].clips[0] as MediaClip).sourceOutUs).toBe(4 * US);
    expectValid();
  });

  it('knownAssetDurations reports no cap for stills, and still caps real media', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
      { id: IMAGE_JPG, kind: 'image', name: 'foto.jpg', status: 'ready', durationUs: 40_000 },
      {
        id: IMAGE_PNG,
        kind: 'image',
        name: 'foto.png',
        status: 'ready',
        durationUs: null as unknown as undefined,
      },
    ]);
    const durations = knownAssetDurations();
    expect(durations.has(IMAGE_JPG), 'A still must not carry a source-duration cap.').toBe(false);
    expect(durations.has(IMAGE_PNG)).toBe(false);
    expect(durations.get(ASSET_A), 'Real media still has to be capped.').toBe(10 * US);
  });

  it('drops a non-numeric duration even for a video asset (second wall)', () => {
    useAssetStore.getState().setAssets([
      {
        id: ASSET_A,
        kind: 'video',
        name: 'a.mp4',
        status: 'ready',
        durationUs: null as unknown as undefined,
      },
    ]);
    expect(knownAssetDurations().has(ASSET_A)).toBe(false);
  });
});

describe('deleteTrack', () => {
  const TRACK_2 = '01890000-0000-7000-8000-000000000102';
  const AUDIO_TRACK = '01890000-0000-7000-8000-000000000103';

  function audioTrack(id: string): Track {
    return { id, type: 'audio', muted: false, hidden: false, locked: false, clips: [] };
  }

  it('deletes the track together with its clips and keeps the document valid', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3 * US, 0, 2 * US);
    useDocStore
      .getState()
      .loadDoc(docWith([videoTrack(TRACK_1, [c1, c2]), videoTrack(TRACK_2, [])]));

    const res = deleteTrack(TRACK_1);
    expect(res.ok).toBe(true);
    expect(currentDoc().tracks).toHaveLength(1);
    expect(currentDoc().tracks[0].id).toBe(TRACK_2);
    expectValid();
  });

  it('is a single undoable history entry that restores the clips', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, US, 0, 2 * US);
    useDocStore
      .getState()
      .loadDoc(docWith([videoTrack(TRACK_1, [c1]), videoTrack(TRACK_2, [])]));

    deleteTrack(TRACK_1);
    expect(useDocStore.getState().history).toHaveLength(1);

    useDocStore.getState().undo();
    expect(currentDoc().tracks).toHaveLength(2);
    expect(currentDoc().tracks[0].id).toBe(TRACK_1);
    expect(currentDoc().tracks[0].clips).toHaveLength(1);
    expect(currentDoc().tracks[0].clips[0].timelineStartUs).toBe(US);
    expectValid();

    useDocStore.getState().redo();
    expect(currentDoc().tracks).toHaveLength(1);
    expectValid();
  });

  it('refuses the last video track (doc unchanged, no history entry)', () => {
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, []), audioTrack(AUDIO_TRACK)]));
    const before = JSON.stringify(currentDoc());

    const res = deleteTrack(TRACK_1);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('cannot delete the last video track');
    expect(JSON.stringify(currentDoc())).toBe(before);
    expect(useDocStore.getState().history).toHaveLength(0);

    // Aynı dokümanda ses track'i silinebilir.
    expect(deleteTrack(AUDIO_TRACK).ok).toBe(true);
    expectValid();
  });

  it('refuses a locked track and an unknown id', () => {
    useDocStore
      .getState()
      .loadDoc(docWith([videoTrack(TRACK_1, []), videoTrack(TRACK_2, [])]));
    toggleTrackLocked(TRACK_2);
    const historyBefore = useDocStore.getState().history.length;

    expect(deleteTrack(TRACK_2).ok).toBe(false);
    expect(deleteTrack('01890000-0000-7000-8000-0000000009ff').ok).toBe(false);
    expect(useDocStore.getState().history).toHaveLength(historyBefore);
    expect(currentDoc().tracks).toHaveLength(2);
  });

  it('drops the deleted track clips from the selection', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 0, 0, 2 * US);
    useDocStore
      .getState()
      .loadDoc(docWith([videoTrack(TRACK_1, [c1]), videoTrack(TRACK_2, [c2])]));
    useEditorStore.getState().setSelection([c1.id, c2.id]);

    deleteTrack(TRACK_1);
    expect([...useEditorStore.getState().selection]).toEqual([c2.id]);
  });

  it('trackDeleteBlockReason mirrors the op guards (menu disabled state)', () => {
    const doc = docWith([videoTrack(TRACK_1, []), videoTrack(TRACK_2, []), audioTrack(AUDIO_TRACK)]);
    expect(trackDeleteBlockReason(doc, TRACK_1)).toBeNull();
    expect(trackDeleteBlockReason(doc, AUDIO_TRACK)).toBeNull();
    expect(trackDeleteBlockReason(doc, 'missing')).toBe('track not found');

    const single = docWith([videoTrack(TRACK_1, [])]);
    expect(trackDeleteBlockReason(single, TRACK_1)).toBe('cannot delete the last video track');

    const locked = docWith([
      videoTrack(TRACK_1, []),
      { ...videoTrack(TRACK_2, []), locked: true },
    ]);
    expect(trackDeleteBlockReason(locked, TRACK_2)).toBe('track is locked');
  });
});

describe('moveClips', () => {
  it('moves multiple clips by a uniform delta, preserving relative positions', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));

    const res = moveClips([c1.id, c2.id], 2 * US);
    expect(res.ok).toBe(true);
    const clips = currentDoc().tracks[0].clips;
    expect(clips[0].timelineStartUs).toBe(2 * US);
    expect(clips[1].timelineStartUs).toBe(5 * US);
    expect(clips[1].timelineStartUs - clips[0].timelineStartUs).toBe(3 * US);
    expectValid();
  });

  it('rejects a move that would overlap a stationary clip (doc unchanged, no history entry)', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    const before = JSON.stringify(currentDoc());
    const historyBefore = useDocStore.getState().history.length;

    const res = moveClips([c1.id], 2 * US); // c1 would cover [2s,4s) — overlaps c2 at 3s
    expect(res.ok).toBe(false);
    expect(JSON.stringify(currentDoc())).toBe(before);
    expect(useDocStore.getState().history).toHaveLength(historyBefore);
    expectValid();
  });

  it('rejects negative start and locked tracks', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    expect(moveClips([c1.id], -2 * US).ok).toBe(false);
    toggleTrackLocked(TRACK_1);
    expect(moveClips([c1.id], US).ok).toBe(false);
  });

  it('rejects a vertical move onto a track of a different type', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const audioTrack: Track = {
      id: '01890000-0000-7000-8000-000000000102',
      type: 'audio', muted: false, hidden: false, locked: false, clips: [],
    };
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1]), audioTrack]));
    const plan = planMoveClips(currentDoc(), [c1.id], 0, 1);
    expect(plan.ok).toBe(false);
  });

  it('is undoable as a single history entry', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    moveClips([c1.id], 4 * US);
    expect(useDocStore.getState().history).toHaveLength(1);
    useDocStore.getState().undo();
    expect(currentDoc().tracks[0].clips[0].timelineStartUs).toBe(0);
    expectValid();
  });

  it('snaps the reference clip target start to the project fps grid (finding 6)', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    const res = moveClips([c1.id], 50_000); // 1.5 frames at 30 fps -> rounds to frame 2
    expect(res.ok).toBe(true);
    expect(currentDoc().tracks[0].clips[0].timelineStartUs).toBe(66_667);
    expectValid();
  });

  it('multi-select: the selection shifts by the anchor FRAME delta and both clips stay on the grid', () => {
    // The grid is not closed under addition at 30 fps (frame 1 = 33_333 us,
    // frame 2 = 66_667 us), so a uniform MICROSECOND delta pushes the
    // non-anchor clip off the grid — the export compiler rejects exactly that
    // (HTTP 422) even though the document saves fine. The delta is therefore
    // applied in FRAMES, and each clip is re-fitted to the grid at its new
    // start (see refitToGrid).
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    // c2: frame 91 (3_033_333 us), 61 frames long -> ends on frame 152
    // (5_066_667 us), i.e. 2_033_334 us — a length that is NOT a grid value.
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3_033_333, 0, 2_033_334);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    expect(exportFrameGridIssues(currentDoc())).toEqual([]);

    const res = moveClips([c1.id, c2.id], 50_000); // 1.5 frames -> +2 frames
    expect(res.ok).toBe(true);
    const clips = currentDoc().tracks[0].clips;
    expect(clips[0].timelineStartUs).toBe(66_667); // snapped anchor (frame 2)
    expect(clips[1].timelineStartUs).toBe(3_100_000); // frame 93 = 91 + 2
    // Relative offset preserved in FRAMES — the unit the export ledger counts.
    expect(usToFrame(clips[1].timelineStartUs, FPS30) - usToFrame(clips[0].timelineStartUs, FPS30))
      .toBe(91);
    // ... and the frame SPAN of each clip is unchanged, its microsecond length
    // re-fitted (2_033_334 -> 2_033_333) with the source window following it so
    // the duration formula stays exact.
    expect(usToFrame(clips[1].timelineStartUs + clips[1].timelineDurationUs, FPS30)).toBe(154);
    expect(clips[1].timelineDurationUs).toBe(2_033_333);
    expect((clips[1] as MediaClip).sourceOutUs).toBe(2_033_333);
    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();
  });

  it('a clip that is already off the grid (legacy document) keeps the raw delta', () => {
    // Nothing can put such a clip back on the grid without moving it somewhere
    // the user did not ask for, so the plan keeps the old behaviour verbatim.
    // Planned, not committed: the op's dev assert would (correctly) refuse to
    // hand back a document the compiler rejects.
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3 * US + 11, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    const plan = planMoveClips(currentDoc(), [c1.id, c2.id], 50_000);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.moves[0].newStartUs).toBe(66_667);
    expect(plan.moves[1].newStartUs).toBe(3 * US + 11 + 66_667);
  });

  it('a delta that snaps to zero is a no-op that leaves no history entry', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    const res = moveClips([c1.id], 10_000); // < half a frame -> snaps back to 0
    expect(res.ok).toBe(true);
    expect(useDocStore.getState().history).toHaveLength(0);
    expect(currentDoc().tracks[0].clips[0].timelineStartUs).toBe(0);
  });
});

describe('trimClip', () => {
  it('normal right trim adjusts sourceOut and keeps the duration formula exact', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 6 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    const res = trimClip(c1.id, 'right', 4 * US);
    expect(res.ok).toBe(true);
    const clip = currentDoc().tracks[0].clips[0] as MediaClip;
    expect(clip.sourceOutUs).toBe(4 * US);
    expect(clip.timelineDurationUs).toBe(
      clipTimelineDurationUs(clip.sourceInUs, clip.sourceOutUs, clip.speed.rate),
    );
    expectValid();
  });

  it('normal right trim clamps at the next clip and at the asset duration', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 6 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 8 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    trimClip(c1.id, 'right', 12 * US); // wants 12s; next clip starts at 8s
    const clip = currentDoc().tracks[0].clips[0] as MediaClip;
    expect(clip.timelineStartUs + clip.timelineDurationUs).toBe(8 * US);
    expect(clip.sourceOutUs).toBe(8 * US); // still within the 10s asset
    expectValid();
  });

  it('normal left trim keeps the end anchored and shifts sourceIn', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 2 * US, 1 * US, 7 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    trimClip(c1.id, 'left', 4 * US);
    const clip = currentDoc().tracks[0].clips[0] as MediaClip;
    expect(clip.timelineStartUs).toBe(4 * US);
    expect(clip.sourceInUs).toBe(3 * US);
    expect(clip.timelineStartUs + clip.timelineDurationUs).toBe(8 * US); // end unchanged
    expectValid();
  });

  it('ripple right trim shifts all following clips by the edge delta', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 10 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 10 * US, 0, 4 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    trimClip(c1.id, 'right', 8 * US, 'ripple');
    const clips = currentDoc().tracks[0].clips;
    expect(clips[0].timelineDurationUs).toBe(8 * US);
    expect(clips[1].timelineStartUs).toBe(8 * US); // moved left by 2s with the edge
    expectValid();
  });

  it('ripple left trim keeps the start fixed and closes the gap for followers', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 6 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 6 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    trimClip(c1.id, 'left', 2 * US, 'ripple');
    const clips = currentDoc().tracks[0].clips as MediaClip[];
    expect(clips[0].timelineStartUs).toBe(0);
    expect(clips[0].sourceInUs).toBe(2 * US);
    expect(clips[0].timelineDurationUs).toBe(4 * US);
    expect(clips[1].timelineStartUs).toBe(4 * US);
    expectValid();
  });

  it('roll trim moves the shared cut, preserving the combined span', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 6 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 6 * US, 0, 6 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    const res = trimClip(c1.id, 'right', 8 * US, 'roll');
    expect(res.ok).toBe(true);
    const clips = currentDoc().tracks[0].clips as MediaClip[];
    expect(clips[0].timelineDurationUs).toBe(8 * US);
    expect(clips[0].sourceOutUs).toBe(8 * US);
    expect(clips[1].timelineStartUs).toBe(8 * US);
    expect(clips[1].sourceInUs).toBe(2 * US);
    // Combined span unchanged: 0 .. 12s.
    expect(clips[1].timelineStartUs + clips[1].timelineDurationUs).toBe(12 * US);
    expectValid();
  });

  it('respects the one-frame minimum duration', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    trimClip(c1.id, 'right', 0); // absurd target
    const clip = currentDoc().tracks[0].clips[0];
    expect(clip.timelineDurationUs).toBeGreaterThanOrEqual(33_333); // 1 frame at 30fps
    expectValid();
  });
});

describe('splitClipAt', () => {
  it('splits with exact source continuity and duration invariants', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 10 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    const res = splitClipAt(c1.id, 4 * US);
    expect(res.ok).toBe(true);
    const clips = currentDoc().tracks[0].clips as MediaClip[];
    expect(clips).toHaveLength(2);
    const [a, b] = clips;
    expect(a.sourceOutUs).toBe(b.sourceInUs); // source continuity
    expect(a.timelineStartUs + a.timelineDurationUs).toBe(b.timelineStartUs); // adjacency
    expect(a.timelineDurationUs + b.timelineDurationUs).toBe(10 * US);
    expect(a.timelineDurationUs).toBe(
      clipTimelineDurationUs(a.sourceInUs, a.sourceOutUs, a.speed.rate),
    );
    expect(b.timelineDurationUs).toBe(
      clipTimelineDurationUs(b.sourceInUs, b.sourceOutUs, b.speed.rate),
    );
    expectValid();
  });

  it('rejects a split outside the clip', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 2 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    expect(splitClipAt(c1.id, US).ok).toBe(false);
    expect(splitClipAt(c1.id, 5 * US).ok).toBe(false);
    expect(currentDoc().tracks[0].clips).toHaveLength(1);
  });

  it('divides keyframes and writes the interpolated boundary value to both parts', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 10 * US);
    c1.keyframes = {
      opacity: [
        { timeUs: 0, value: 0, easing: { type: 'linear' } },
        { timeUs: 8 * US, value: 1, easing: { type: 'linear' } },
      ],
    };
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    splitClipAt(c1.id, 4 * US);
    const [a, b] = currentDoc().tracks[0].clips as MediaClip[];

    const aKfs = a.keyframes.opacity!;
    expect(aKfs[aKfs.length - 1].timeUs).toBe(4 * US);
    expect(aKfs[aKfs.length - 1].value).toBeCloseTo(0.5, 6);

    const bKfs = b.keyframes.opacity!;
    expect(bKfs[0].timeUs).toBe(0);
    expect(bKfs[0].value).toBeCloseTo(0.5, 6);
    expect(bKfs[bKfs.length - 1].timeUs).toBe(4 * US); // 8s rebased to B-local 4s
    expect(bKfs[bKfs.length - 1].value).toBe(1);
    expectValid();
  });

  it('splitKeyframes keeps an exact keyframe at the cut on side A and mirrors its value to B', () => {
    const kfs = [
      { timeUs: 0, value: 0, easing: { type: 'linear' } as const },
      { timeUs: 2 * US, value: 5, easing: { type: 'easeIn' } as const },
      { timeUs: 4 * US, value: 9, easing: { type: 'linear' } as const },
    ];
    const { a, b } = splitKeyframes(kfs, 2 * US, 2 * US);
    expect(a[a.length - 1]).toMatchObject({ timeUs: 2 * US, value: 5 });
    expect(b[0]).toMatchObject({ timeUs: 0, value: 5, easing: { type: 'easeIn' } });
    expect(b[1]).toMatchObject({ timeUs: 2 * US, value: 9 });
  });
});

describe('deleteClips', () => {
  it('normal delete leaves a gap', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 4 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 6 * US, 0, 4 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));
    deleteClips([c1.id]);
    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].timelineStartUs).toBe(6 * US); // untouched
    expectValid();
  });

  it('ripple delete closes the removed clip span for following clips', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 4 * US);
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 6 * US, 0, 4 * US);
    const c3 = mediaClip('01890000-0000-7000-8000-000000000203', ASSET_A, 10 * US, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2, c3])]));
    deleteClips([c2.id], { ripple: true });
    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[0].timelineStartUs).toBe(0);
    expect(clips[1].timelineStartUs).toBe(6 * US); // 10s - removed 4s
    expectValid();
  });

  it('removes deleted clips from the selection', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 4 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1])]));
    useEditorStore.getState().setSelection([c1.id]);
    deleteClips([c1.id]);
    expect(useEditorStore.getState().selection.size).toBe(0);
  });
});

/**
 * Ctrl+D / Ctrl+V kare-ızgara disiplini (BG-1 regresyonu).
 *
 * 30 fps'te ızgara toplama altında kapalı değildir: kare süresi mikrosaniye
 * cinsinden 33_333/33_334 arasında salınır ve kalıntı ancak 3 karede bir
 * kapanır. 140 kare (3'e bölünmeyen) bir klibin süresi 4_666_667 us'tur; kopya
 * bu HAM süre ofsetiyle yerleştirilirse kendi SONU ızgaradan 1 us sapar
 * (9_333_334, en yakın kare 9_333_333) — belge kaydedilir (PUT 200) ama export
 * 422 ile reddeder. Kopyalar bu yüzden KARE yürüyüşüyle yerleşir ve
 * refitToGrid'ten geçer: kare SAYISI korunur, süre ızgaradan türetilir, medya
 * klibinde kaynak penceresi süreyi izler.
 */
describe('duplicate/paste — frame grid discipline (140 frames @ 30 fps)', () => {
  const C1 = '01890000-0000-7000-8000-000000000201';
  const C2 = '01890000-0000-7000-8000-000000000202';
  const NEIGHBOUR = '01890000-0000-7000-8000-000000000203';
  const F140 = frameToUs(140, FPS30); // 4_666_667 — 140 kare, 3'e bölünmez

  function load140FrameClip(extra: MediaClip[] = []): void {
    useDocStore
      .getState()
      .loadDoc(docWith([videoTrack(TRACK_1, [mediaClip(C1, ASSET_A, 0, 0, F140), ...extra])]));
  }

  beforeEach(() => clearClipboardForTests());

  it('duplicate lands both edges of the copy on the grid (frame count preserved)', () => {
    load140FrameClip();
    const res = duplicateClips([C1]);
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);

    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(2);
    const dup = clips[1] as MediaClip;
    // Kopya seçimin hemen ardında: kare 140'ta başlar...
    expect(dup.timelineStartUs).toBe(F140);
    // ...ve SONU kare 280'in tam sınırında biter (ham ofset 9_333_334 verirdi).
    expect(dup.timelineStartUs + dup.timelineDurationUs).toBe(frameToUs(280, FPS30));
    // Kare SAYISI korunur; mikrosaniye süresi bu başlangıçta 1 us kısadır.
    expect(frameSpanCount(dup.timelineStartUs, dup.timelineDurationUs, FPS30)).toBe(140);
    expect(dup.timelineDurationUs).toBe(F140 - 1);
    // Kaynak penceresi süreyi izler (kural 3 mikrosaniyesine kadar kesin).
    expect(dup.sourceOutUs - dup.sourceInUs).toBe(dup.timelineDurationUs);
    // Orijinal klibe dokunulmaz.
    const original = clips[0] as MediaClip;
    expect(original.timelineStartUs).toBe(0);
    expect(original.timelineDurationUs).toBe(F140);
    expect(original.sourceOutUs).toBe(F140);

    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();

    // Tek undo girdisi: geri alınca kopya kaybolur, belge yine iki kapıdan geçer.
    useDocStore.getState().undo();
    expect(currentDoc().tracks[0].clips).toHaveLength(1);
    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();
  });

  it('paste at an off-grid playhead snaps the base and keeps every edge on the grid', () => {
    load140FrameClip();
    expect(copyClips([C1])).toBe(true);

    // Menü grisi ile op reddi AYNI plandan gelir: yapıştırma serbest olmalı.
    expect(pasteBlockReason(currentDoc(), frameToUs(152, FPS30))).toBeNull();

    // Kullanıcı cetvelde kare arasına tıklamış olsun (152. karenin 33 us sağı).
    const res = pasteAtPlayhead(frameToUs(152, FPS30) + 33);
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);

    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(2);
    const pasted = clips[1] as MediaClip;
    expect(pasted.timelineStartUs).toBe(frameToUs(152, FPS30)); // 5_066_667
    // Ham ofset sonu 9_733_334'e taşırdı; kare yürüyüşü 292. kare sınırında bitirir.
    expect(pasted.timelineStartUs + pasted.timelineDurationUs).toBe(frameToUs(292, FPS30));
    expect(frameSpanCount(pasted.timelineStartUs, pasted.timelineDurationUs, FPS30)).toBe(140);
    expect(pasted.sourceOutUs - pasted.sourceInUs).toBe(pasted.timelineDurationUs);

    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();

    useDocStore.getState().undo();
    expect(currentDoc().tracks[0].clips).toHaveLength(1);
    expectValid();
  });

  it('multi-clip paste keeps the batch offsets in FRAMES', () => {
    // C2, C1'in bittiği karenin 1 kare sağında: kare 141, 10 kare uzunlukta.
    const start2 = frameToUs(141, FPS30);
    load140FrameClip([mediaClip(C2, ASSET_B, start2, 0, frameSpanUs(start2, 10, FPS30))]);
    expect(copyClips([C1, C2])).toBe(true);

    const res = pasteAtPlayhead(frameToUs(152, FPS30));
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);

    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(4);
    const [pasted1, pasted2] = clips.slice(2) as MediaClip[];
    // İlk kopya tam yapıştırma noktasında; ikincisi 141 KARE ofsetini korur
    // (mikrosaniye ofseti değil — 30 fps'te ikisi aynı şey değildir).
    expect(pasted1.timelineStartUs).toBe(frameToUs(152, FPS30));
    expect(pasted2.timelineStartUs).toBe(frameToUs(152 + 141, FPS30));
    expect(frameSpanCount(pasted1.timelineStartUs, pasted1.timelineDurationUs, FPS30)).toBe(140);
    expect(frameSpanCount(pasted2.timelineStartUs, pasted2.timelineDurationUs, FPS30)).toBe(10);

    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();
  });

  it('menu and op agree: the refit duplicate fits EXACTLY against a neighbour on frame 280', () => {
    // Komşu tam kare 280'de başlar. Ham yerleşim kopyanın sonunu 9_333_334'e
    // taşıyıp 1 us'lik sahte çakışmayla reddederdi; refit'li yerleşim tam oturur.
    const nStart = frameToUs(280, FPS30);
    load140FrameClip([mediaClip(NEIGHBOUR, ASSET_B, nStart, 0, frameSpanUs(nStart, 30, FPS30))]);

    expect(duplicateBlockReason(currentDoc(), [C1])).toBeNull();
    const res = duplicateClips([C1]);
    expect(res.ok, !res.ok ? res.reason : '').toBe(true);

    const clips = currentDoc().tracks[0].clips;
    expect(clips).toHaveLength(3);
    // Kopya [kare 140, kare 280) aralığını doldurur, komşuya değmez.
    expect(clips[1].timelineStartUs + clips[1].timelineDurationUs).toBe(nStart);
    expect(exportFrameGridIssues(currentDoc())).toEqual([]);
    expectValid();
  });
});

// ---------------------------------------------------------------------------
// Track yeniden siralama + adlandirma (tek kapi: moveTrack / renameTrack)
// ---------------------------------------------------------------------------

describe('moveTrack / renameTrack', () => {
  const T2 = '01890000-0000-7000-8000-000000000102';
  const C_TOP = '01890000-0000-7000-8000-000000000201';
  const C_BOTTOM = '01890000-0000-7000-8000-000000000202';

  function loadTwoTracks(over: { lockTop?: boolean } = {}): void {
    const top = videoTrack(TRACK_1, [mediaClip(C_TOP, ASSET_A, 0, 0, 2 * US)]);
    if (over.lockTop) top.locked = true;
    const bottom = videoTrack(T2, [mediaClip(C_BOTTOM, ASSET_B, 0, 0, 2 * US)]);
    useDocStore.getState().loadDoc(docWith([top, bottom]));
  }

  it('moveTrack down/up splices the array and stays undoable with Turkish labels', () => {
    loadTwoTracks();
    const down = moveTrack(TRACK_1, 'down');
    expect(down.ok, !down.ok ? down.reason : '').toBe(true);
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([T2, TRACK_1]);
    expect(useDocStore.getState().history.at(-1)?.label).toBe('Track aşağı taşındı');

    const up = moveTrack(TRACK_1, 'up');
    expect(up.ok).toBe(true);
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([TRACK_1, T2]);
    expect(useDocStore.getState().history.at(-1)?.label).toBe('Track yukarı taşındı');

    useDocStore.getState().undo();
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([T2, TRACK_1]);
    useDocStore.getState().undo();
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([TRACK_1, T2]);
    expectValid();
  });

  it('refuses the edges and locked tracks with the SAME reasons the menu shows', () => {
    loadTwoTracks();
    expect(trackMoveBlockReason(currentDoc(), TRACK_1, 'up')).toBe('track already at the top');
    expect(trackMoveBlockReason(currentDoc(), T2, 'down')).toBe('track already at the bottom');
    const upTop = moveTrack(TRACK_1, 'up');
    expect(upTop).toEqual({ ok: false, reason: 'track already at the top' });
    const downBottom = moveTrack(T2, 'down');
    expect(downBottom).toEqual({ ok: false, reason: 'track already at the bottom' });

    loadTwoTracks({ lockTop: true });
    expect(trackMoveBlockReason(currentDoc(), TRACK_1, 'down')).toBe('track is locked');
    expect(moveTrack(TRACK_1, 'down')).toEqual({ ok: false, reason: 'track is locked' });
    // Kilit yalniz TASINAN track'i baglar: kilitsiz komsu serbestce tasinir.
    expect(moveTrack(T2, 'up').ok).toBe(true);
  });

  it('reorder CHANGES the render layer order (tracks[0] = top; resolveVisualStack draws back-to-front)', () => {
    loadTwoTracks();
    // Iki gorsel klip ayni anda (t=1s) ust uste: yigin ALTTAN USTE siralanir,
    // tracks[0] klibi EN SON (en ustte) gelir - export derleyicisinin katman
    // sozlesmesinin onizleme yarisi.
    const before = resolveVisualStack(currentDoc(), 1 * US).map((a) => a.clip.id);
    expect(before).toEqual([C_BOTTOM, C_TOP]);

    expect(moveTrack(TRACK_1, 'down').ok).toBe(true);

    const after = resolveVisualStack(currentDoc(), 1 * US).map((a) => a.clip.id);
    expect(after).toEqual([C_TOP, C_BOTTOM]);
    // Ayni belge export tarafinda da ayni siradan derlenir (ExportCompiler
    // doc.Tracks dizisini sirayla okur) - graf karsilastirmasi icin bkz.
    // scratchpad kosumu raporu: reorder oncesi/sonrasi filtergraph overlay
    // sirasi yer degistirir.
    expectValid();
  });

  it('renameTrack trims, clamps to 200 chars, clears on empty, and refuses locked', () => {
    loadTwoTracks();
    expect(renameTrack(TRACK_1, '  Ana kurgu  ').ok).toBe(true);
    expect(currentDoc().tracks[0].name).toBe('Ana kurgu');
    expect(useDocStore.getState().history.at(-1)?.label).toContain('adland');

    const long = 'x'.repeat(300);
    expect(renameTrack(TRACK_1, long).ok).toBe(true);
    expect(currentDoc().tracks[0].name).toHaveLength(200);

    // Bos ad = ozel adi SIL (basliga turetilmis etiket doner).
    expect(renameTrack(TRACK_1, '   ').ok).toBe(true);
    expect(currentDoc().tracks[0].name).toBeUndefined();

    // Ayni ada yeniden adlandirma no-op'tur: gecmis kirlenmez.
    expect(renameTrack(TRACK_1, '').ok).toBe(true);
    const historyLen = useDocStore.getState().history.length;
    expect(renameTrack(TRACK_1, '  ').ok).toBe(true);
    expect(useDocStore.getState().history).toHaveLength(historyLen);

    loadTwoTracks({ lockTop: true });
    expect(renameTrack(TRACK_1, 'yeni ad')).toEqual({ ok: false, reason: 'track is locked' });
    expect(trackRenameBlockReason(currentDoc(), TRACK_1)).toBe('track is locked');
    expect(currentDoc().tracks[0].name).toBeUndefined();
    expectValid();
  });

  it('rename is undoable and validates against the schema (name max 200)', () => {
    loadTwoTracks();
    expect(renameTrack(T2, 'Muzik').ok).toBe(true);
    expectValid();
    useDocStore.getState().undo();
    expect(currentDoc().tracks[1].name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Track partisyonu (ozellik-1): video/overlay ustte, ses altta - OP POLITIKASI
// (insertTrackPositioned + trackMoveBlockReason partisyon kapisi). Dokuman
// INVARIANTI degildir: karisik eski belge yuklenir, otomatik normalize YOKTUR.
// ---------------------------------------------------------------------------

describe('track partition (video above, audio below)', () => {
  const AUDIO_ASSET = '01890000-0000-7000-8000-00000000000c';

  function audioTrack(id: string): Track {
    return { id, type: 'audio', muted: false, hidden: false, locked: false, clips: [] };
  }

  function trackTypes(): string[] {
    return currentDoc().tracks.map((t) => t.type);
  }

  it('addTrack(video) lands in FRONT of the audio section, audio appends below', () => {
    const audioId = addTrack('audio');
    const videoId = addTrack('video');
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([videoId, audioId]);

    // Ikinci ses track'i EN ALTA, ikinci video track'i ses bolumunun ONUNE.
    const audio2 = addTrack('audio');
    const video2 = addTrack('video');
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([videoId, video2, audioId, audio2]);
    expectValid();
  });

  it('addTrack(overlay) also lands in front of the audio section', () => {
    addTrack('audio');
    addTrack('overlay');
    expect(trackTypes()).toEqual(['overlay', 'audio']);
    expectValid();
  });

  it('addClipFromAsset newTrack: the fresh VIDEO track is born ABOVE the audio section', () => {
    const audioId = addTrack('audio');
    const res = addClipFromAsset(ASSET_A, { newTrack: true }, 0);
    expect(res.ok).toBe(true);
    expect(trackTypes()).toEqual(['video', 'audio']);
    expect(currentDoc().tracks[1].id).toBe(audioId);
    expectValid();
  });

  it('addClipFromAsset newTrack: a fresh AUDIO track still appends at the bottom', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
      { id: AUDIO_ASSET, kind: 'audio', name: 'c.mp3', status: 'ready', durationUs: 6 * US },
    ]);
    addTrack('video');
    const res = addClipFromAsset(AUDIO_ASSET, { newTrack: true }, 0);
    expect(res.ok).toBe(true);
    expect(trackTypes()).toEqual(['video', 'audio']);
    expectValid();
  });

  it('a fresh overlay lane (newTrack clip add) stays on TOP - above video AND audio', () => {
    addTrack('video');
    addTrack('audio');
    const res = addTextClip(
      {
        content: 'Merhaba',
        fontId: 'inter-v1',
        fontSizePx: 48,
        fontWeight: 700,
        italic: false,
        fill: '#ffffff',
        align: 'center',
        lineHeight: 1.2,
      },
      { newTrack: true },
      0,
    );
    expect(res.ok).toBe(true);
    expect(trackTypes()).toEqual(['overlay', 'video', 'audio']);
    expectValid();
  });

  it('blocks the swap that would lift an audio track above a non-audio track', () => {
    const audioId = addTrack('audio');
    const videoId = addTrack('video'); // -> [video, audio]
    expect(trackMoveBlockReason(currentDoc(), audioId, 'up')).toBe(
      'audio tracks stay below video tracks',
    );
    expect(moveTrack(audioId, 'up')).toEqual({
      ok: false,
      reason: 'audio tracks stay below video tracks',
    });
    expect(trackMoveBlockReason(currentDoc(), videoId, 'down')).toBe(
      'audio tracks stay below video tracks',
    );
    expect(moveTrack(videoId, 'down')).toEqual({
      ok: false,
      reason: 'audio tracks stay below video tracks',
    });
    expect(currentDoc().tracks.map((t) => t.id)).toEqual([videoId, audioId]);
    expect(useDocStore.getState().history.map((h) => h.label)).not.toContain('Track aşağı taşındı');
  });

  it('the CORRECTIVE direction stays free in a mixed legacy document', () => {
    // Karisik eski belge: ses USTTE dogmus (partisyon oncesi kayit) - yuklenir.
    const AUDIO_ID = '01890000-0000-7000-8000-000000000104';
    useDocStore.getState().loadDoc(docWith([audioTrack(AUDIO_ID), videoTrack(TRACK_1, [])]));
    // Duzeltici yon serbest: ses asagi / video yukari.
    expect(trackMoveBlockReason(currentDoc(), AUDIO_ID, 'down')).toBeNull();
    expect(moveTrack(AUDIO_ID, 'down').ok).toBe(true);
    expect(trackTypes()).toEqual(['video', 'audio']);
    // Duzeltildikten sonra ihlal yonu artik kapali.
    expect(trackMoveBlockReason(currentDoc(), AUDIO_ID, 'up')).toBe(
      'audio tracks stay below video tracks',
    );
  });

  it('audio<->audio swaps stay free, and lock/edge rules keep their precedence', () => {
    const A1 = addTrack('audio');
    const A2 = addTrack('audio');
    addTrack('video'); // -> [video, A1, A2]
    expect(trackMoveBlockReason(currentDoc(), A2, 'up')).toBeNull();
    expect(moveTrack(A2, 'up').ok).toBe(true);
    expect(currentDoc().tracks.map((t) => t.id).slice(1)).toEqual([A2, A1]);

    // Kilit, partisyondan ONCE konusur (mevcut kural bozulmadi).
    toggleTrackLocked(A2);
    expect(trackMoveBlockReason(currentDoc(), A2, 'up')).toBe('track is locked');
    // Kenar kurali da partisyondan once: en alttaki ses 'down' icin kenari soyler.
    expect(trackMoveBlockReason(currentDoc(), A1, 'down')).toBe('track already at the bottom');
  });
});
