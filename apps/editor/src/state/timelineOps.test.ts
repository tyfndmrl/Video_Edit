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
  AUDIO_PLACED_ON_NEW_TRACK,
  MAX_TRACKS,
  addClipFromAsset,
  addTextClip,
  addTrack,
  clearClipboardForTests,
  copyClips,
  deleteBlockReason,
  deleteClips,
  deleteTrack,
  detachAudio,
  detachAudioBlockReason,
  duplicateBlockReason,
  duplicateClips,
  expandSelectionForOp,
  knownAssetDurations,
  linkBlockReason,
  linkClips,
  moveClips,
  moveTrack,
  pasteAtPlayhead,
  pasteBlockReason,
  planAddClipFromAsset,
  planMoveClips,
  renameTrack,
  splitAtPlayhead,
  splitClipAt,
  splitKeyframes,
  toggleTrackLocked,
  trackDeleteBlockReason,
  trackMoveBlockReason,
  trackRenameBlockReason,
  trimClip,
  unlinkBlockReason,
  unlinkClips,
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

// ---------------------------------------------------------------------------
// AV bağı (linkId) çekirdeği — ozellik-2
// ---------------------------------------------------------------------------

describe('linkId core (ozellik-2)', () => {
  const V1 = '01890000-0000-7000-8000-000000000301';
  const V2 = '01890000-0000-7000-8000-000000000302';
  const A1 = '01890000-0000-7000-8000-000000000303';
  const O1 = '01890000-0000-7000-8000-000000000304';
  const VID = '01890000-0000-7000-8000-000000000311';
  const AUD = '01890000-0000-7000-8000-000000000312';
  const OTHER = '01890000-0000-7000-8000-000000000313';
  const AUD2 = '01890000-0000-7000-8000-000000000314';
  const L1 = '01890000-0000-7000-8000-000000000401';
  const G1 = '01890000-0000-7000-8000-000000000501';
  const G2 = '01890000-0000-7000-8000-000000000502';

  function clipOf(
    id: string,
    kind: 'video' | 'audio',
    startUs: number,
    durationUs: number,
    extra: Partial<MediaClip> = {},
  ): MediaClip {
    return { ...mediaClip(id, ASSET_A, startUs, 0, durationUs), kind, ...extra };
  }

  function trackOf(
    id: string,
    type: Track['type'],
    clips: MediaClip[],
    flags: Partial<Track> = {},
  ): Track {
    return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
  }

  /** V1 [VID 0..4s] + A1 [AUD 0..4s], ikisi L1 ile bağlı. */
  function linkedPairDoc(over?: {
    audioLocked?: boolean;
    audEndUs?: number;
    groupId?: string;
  }): TimelineDoc {
    const g = over?.groupId !== undefined ? { groupId: over.groupId } : {};
    return docWith([
      trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US, { linkId: L1, ...g })]),
      trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, over?.audEndUs ?? 4 * US, { linkId: L1, ...g })], {
        locked: over?.audioLocked === true,
      }),
    ]);
  }

  describe('expandSelectionForOp', () => {
    /** V1 [VID(L1,G1)], V2 [OTHER(G1)], A1 [AUD(L1,G1)] — K3: eşler aynı grupta. */
    function richDoc(): TimelineDoc {
      return docWith([
        trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US, { linkId: L1, groupId: G1 })]),
        trackOf(V2, 'video', [clipOf(OTHER, 'video', 0, 4 * US, { groupId: G1 })]),
        trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US, { linkId: L1, groupId: G1 })]),
      ]);
    }

    it("'link' scope adds ONLY the partner, appended after the given ids", () => {
      const d = richDoc();
      expect(expandSelectionForOp(d, [VID], 'link')).toEqual([VID, AUD]);
      // Grup üyesi OTHER 'link' kapsamına GİRMEZ.
      expect(expandSelectionForOp(d, [OTHER], 'link')).toEqual([OTHER]);
      // İdempotent: kapalı küme kendini döndürür.
      expect(expandSelectionForOp(d, [VID, AUD], 'link')).toEqual([VID, AUD]);
    });

    it("'move' scope closes over group members AND link partners in one pass", () => {
      const d = richDoc();
      // OTHER'dan başla: grubu (VID) ve grubun link eşini (AUD) tek geçişte bulur.
      expect(expandSelectionForOp(d, [OTHER], 'move')).toEqual([OTHER, VID, AUD]);
    });

    it('keeps the anchor first and passes unknown ids through untouched', () => {
      const d = richDoc();
      const ghost = '01890000-0000-7000-8000-0000000009ff';
      expect(expandSelectionForOp(d, [VID, ghost], 'move')).toEqual([VID, ghost, OTHER, AUD]);
    });
  });

  describe('linkClips / unlinkClips', () => {
    it('links a selected video+audio pair with ONE fresh shared linkId (single undo entry)', () => {
      useDocStore.getState().loadDoc(
        docWith([
          trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US)]),
          trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US)]),
        ]),
      );
      const res = linkClips([VID, AUD]);
      expect(res).toEqual({ ok: true });
      const clips = currentDoc().tracks.flatMap((t) => t.clips) as MediaClip[];
      expect(clips[0].linkId).toBeDefined();
      expect(clips[1].linkId).toBe(clips[0].linkId);
      expect(useDocStore.getState().history.at(-1)?.label).toBe('Klipler bağlandı');
      expectValid();
    });

    it('writes the grouped side\'s groupId onto the partner (invariant rule 10, group arm)', () => {
      useDocStore.getState().loadDoc(
        docWith([
          trackOf(V1, 'video', [
            clipOf(VID, 'video', 0, 4 * US, { groupId: G1 }),
            clipOf(OTHER, 'video', 5 * US, 4 * US, { groupId: G1 }),
          ]),
          trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US)]),
        ]),
      );
      expect(linkClips([VID, AUD]).ok).toBe(true);
      const aud = currentDoc().tracks[1].clips[0] as MediaClip;
      expect(aud.groupId).toBe(G1);
      expectValid();
    });

    it('block reasons: pair shape, already linked, different groups, locked track', () => {
      // 1 klip / iki video -> çift şekli tutmuyor.
      const plain = docWith([
        trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US), clipOf(OTHER, 'video', 5 * US, 4 * US)]),
        trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US)]),
      ]);
      expect(linkBlockReason(plain, [VID])).toBe('select a video and an audio clip to link');
      expect(linkBlockReason(plain, [VID, OTHER])).toBe('select a video and an audio clip to link');

      // Zaten bağlı: tek yarıdan bile kapanış çifti bulur ve doğru mesajı verir.
      const linked = linkedPairDoc();
      expect(linkBlockReason(linked, [VID])).toBe('clip is already linked');
      expect(linkBlockReason(linked, [VID, AUD])).toBe('clip is already linked');

      // Farklı gruplar.
      const twoGroups = docWith([
        trackOf(V1, 'video', [
          clipOf(VID, 'video', 0, 4 * US, { groupId: G1 }),
          clipOf(OTHER, 'video', 5 * US, 4 * US, { groupId: G1 }),
        ]),
        trackOf(A1, 'audio', [
          clipOf(AUD, 'audio', 0, 4 * US, { groupId: G2 }),
          clipOf(AUD2, 'audio', 5 * US, 4 * US, { groupId: G2 }),
        ]),
      ]);
      expect(linkBlockReason(twoGroups, [VID, AUD])).toBe('clips are in different groups');

      // Kilitli track.
      const locked = docWith([
        trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US)]),
        trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US)], { locked: true }),
      ]);
      expect(linkBlockReason(locked, [VID, AUD])).toBe('track is locked');
    });

    it('unlink dissolves the bond from BOTH members even when only one is selected', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      const res = unlinkClips([VID]);
      expect(res).toEqual({ ok: true });
      const clips = currentDoc().tracks.flatMap((t) => t.clips) as MediaClip[];
      expect(clips.every((c) => c.linkId === undefined)).toBe(true);
      expect(useDocStore.getState().history.at(-1)?.label).toBe('Bağlantı kaldırıldı');
      expectValid();
    });

    it('unlink block reasons: no linked clip / locked track', () => {
      const plain = docWith([trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US)])]);
      expect(unlinkBlockReason(plain, [VID])).toBe('no linked clip in selection');
      expect(unlinkBlockReason(linkedPairDoc({ audioLocked: true }), [VID])).toBe('track is locked');
    });
  });

  describe('linked pair moves TOGETHER (section-scoped trackDelta)', () => {
    it('a horizontal drag of the video carries the audio half (closure inside the op)', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      const res = moveClips([VID], 2 * US, 0);
      expect(res.ok, !res.ok ? res.reason : '').toBe(true);
      const vid = currentDoc().tracks[0].clips[0];
      const aud = currentDoc().tracks[1].clips[0];
      expect(vid.timelineStartUs, 'Video 2 sn kaymalı.').toBe(2 * US);
      expect(aud.timelineStartUs, 'Bağlı ses AYNI 2 sn kaymalı (kapanış).').toBe(2 * US);
      expectValid();
    });

    it('a lane change moves the video vertically while the audio slides in its OWN lane', () => {
      // [V1 boş, V2 (VID), A1 (AUD)] — video bir şerit yukarı, ses yerinde.
      useDocStore.getState().loadDoc(
        docWith([
          trackOf(V1, 'video', []),
          trackOf(V2, 'video', [clipOf(VID, 'video', 0, 4 * US, { linkId: L1 })]),
          trackOf(A1, 'audio', [clipOf(AUD, 'audio', 0, 4 * US, { linkId: L1 })]),
        ]),
      );
      const res = moveClips([VID], 0, -1);
      // Bölüm-kapsamlı delta sökülürse ses de -1 şerit ister -> V2 (video)
      // hedefi 'track type mismatch' ile TÜM taşımayı reddeder (negatif kontrol imzası).
      expect(res, "Bölüm-kapsamlı trackDelta: ses kendi şeridinde kalmalı.").toEqual({ ok: true });
      expect(currentDoc().tracks[0].clips.map((c) => c.id)).toEqual([VID]);
      expect(currentDoc().tracks[2].clips.map((c) => c.id)).toEqual([AUD]);
      expectValid();
    });

    it('within a section the type gate still refuses (video onto an overlay lane)', () => {
      useDocStore.getState().loadDoc(
        docWith([
          trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US)]),
          trackOf(O1, 'overlay', []),
        ]),
      );
      expect(moveClips([VID], 0, 1)).toEqual({ ok: false, reason: 'track type mismatch' });
    });
  });

  describe('linked pair deletes TOGETHER (all or nothing)', () => {
    it('deleting one half deletes BOTH, and a single undo brings both back', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      const res = deleteClips([VID]);
      expect(res.ok).toBe(true);
      expect(
        currentDoc().tracks.flatMap((t) => t.clips),
        'Bağ kapanışı: eş (ses) de silinmeli.',
      ).toHaveLength(0);
      useDocStore.getState().undo();
      expect(currentDoc().tracks.flatMap((t) => t.clips)).toHaveLength(2);
      expectValid();
    });

    it('refuses the WHOLE delete when the partner sits on a locked track', () => {
      useDocStore.getState().loadDoc(linkedPairDoc({ audioLocked: true }));
      expect(deleteBlockReason(currentDoc(), [VID])).toBe('linked clip is on a locked track');
      expect(deleteClips([VID])).toEqual({
        ok: false,
        reason: 'linked clip is on a locked track',
      });
      expect(currentDoc().tracks.flatMap((t) => t.clips), 'Yarım silme yok.').toHaveLength(2);
      expectValid();
    });

    it('strips the groupId from a group shrunk below 2 members', () => {
      useDocStore.getState().loadDoc(
        docWith([
          trackOf(V1, 'video', [
            clipOf(VID, 'video', 0, 4 * US, { groupId: G1 }),
            clipOf(OTHER, 'video', 5 * US, 4 * US, { groupId: G1 }),
          ]),
        ]),
      );
      expect(deleteClips([VID]).ok).toBe(true);
      const survivor = currentDoc().tracks[0].clips[0];
      expect(survivor.groupId, 'Tek üyeli grup kalamaz (kural 11).').toBeUndefined();
      expectValid();
    });
  });

  describe('linked pair splits TOGETHER', () => {
    it('both sides under the playhead -> 4 clips forming 2 pairs (left keeps the old id, right pair mints a fresh shared one)', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      useEditorStore.getState().setSelection([]);
      const res = splitAtPlayhead(2 * US);
      expect(res.ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      const auds = currentDoc().tracks[1].clips as MediaClip[];
      expect(vids).toHaveLength(2);
      expect(auds).toHaveLength(2);
      // Sol yarılar eski bağı taşır...
      expect(vids[0].linkId).toBe(L1);
      expect(auds[0].linkId).toBe(L1);
      // ...sağ yarılar TAZE ORTAK bir bağ alır.
      expect(vids[1].linkId).toBeDefined();
      expect(vids[1].linkId).toBe(auds[1].linkId);
      expect(vids[1].linkId).not.toBe(L1);
      expectValid();
    });

    it('a one-sided split keeps the old pair legal: left half + partner, right half unlinked', () => {
      // Ses 0..2 sn: 3. saniyedeki kesim yalnız videoyu bölebilir.
      useDocStore.getState().loadDoc(linkedPairDoc({ audEndUs: 2 * US }));
      useEditorStore.getState().setSelection([]);
      expect(splitAtPlayhead(3 * US).ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      const auds = currentDoc().tracks[1].clips as MediaClip[];
      expect(vids).toHaveLength(2);
      expect(auds).toHaveLength(1);
      expect(vids[0].linkId).toBe(L1);
      expect(auds[0].linkId).toBe(L1);
      expect(vids[1].linkId, 'Sağ yarı bağsız doğar (kural 10 korunur).').toBeUndefined();
      expectValid();
    });

    it('splitClipAt primitive: the second half is born unlinked but KEEPS its groupId', () => {
      useDocStore.getState().loadDoc(linkedPairDoc({ groupId: G1 }));
      expect(splitClipAt(VID, 2 * US).ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      expect(vids[1].linkId).toBeUndefined();
      expect(vids[1].groupId, 'groupId ikinci yarıda kalır.').toBe(G1);
      expectValid();
    });
  });

  describe('trim does NOT propagate over the bond (user decision, negative pin)', () => {
    it('trimming the video edge leaves the audio half untouched and the bond intact', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(trimClip(VID, 'right', 3 * US).ok).toBe(true);
      const vid = currentDoc().tracks[0].clips[0] as MediaClip;
      const aud = currentDoc().tracks[1].clips[0] as MediaClip;
      expect(vid.timelineDurationUs).toBe(3 * US);
      expect(aud.timelineDurationUs, 'Eş kırpılMAZ.').toBe(4 * US);
      expect(vid.linkId, 'Bağ kopmaz.').toBe(L1);
      expect(aud.linkId).toBe(L1);
      expectValid();
    });
  });

  describe('copy paths re-mint shared ids (remintLinkAndGroupIds)', () => {
    it('duplicating the FULL pair -> the copies share ONE fresh linkId', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(duplicateClips([VID, AUD]).ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      const auds = currentDoc().tracks[1].clips as MediaClip[];
      expect(vids).toHaveLength(2);
      expect(auds).toHaveLength(2);
      expect(vids[1].linkId).toBeDefined();
      expect(vids[1].linkId).toBe(auds[1].linkId);
      expect(vids[1].linkId).not.toBe(L1);
      expectValid();
    });

    it('duplicating HALF the pair -> the copy carries NO linkId (dangling forbidden)', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(duplicateClips([VID]).ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      expect(vids).toHaveLength(2);
      expect(vids[1].linkId).toBeUndefined();
      expect(vids[0].linkId, 'Orijinalin bağı durur.').toBe(L1);
      expectValid();
    });

    it('paste behaves the same: full pair -> fresh shared id, half -> none', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(copyClips([VID, AUD])).toBe(true);
      expect(pasteAtPlayhead(5 * US).ok).toBe(true);
      const vids = currentDoc().tracks[0].clips as MediaClip[];
      const auds = currentDoc().tracks[1].clips as MediaClip[];
      expect(vids[1].linkId).toBeDefined();
      expect(vids[1].linkId).toBe(auds[1].linkId);
      expect(vids[1].linkId).not.toBe(L1);
      expectValid();

      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(copyClips([VID])).toBe(true);
      expect(pasteAtPlayhead(5 * US).ok).toBe(true);
      const vids2 = currentDoc().tracks[0].clips as MediaClip[];
      expect(vids2[1].linkId).toBeUndefined();
      expectValid();
    });
  });

  describe('detachAudio births a LINKED pair', () => {
    it('writes one fresh shared linkId onto the video and the detached audio', () => {
      useDocStore.getState().loadDoc(
        docWith([trackOf(V1, 'video', [clipOf(VID, 'video', 0, 4 * US)])]),
      );
      expect(detachAudio(VID).ok).toBe(true);
      const vid = currentDoc().tracks[0].clips[0] as MediaClip;
      const aud = currentDoc().tracks[1].clips[0] as MediaClip;
      expect(aud.kind).toBe('audio');
      expect(vid.linkId).toBeDefined();
      expect(aud.linkId).toBe(vid.linkId);
      expectValid();
    });

    it('refuses on an ALREADY LINKED video — a fresh bond would strand the old partner', () => {
      useDocStore.getState().loadDoc(linkedPairDoc());
      expect(detachAudioBlockReason(currentDoc(), VID)).toBe('clip is already linked');
      expect(detachAudio(VID)).toEqual({ ok: false, reason: 'clip is already linked' });
      expectValid();
    });
  });

  describe('deleteTrack breaks bonds and dissolves shrunken groups', () => {
    it("deleting the audio track strips the video partner's linkId (and its now-single group)", () => {
      useDocStore.getState().loadDoc(linkedPairDoc({ groupId: G1 }));
      expect(deleteTrack(A1).ok).toBe(true);
      const vid = currentDoc().tracks[0].clips[0] as MediaClip;
      expect(vid.linkId, 'Eşi silinen klip bağ taşıyamaz (kural 10).').toBeUndefined();
      expect(vid.groupId, 'Tek üyeli grup kalamaz (kural 11).').toBeUndefined();
      expectValid();
      // Tek undo hem track'i hem bağı geri getirir (aynı mutate).
      useDocStore.getState().undo();
      const restored = currentDoc().tracks.flatMap((t) => t.clips) as MediaClip[];
      expect(restored).toHaveLength(2);
      expect(restored.every((c) => c.linkId === L1)).toBe(true);
      expectValid();
    });
  });
});

