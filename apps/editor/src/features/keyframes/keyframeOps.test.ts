import { beforeEach, describe, expect, it } from 'vitest';
import {
  snapUsToFrameGrid,
  validateTimelineDoc,
  type Clip,
  type Keyframe,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useAssetStore } from '../../state/assetStore';
import { useEditorStore } from '../../state/editorStore';
import { knownAssetDurations, toggleTrackLocked } from '../../state/timelineOps';
import { channelKeyframes } from './keyframeModel';
import {
  addKeyframe,
  applyTransformPatchToDraft,
  clampKeyframeTime,
  clearChannel,
  moveKeyframe,
  removeKeyframe,
  setKeyframeEasing,
  setKeyframeValue,
  toggleKeyframe,
} from './keyframeOps';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const TRACK_1 = '01890000-0000-7000-8000-000000000101';
const CLIP_1 = '01890000-0000-7000-8000-000000000201';

function mediaClip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: CLIP_1,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: 2 * US,
    timelineDurationUs: 4 * US,
    sourceInUs: 0,
    sourceOutUs: 4 * US,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 0.5,
    ...over,
  };
}

function load(clip: Clip): void {
  const track: Track = {
    id: TRACK_1,
    type: 'video',
    muted: false,
    hidden: false,
    locked: false,
    clips: [clip],
  };
  const doc: TimelineDoc = {
    ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }),
    tracks: [track],
  };
  useDocStore.getState().loadDoc(doc);
}

const currentClip = (): Clip => useDocStore.getState().doc.tracks[0].clips[0];
const opacityKfs = (): readonly Keyframe[] => channelKeyframes(currentClip(), 'opacity');

function expectValid(): void {
  const result = validateTimelineDoc(useDocStore.getState().doc, knownAssetDurations());
  expect(result.success, JSON.stringify(!result.success ? result.error.issues : null)).toBe(true);
}

beforeEach(() => {
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
  ]);
  useEditorStore.getState().clearSelection();
  useEditorStore.getState().setPlayheadUs(0);
  load(mediaClip());
});

describe('addKeyframe', () => {
  it('captures the STATIC base value for the first keyframe of a channel', () => {
    expect(addKeyframe(CLIP_1, 'opacity', US).ok).toBe(true);
    expect(opacityKfs()).toEqual([{ timeUs: US, value: 0.5, easing: { type: 'linear' } }]);
    expectValid();
  });

  it('captures the SAMPLED value for a later keyframe (adding a dot changes nothing)', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0);
    addKeyframe(CLIP_1, 'opacity', 2 * US, 1);
    expect(addKeyframe(CLIP_1, 'opacity', US).ok).toBe(true);
    const mid = opacityKfs().find((k) => k.timeUs === US);
    expect(mid?.value).toBeCloseTo(0.5, 3);
    expectValid();
  });

  it('keeps the track strictly sorted whatever order the caller uses', () => {
    addKeyframe(CLIP_1, 'opacity', 3 * US, 1);
    addKeyframe(CLIP_1, 'opacity', US, 0.2);
    addKeyframe(CLIP_1, 'opacity', 2 * US, 0.6);
    expect(opacityKfs().map((k) => k.timeUs)).toEqual([US, 2 * US, 3 * US]);
    expectValid();
  });

  it('inherits the preceding keyframe easing so an existing curve is not flattened', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0);
    setKeyframeEasing(CLIP_1, 'opacity', 0, { type: 'easeInOut' });
    addKeyframe(CLIP_1, 'opacity', 2 * US, 1);
    expect(opacityKfs()[1].easing).toEqual({ type: 'easeInOut' });
  });

  it('clamps the value into the channel bounds', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 9);
    expect(opacityKfs()[0].value).toBe(1);
    expectValid();
  });

  it('clamps the time into the clip and refuses a duplicate', () => {
    addKeyframe(CLIP_1, 'opacity', 99 * US, 0.3);
    expect(opacityKfs()[0].timeUs).toBe(4 * US);
    const again = addKeyframe(CLIP_1, 'opacity', 4 * US, 0.9);
    expect(again.ok).toBe(false);
    expect(opacityKfs()).toHaveLength(1);
    expectValid();
  });

  it('refuses a channel the clip kind cannot animate', () => {
    load(mediaClip({ audio: null }));
    const res = addKeyframe(CLIP_1, 'volume', 0);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/animatable/);
  });

  it('refuses a locked track', () => {
    toggleTrackLocked(TRACK_1);
    expect(addKeyframe(CLIP_1, 'opacity', 0).ok).toBe(false);
    expect(opacityKfs()).toHaveLength(0);
  });

  it('is ONE history entry', () => {
    const before = useDocStore.getState().cursor;
    addKeyframe(CLIP_1, 'opacity', US);
    expect(useDocStore.getState().cursor - before).toBe(1);
    useDocStore.getState().undo();
    expect(opacityKfs()).toHaveLength(0);
  });
});

