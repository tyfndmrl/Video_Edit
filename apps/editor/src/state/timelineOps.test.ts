import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  validateTimelineDoc,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { useEditorStore } from './editorStore';
import {
  addClipFromAsset,
  addTrack,
  deleteClips,
  knownAssetDurations,
  moveClips,
  planMoveClips,
  splitClipAt,
  splitKeyframes,
  toggleTrackLocked,
  trimClip,
} from './timelineOps';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const ASSET_B = '01890000-0000-7000-8000-00000000000b';
const TRACK_1 = '01890000-0000-7000-8000-000000000101';

const US = 1_000_000;

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

  it('multi-select: delta snapped ONCE against clipIds[0]; relative offsets preserved exactly', () => {
    const c1 = mediaClip('01890000-0000-7000-8000-000000000201', ASSET_A, 0, 0, 2 * US);
    // Off-grid start: the second clip must keep its exact offset from c1.
    const c2 = mediaClip('01890000-0000-7000-8000-000000000202', ASSET_B, 3 * US + 11, 0, 2 * US);
    useDocStore.getState().loadDoc(docWith([videoTrack(TRACK_1, [c1, c2])]));

    const res = moveClips([c1.id, c2.id], 50_000);
    expect(res.ok).toBe(true);
    const clips = currentDoc().tracks[0].clips;
    expect(clips[0].timelineStartUs).toBe(66_667); // snapped anchor
    expect(clips[1].timelineStartUs).toBe(3 * US + 11 + 66_667); // NOT re-snapped
    expect(clips[1].timelineStartUs - clips[0].timelineStartUs).toBe(3 * US + 11);
    expectValid();
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