// ---------------------------------------------------------------------------
// Otomatik AV ayrımı (ozellik-3): planAddClipFromAsset + çift-klipli commit.
// Karar tablosu, ses yerleşim politikası, kısmi başarı yasağı ve plan<->commit
// ayrışmazlığı (guardPaths deseni) burada sabitlenir.
// ---------------------------------------------------------------------------

describe('automatic AV split on add (ozellik-3)', () => {
  const AV_VIDEO = '01890000-0000-7000-8000-000000000601';
  const SILENT_VIDEO = '01890000-0000-7000-8000-000000000602';
  const UNKNOWN_VIDEO = '01890000-0000-7000-8000-000000000603';
  const IMAGE_ASSET = '01890000-0000-7000-8000-000000000604';
  const AUDIO_ASSET = '01890000-0000-7000-8000-000000000605';

  function seedAssets(): void {
    useAssetStore.getState().setAssets([
      { id: AV_VIDEO, kind: 'video', name: 'sesli.mp4', status: 'ready', durationUs: 4 * US, hasAudio: true },
      { id: SILENT_VIDEO, kind: 'video', name: 'sessiz.mp4', status: 'ready', durationUs: 4 * US, hasAudio: false },
      { id: UNKNOWN_VIDEO, kind: 'video', name: 'eski.mp4', status: 'ready', durationUs: 4 * US },
      { id: IMAGE_ASSET, kind: 'image', name: 'foto.png', status: 'ready' },
      { id: AUDIO_ASSET, kind: 'audio', name: 'muzik.m4a', status: 'ready', durationUs: 4 * US },
    ]);
  }

  function allClips(): MediaClip[] {
    return currentDoc().tracks.flatMap((t) => t.clips) as MediaClip[];
  }

  beforeEach(seedAssets);

  describe('decision table', () => {
    it('image asset -> ONE clip (unchanged)', () => {
      const trackId = addTrack('video');
      const res = addClipFromAsset(IMAGE_ASSET, { trackId }, 0);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.audioClipId).toBeUndefined();
      expect(allClips()).toHaveLength(1);
      expectValid();
    });

    it('audio asset -> ONE clip (unchanged)', () => {
      const trackId = addTrack('audio');
      const res = addClipFromAsset(AUDIO_ASSET, { trackId }, 0);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.audioClipId).toBeUndefined();
      expect(allClips()).toHaveLength(1);
      expectValid();
    });

    it('video + hasAudio=true -> TWO linked clips: video half audio:null, twin = detach formula', () => {
      const trackId = addTrack('video');
      const res = addClipFromAsset(AV_VIDEO, { trackId }, 2 * US);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.audioClipId).toBeDefined();
      expect(res.audioTrackId).toBeDefined();

      const clips = allClips();
      expect(clips).toHaveLength(2);
      const vid = clips.find((c) => c.kind === 'video')!;
      const aud = clips.find((c) => c.kind === 'audio')!;
      expect(vid.audio, 'Gömülü ses TÜMÜYLE ikize taşınır (detach sonrası şekil).').toBeNull();
      expect(aud.audio).toEqual({ volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false });
      // detachAudio formülü: aynı assetId/sourceIn/Out/speed/timeline penceresi.
      expect(aud.assetId).toBe(vid.assetId);
      expect(aud.sourceInUs).toBe(vid.sourceInUs);
      expect(aud.sourceOutUs).toBe(vid.sourceOutUs);
      expect(aud.speed).toEqual(vid.speed);
      expect(aud.timelineStartUs).toBe(vid.timelineStartUs);
      expect(aud.timelineDurationUs).toBe(vid.timelineDurationUs);
      // Ortak TAZE linkId + İKİSİ birden seçili.
      expect(vid.linkId).toBeDefined();
      expect(aud.linkId).toBe(vid.linkId);
      expect([...useEditorStore.getState().selection].sort()).toEqual([vid.id, aud.id].sort());
      expectValid();
    });

    it('video + hasAudio=false -> ONE clip with audio:null; detach menu greys with the plain rule', () => {
      const trackId = addTrack('video');
      const res = addClipFromAsset(SILENT_VIDEO, { trackId }, 0);
      expect(res.ok).toBe(true);
      const clips = allClips();
      expect(clips).toHaveLength(1);
      expect(clips[0].audio, 'Kesin-sessiz kaynakta gömülü ses NESNESİ yazılmaz.').toBeNull();
      // audio:null artık ÖNCE konuşur — sessiz videoda menü bu gerekçeyle grilenir.
      expect(detachAudioBlockReason(currentDoc(), clips[0].id)).toBe('clip has no embedded audio');
      expectValid();
    });

    it('video + hasAudio=undefined (unmeasured row) -> ONE clip WITH embedded audio (unchanged)', () => {
      const trackId = addTrack('video');
      const res = addClipFromAsset(UNKNOWN_VIDEO, { trackId }, 0);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.audioClipId).toBeUndefined();
      const clips = allClips();
      expect(clips).toHaveLength(1);
      expect(clips[0].audio, 'Bilinmeyen olgu sessizlik DEĞİLDİR: ikiz üretmek 422 tuzağıdır.').not.toBeNull();
      expect(clips[0].linkId).toBeUndefined();
      expectValid();
    });
  });

  describe('single mutate = single undo', () => {
    it('ONE Ctrl+Z removes BOTH halves (and the spawned audio track)', () => {
      addTrack('video');
      const before = currentDoc().tracks.length;
      const res = addClipFromAsset(AV_VIDEO, { trackId: currentDoc().tracks[0].id }, 0);
      expect(res.ok).toBe(true);
      expect(allClips()).toHaveLength(2);
      expect(currentDoc().tracks.length).toBe(before + 1);

      useDocStore.getState().undo();
      expect(allClips(), 'TEK undo çiftin İKİSİNİ de kaldırmalı (tek mutate).').toHaveLength(0);
      expect(currentDoc().tracks.length, 'Doğan ses track\'i de aynı undo ile gider.').toBe(before);
      expectValid();
    });
  });

  describe('audio placement policy', () => {
    it('lands on the FIRST unlocked audio track that is free at the range (no notice)', () => {
      const videoTrackId = addTrack('video');
      const audioTrackId = addTrack('audio');
      const res = addClipFromAsset(AV_VIDEO, { trackId: videoTrackId }, 0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.audioTrackId).toBe(audioTrackId);
      expect(res.notice).toBeUndefined();
      expectValid();
    });

    it('skips a LOCKED audio lane and a lane that is FULL at the range', () => {
      const videoTrackId = addTrack('video');
      const lockedId = addTrack('audio');
      toggleTrackLocked(lockedId);
      const fullId = addTrack('audio');
      expect(addClipFromAsset(AUDIO_ASSET, { trackId: fullId }, 0).ok).toBe(true);
      const freeId = addTrack('audio');

      const res = addClipFromAsset(AV_VIDEO, { trackId: videoTrackId }, 0);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.audioTrackId).toBe(freeId);
      expectValid();
    });

    it('all lanes unusable -> NEW audio track at the BOTTOM (partition) + notice', () => {
      const videoTrackId = addTrack('video');
      const fullId = addTrack('audio');
      expect(addClipFromAsset(AUDIO_ASSET, { trackId: fullId }, 0).ok).toBe(true);

      const res = addClipFromAsset(AV_VIDEO, { trackId: videoTrackId }, 0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.notice).toBe(AUDIO_PLACED_ON_NEW_TRACK);
      const tracks = currentDoc().tracks;
      // Partisyon: yeni ses şeridi push edilir - EN ALTTA doğar.
      expect(tracks[tracks.length - 1].id).toBe(res.audioTrackId);
      expect(tracks[tracks.length - 1].type).toBe('audio');
      expect(tracks.map((t) => t.type)).toEqual(['video', 'audio', 'audio']);
      expectValid();
    });

    it('with NO audio track at all the twin births one (also bottom, also told)', () => {
      const videoTrackId = addTrack('video');
      const res = addClipFromAsset(AV_VIDEO, { trackId: videoTrackId }, 0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.notice).toBe(AUDIO_PLACED_ON_NEW_TRACK);
      expect(currentDoc().tracks.map((t) => t.type)).toEqual(['video', 'audio']);
      expectValid();
    });
  });

  describe('partial success is impossible (track ceiling)', () => {
    /** 1 boş video track + (MAX_TRACKS-1) KİLİTLİ ses track'i = tavan dolu. */
    function loadCeilingDoc(): void {
      const tracks: Track[] = [videoTrack(TRACK_1, [])];
      for (let i = 1; i < MAX_TRACKS; i++) {
        tracks.push({
          id: `01890000-0000-7000-8000-0000000007${i.toString(16).padStart(2, '0')}`,
          type: 'audio',
          muted: false,
          hidden: false,
          locked: true,
          clips: [],
        });
      }
      useDocStore.getState().loadDoc(docWith(tracks));
    }

    it('video fits but the twin would need track 51 -> the WHOLE add refuses', () => {
      loadCeilingDoc();
      const historyBefore = useDocStore.getState().history.length;
      const res = addClipFromAsset(AV_VIDEO, { trackId: TRACK_1 }, 0);
      expect(res).toEqual({ ok: false, reason: 'track limit reached' });
      expect(allClips(), 'Kısmi başarı yasak: video da yazılmamış olmalı.').toHaveLength(0);
      expect(useDocStore.getState().history.length, 'Tarih temiz kalmalı.').toBe(historyBefore);
      expectValid();
    });

    it('the ceiling also guards the plain single-clip newTrack path', () => {
      loadCeilingDoc();
      const res = addClipFromAsset(IMAGE_ASSET, { newTrack: true }, 0);
      expect(res).toEqual({ ok: false, reason: 'track limit reached' });
      expect(allClips()).toHaveLength(0);
    });

    it('a 49-track document cannot sneak to 51 through the two-new-track corner', () => {
      // 1 video + 47 kilitli ses = 48 track; newTrack hedefi video icin 1,
      // ikiz icin 1 track daha ister -> 50'ye sigar. 49'da sigmaz.
      const tracks: Track[] = [videoTrack(TRACK_1, [])];
      for (let i = 1; i < MAX_TRACKS - 1; i++) {
        tracks.push({
          id: `01890000-0000-7000-8000-0000000008${i.toString(16).padStart(2, '0')}`,
          type: 'audio',
          muted: false,
          hidden: false,
          locked: true,
          clips: [],
        });
      }
      useDocStore.getState().loadDoc(docWith(tracks)); // 49 track
      const res = addClipFromAsset(AV_VIDEO, { newTrack: true }, 0);
      expect(res).toEqual({ ok: false, reason: 'track limit reached' });
      expect(currentDoc().tracks.length).toBe(MAX_TRACKS - 1);
      expectValid();
    });
  });

  describe('plan <-> commit non-divergence (guardPaths pattern)', () => {
    it('whenever the plan says ok the commit succeeds, and refusals carry the SAME reason', () => {
      const scenarios: {
        name: string;
        setup(): { assetId: string; target: Parameters<typeof addClipFromAsset>[1]; startUs: number };
      }[] = [
        {
          name: 'AV split onto an existing video track',
          setup: () => ({ assetId: AV_VIDEO, target: { trackId: addTrack('video') }, startUs: 0 }),
        },
        {
          name: 'AV split via newTrack',
          setup: () => ({ assetId: AV_VIDEO, target: { newTrack: true }, startUs: US }),
        },
        {
          name: 'locked target track',
          setup: () => {
            const trackId = addTrack('video');
            toggleTrackLocked(trackId);
            return { assetId: AV_VIDEO, target: { trackId }, startUs: 0 };
          },
        },
        {
          name: 'track type mismatch',
          setup: () => ({ assetId: AV_VIDEO, target: { trackId: addTrack('audio') }, startUs: 0 }),
        },
        {
          name: 'overlap on the video lane',
          setup: () => {
            const trackId = addTrack('video');
            expect(addClipFromAsset(UNKNOWN_VIDEO, { trackId }, 0).ok).toBe(true);
            return { assetId: AV_VIDEO, target: { trackId }, startUs: US };
          },
        },
        {
          name: 'asset not ready',
          setup: () => {
            useAssetStore.getState().updateAsset(AV_VIDEO, { status: 'processing' });
            return { assetId: AV_VIDEO, target: { trackId: addTrack('video') }, startUs: 0 };
          },
        },
      ];
      for (const scenario of scenarios) {
        useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
        seedAssets();
        const { assetId, target, startUs } = scenario.setup();
        const asset = useAssetStore.getState().getAsset(assetId)!;
        const plan = planAddClipFromAsset(currentDoc(), asset, target, startUs);
        const res = addClipFromAsset(assetId, target, startUs);
        expect(res.ok, scenario.name).toBe(plan.ok);
        if (!plan.ok && !res.ok) expect(res.reason, scenario.name).toBe(plan.reason);
        if (plan.ok) expectValid();
      }
    });
  });
});