describe('removeKeyframe / toggleKeyframe / clearChannel', () => {
  it('freezes the base value when the LAST keyframe goes (no visual jump)', () => {
    addKeyframe(CLIP_1, 'opacity', US, 0.2);
    expect(removeKeyframe(CLIP_1, 'opacity', US).ok).toBe(true);
    expect(currentClip().keyframes.opacity).toBeUndefined();
    expect(currentClip().opacity).toBe(0.2);
    expectValid();
  });

  it('leaves the base alone while other keyframes remain', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0.1);
    addKeyframe(CLIP_1, 'opacity', 2 * US, 0.9);
    removeKeyframe(CLIP_1, 'opacity', 2 * US);
    expect(currentClip().opacity).toBe(0.5);
    expect(opacityKfs()).toHaveLength(1);
  });

  it('toggles add/remove at the same instant', () => {
    expect(toggleKeyframe(CLIP_1, 'opacity', US).ok).toBe(true);
    expect(opacityKfs()).toHaveLength(1);
    expect(toggleKeyframe(CLIP_1, 'opacity', US).ok).toBe(true);
    expect(opacityKfs()).toHaveLength(0);
    expectValid();
  });

  it('refuses to remove where there is no keyframe', () => {
    addKeyframe(CLIP_1, 'opacity', US, 0.2);
    expect(removeKeyframe(CLIP_1, 'opacity', 3 * US).ok).toBe(false);
  });

  it('clearChannel freezes the property at the value it had at the given time', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0);
    addKeyframe(CLIP_1, 'opacity', 2 * US, 1);
    expect(clearChannel(CLIP_1, 'opacity', US).ok).toBe(true);
    expect(currentClip().keyframes.opacity).toBeUndefined();
    expect(currentClip().opacity).toBeCloseTo(0.5, 2);
    expectValid();
  });
});

describe('moveKeyframe', () => {
  it('snaps to the project frame grid', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0.1);
    moveKeyframe(CLIP_1, 'opacity', 0, 1_010_000);
    // 1_010_000 us at 30 fps -> frame 30 -> 1_000_000 (roundHalfUp both ways).
    expect(opacityKfs()[0].timeUs).toBe(US);
    expectValid();
  });

  it('never crosses a neighbour (invariant 4 can never break mid-drag)', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0);
    addKeyframe(CLIP_1, 'opacity', US, 0.5);
    addKeyframe(CLIP_1, 'opacity', 2 * US, 1);
    moveKeyframe(CLIP_1, 'opacity', US, 9 * US);
    const times = opacityKfs().map((k) => k.timeUs);
    expect(times[1]).toBeLessThan(2 * US);
    expect(times[1]).toBeGreaterThan(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expectValid();
  });

  it('stays inside [0, duration]', () => {
    addKeyframe(CLIP_1, 'opacity', US, 0.4);
    moveKeyframe(CLIP_1, 'opacity', US, -5 * US);
    expect(opacityKfs()[0].timeUs).toBe(0);
    moveKeyframe(CLIP_1, 'opacity', 0, 99 * US);
    expect(opacityKfs()[0].timeUs).toBeLessThanOrEqual(4 * US);
    expectValid();
  });

  it('refuses when there is no keyframe at the source time', () => {
    expect(moveKeyframe(CLIP_1, 'opacity', US, 2 * US).ok).toBe(false);
  });
});

