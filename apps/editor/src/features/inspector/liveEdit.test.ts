/**
 * liveEdit — "one pointer gesture = one undo entry".
 *
 * The regression this guards: a slider drag emitting a change per pixel used to
 * mean a history entry (and an autosave PUT) per pixel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clipTimelineDurationUs, type MediaClip, type Track } from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useAssetStore } from '../../state/assetStore';
import { applyClipAudioToDraft } from '../../state/timelineOps';
import {
  beginLiveEdit,
  endLiveEdit,
  isGestureActive,
  isLiveEditBlocked,
  isLiveEditOpen,
  updateLiveEdit,
} from './liveEdit';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const CLIP_A = '01890000-0000-7000-8000-000000000201';

function videoClip(id: string, startUs: number, durationUs: number): MediaClip {
  return {
    id,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: startUs,
    timelineDurationUs: clipTimelineDurationUs(0, durationUs, 1),
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function volume(): number {
  const clip = useDocStore.getState().doc.tracks[0].clips[0] as MediaClip;
  return clip.audio!.volume;
}

beforeEach(() => {
  endLiveEdit();
  const track: Track = {
    id: V1,
    type: 'video',
    muted: false,
    hidden: false,
    locked: false,
    clips: [videoClip(CLIP_A, 0, 10 * US)],
  };
  useDocStore.getState().loadDoc({
    ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }),
    tracks: [track],
  });
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 60 * US },
  ]);
});

describe('liveEdit', () => {
  it('collapses a whole gesture into a single history entry', () => {
    expect(beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi')).toBe(true);
    expect(isLiveEditOpen()).toBe(true);
    for (const v of [0.9, 0.7, 0.5, 0.3]) {
      updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: v }));
    }
    endLiveEdit();

    expect(isLiveEditOpen()).toBe(false);
    expect(volume()).toBe(0.3);
    expect(useDocStore.getState().history).toHaveLength(1);
    expect(useDocStore.getState().history[0].label).toBe('Ses seviyesi değiştirildi');

    useDocStore.getState().undo();
    expect(volume()).toBe(1);
  });

  it('leaves no history entry when the gesture changed nothing', () => {
    beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi');
    updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: 1 }));
    endLiveEdit();
    expect(useDocStore.getState().history).toHaveLength(0);
  });

  it('is a no-op outside a gesture, so discrete edits fall back to plain ops', () => {
    expect(isLiveEditOpen()).toBe(false);
    updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: 0.1 }));
    expect(volume()).toBe(1);
    endLiveEdit();
    expect(useDocStore.getState().history).toHaveLength(0);
  });

  it('refuses to open while another transaction owns the store (timeline drag)', () => {
    const tx = useDocStore.getState().beginTransaction('move', 'Klip taşındı');
    expect(beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi')).toBe(false);
    expect(isLiveEditOpen()).toBe(false);
    tx.commit();
    endLiveEdit();
  });

  /**
   * The return value used to be dropped on the floor: a refused begin() left
   * `isLiveEditOpen()` false, so every intermediate value of the drag took the
   * plain-op path — one history entry (and one autosave PUT) per pixel, the
   * exact regression this module exists to prevent.
   */
  it('marks the gesture as BLOCKED when the transaction was refused', () => {
    const tx = useDocStore.getState().beginTransaction('move', 'Klip taşındı');
    expect(beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi')).toBe(false);
    expect(isGestureActive(), 'a pointer gesture is still in progress').toBe(true);
    expect(isLiveEditBlocked(), 'controls must stand down, not fall back to ops').toBe(true);
    tx.commit();
    endLiveEdit();
    expect(isGestureActive()).toBe(false);
    expect(isLiveEditBlocked()).toBe(false);
  });

  it('marks the gesture as BLOCKED while the document is locked (project load)', () => {
    useDocStore.getState().setLocked(true);
    expect(beginLiveEdit('clipTransform', 'Ölçek değiştirildi')).toBe(false);
    expect(isLiveEditBlocked()).toBe(true);
    useDocStore.getState().setLocked(false);
    endLiveEdit();
    expect(useDocStore.getState().history).toHaveLength(0);
  });

  /**
   * Reentrancy: a mousedown on a scrub label blurs whatever input had focus,
   * and that blur fires AFTER the gesture opened. Discrete paths ask
   * isGestureActive() and stand down; this is the flag they read.
   */
  it('reports an active gesture for the whole open transaction', () => {
    expect(isGestureActive()).toBe(false);
    expect(beginLiveEdit('clipTransform', 'Konum değiştirildi')).toBe(true);
    expect(isGestureActive()).toBe(true);
    expect(isLiveEditBlocked(), 'open, not blocked').toBe(false);
    updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: 0.5 }));
    endLiveEdit();
    expect(isGestureActive()).toBe(false);
  });

  it('closes the previous gesture when a new one begins', () => {
    beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi');
    updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: 0.8 }));
    expect(beginLiveEdit('clipAudio', 'Ses seviyesi değiştirildi')).toBe(true);
    updateLiveEdit((d) => void applyClipAudioToDraft(d, [CLIP_A], { volume: 0.6 }));
    endLiveEdit();
    expect(useDocStore.getState().history).toHaveLength(2);
    expect(volume()).toBe(0.6);
  });
});