describe('clampKeyframeTime', () => {
  const fps = { num: 30, den: 1 };
  const kf = (timeUs: number): Keyframe => ({
    timeUs,
    value: 0,
    easing: { type: 'linear' },
  });

  it('prefers a frame boundary inside the corridor', () => {
    const list = [kf(0), kf(2 * US)];
    expect(clampKeyframeTime(list, 0, 1_010_000, 4 * US, fps)).toBe(US);
  });

  it('falls back to the corridor bound when the corridor is under a frame', () => {
    // Neighbours one microsecond apart on each side: no frame boundary fits.
    const list = [kf(1_000_000), kf(1_000_001), kf(1_000_002)];
    const landed = clampKeyframeTime(list, 1, 3 * US, 4 * US, fps);
    expect(landed).toBeGreaterThan(1_000_000);
    expect(landed).toBeLessThan(1_000_002);
  });

  it('keeps the keyframe put when it is completely boxed in', () => {
    const list = [kf(1_000_000), kf(1_000_001), kf(1_000_002)];
    // index 1 corridor is [1_000_001, 1_000_001] -> only its own time.
    expect(clampKeyframeTime(list, 1, 0, 4 * US, fps)).toBe(1_000_001);
  });

  it('uses [0, duration] when there is no neighbour', () => {
    const list = [kf(US)];
    expect(clampKeyframeTime(list, 0, -10 * US, 4 * US, fps)).toBe(0);
    // 4 s is itself a frame boundary at 30 fps, so the clip end is reachable.
    expect(clampKeyframeTime(list, 0, 10 * US, 4 * US, fps)).toBe(4 * US);
    // A duration that is NOT on the grid falls back to the last frame inside it.
    const odd = 4 * US + 10_000;
    const landed = clampKeyframeTime(list, 0, 10 * US, odd, fps);
    expect(landed).toBeLessThanOrEqual(odd);
    expect(landed, 'must still be a frame boundary').toBe(snapUsToFrameGrid(landed, fps));
  });
});

describe('setKeyframeValue (auto-keyframe)', () => {
  it('updates the keyframe at the time when one exists', () => {
    addKeyframe(CLIP_1, 'opacity', US, 0.2);
    setKeyframeValue(CLIP_1, 'opacity', US, 0.9);
    expect(opacityKfs()).toHaveLength(1);
    expect(opacityKfs()[0].value).toBe(0.9);
  });

  it('creates one when the instant has none', () => {
    addKeyframe(CLIP_1, 'opacity', 0, 0);
    setKeyframeValue(CLIP_1, 'opacity', 2 * US, 1);
    expect(opacityKfs().map((k) => k.timeUs)).toEqual([0, 2 * US]);
    expectValid();
  });
});

describe('applyTransformPatchToDraft (gizmo routing)', () => {
  it('writes the BASE for a static channel', () => {
    useDocStore.getState().mutate('test', 'test', (d) => {
      applyTransformPatchToDraft(d, CLIP_1, { x: 0.25 }, US);
    });
    expect(currentClip().transform.x).toBe(0.25);
    expect(currentClip().keyframes.x).toBeUndefined();
    expectValid();
  });

  it('writes a KEYFRAME for an animated channel and leaves the base untouched', () => {
    addKeyframe(CLIP_1, 'x', 0, 0);
    useDocStore.getState().mutate('test', 'test', (d) => {
      applyTransformPatchToDraft(d, CLIP_1, { x: 0.25 }, US);
    });
    expect(currentClip().transform.x).toBe(0);
    expect(channelKeyframes(currentClip(), 'x').map((k) => [k.timeUs, k.value])).toEqual([
      [0, 0],
      [US, 0.25],
    ]);
    expectValid();
  });

  it('splits a mixed patch per channel', () => {
    addKeyframe(CLIP_1, 'scale', 0, 1);
    useDocStore.getState().mutate('test', 'test', (d) => {
      applyTransformPatchToDraft(d, CLIP_1, { x: 0.1, scale: 2 }, US);
    });
    expect(currentClip().transform.x).toBe(0.1);
    expect(currentClip().transform.scale).toBe(1);
    expect(channelKeyframes(currentClip(), 'scale')).toHaveLength(2);
    expectValid();
  });

  it('refuses a locked track', () => {
    toggleTrackLocked(TRACK_1);
    let result = { ok: true } as { ok: boolean };
    useDocStore.getState().mutate('test', 'test', (d) => {
      result = applyTransformPatchToDraft(d, CLIP_1, { x: 0.25 }, US);
    });
    expect(result.ok).toBe(false);
    expect(currentClip().transform.x).toBe(0);
  });
});
