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
import { applyClipAudioToDraft, addTextClip, applyClipTextToDraft } from '../../state/timelineOps';
import { defaultTextStyle } from '../text/overlayDefaults';
import { useEditorStore } from '../../state/editorStore';
import {
  BURST_EDIT_IDLE_MS,
  beginBurstEdit,
  beginLiveEdit,
  captureEditAnchor,
  editAnchorPlayheadUs,
  endBurstEdit,
  endLiveEdit,
  isBurstEditOpen,
  isGestureActive,
  isLiveEditBlocked,
  isLiveEditOpen,
  runWithEditAnchor,
  updateBurstEdit,
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
  endBurstEdit();
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

/**
 * Edit anchors — "an edit belongs to the instant it was WRITTEN".
 *
 * These are the store-level rules only; that the Inspector's keyframe writes
 * actually consult them is proven with real mouse/keyboard in
 * e2e/inspector-edit-anchor.spec.ts.
 */
describe('edit anchors', () => {
  beforeEach(() => {
    endLiveEdit();
    useEditorStore.getState().setPlayheadUs(0);
  });

  it('reports no anchor while nothing is being edited', () => {
    useEditorStore.getState().setPlayheadUs(7 * US);
    expect(editAnchorPlayheadUs()).toBeNull();
  });

  it('holds the pointerdown playhead for the whole gesture, even while playback moves it', () => {
    useEditorStore.getState().setPlayheadUs(63 * US);
    expect(beginLiveEdit('clipTransform', 'Konum değiştirildi')).toBe(true);
    expect(editAnchorPlayheadUs()).toBe(63 * US);

    // Playback keeps running underneath the drag.
    useEditorStore.getState().setPlayheadUs(63.5 * US);
    expect(
      editAnchorPlayheadUs(),
      'sürükleme başladığı ana çapalı kalmalı — yoksa tek jest birçok keyframe yazar',
    ).toBe(63 * US);

    endLiveEdit();
    expect(editAnchorPlayheadUs()).toBeNull();
  });

  it('applies a deferred commit against its own anchor, then restores', () => {
    const anchor = captureEditAnchor(); // "the user typed here"
    useEditorStore.getState().setPlayheadUs(65 * US); // ...then clicked the ruler
    expect(editAnchorPlayheadUs()).toBeNull();

    const seen = runWithEditAnchor(anchor, () => editAnchorPlayheadUs());
    expect(seen, 'commit yazıldığı ana gitmeli').toBe(0);
    expect(editAnchorPlayheadUs(), 'çapa commit dışına SIZMAMALI').toBeNull();
  });

  it('restores the previous anchor even when the commit throws', () => {
    useEditorStore.getState().setPlayheadUs(10 * US);
    beginLiveEdit('clipTransform', 'Konum değiştirildi');
    expect(() =>
      runWithEditAnchor(captureEditAnchor(), () => {
        throw new Error('op failed');
      }),
    ).toThrow('op failed');
    expect(editAnchorPlayheadUs()).toBe(10 * US);
    endLiveEdit();
  });

  it('lets a commit anchor win over the gesture anchor', () => {
    useEditorStore.getState().setPlayheadUs(20 * US);
    beginLiveEdit('clipTransform', 'Konum değiştirildi');
    useEditorStore.getState().setPlayheadUs(30 * US);
    const later = captureEditAnchor();
    expect(runWithEditAnchor(later, () => editAnchorPlayheadUs())).toBe(30 * US);
    expect(editAnchorPlayheadUs()).toBe(20 * US);
    endLiveEdit();
  });
});

/**
 * Burst edits (typing into the text content field, dragging in the colour
 * picker). The regression this guards is NOT cosmetic: an open transaction
 * makes the next `docStore.beginTransaction` (every timeline/gizmo drag) THROW,
 * so a burst that fails to close crashes the editor on the next clip drag.
 */
describe('burst edits (typing / colour picker)', () => {
  const inField = () => true;

  function seedTextClipId(): string {
    const result = addTextClip(defaultTextStyle(defaultProjectSettings), { newTrack: true }, 0);
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
    return result.clipId;
  }

  function textContentOf(clipId: string): string {
    for (const t of useDocStore.getState().doc.tracks) {
      for (const c of t.clips) if (c.id === clipId && c.kind === 'text') return c.text.content;
    }
    throw new Error('text clip not found');
  }

  /**
   * The module listens on `window`; the vitest env is node, so the test
   * installs the smallest possible stand-in and fires the listener itself.
   * (A real browser press is covered by e2e/text.spec.ts — this only proves the
   * wiring.)
   */
  function withFakeWindow(): { fire: (target: unknown) => void; restore: () => void } {
    const listeners = new Set<(e: unknown) => void>();
    const fake = {
      addEventListener: (type: string, cb: (e: unknown) => void) => {
        if (type === 'pointerdown') listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: (e: unknown) => void) => {
        listeners.delete(cb);
      },
    };
    (globalThis as { window?: unknown }).window = fake;
    return {
      fire: (target) => {
        for (const cb of [...listeners]) cb({ target });
      },
      restore: () => {
        delete (globalThis as { window?: unknown }).window;
      },
    };
  }

  it('collapses a whole typed sentence into ONE history entry', () => {
    const clipId = seedTextClipId();
    const before = useDocStore.getState().history.length;
    expect(beginBurstEdit('clipText', 'Metin içeriği değiştirildi', inField)).toBe(true);
    expect(isBurstEditOpen()).toBe(true);
    for (const text of ['M', 'Me', 'Mer', 'Merh', 'Merha', 'Merhab', 'Merhaba']) {
      updateBurstEdit((d) => void applyClipTextToDraft(d, [clipId], { content: text }));
    }
    endBurstEdit();

    expect(isBurstEditOpen()).toBe(false);
    expect(textContentOf(clipId)).toBe('Merhaba');
    expect(useDocStore.getState().history.length).toBe(before + 1);
    expect(useDocStore.getState().history.at(-1)?.label).toBe('Metin içeriği değiştirildi');

    useDocStore.getState().undo();
    expect(textContentOf(clipId), 'tek Ctrl+Z tüm yazımı geri almalı').toBe('Metin');
  });

  it('is a no-op when it could not open (locked document / another transaction)', () => {
    const clipId = seedTextClipId();
    useDocStore.getState().setLocked(true);
    expect(beginBurstEdit('clipText', 'Metin içeriği değiştirildi', inField)).toBe(false);
    updateBurstEdit((d) => void applyClipTextToDraft(d, [clipId], { content: 'X' }));
    useDocStore.getState().setLocked(false);
    expect(textContentOf(clipId), 'kilitliyken yazı dokümana sızmamalı').toBe('Metin');

    const tx = useDocStore.getState().beginTransaction('move', 'Klip taşındı');
    expect(beginBurstEdit('clipText', 'Metin içeriği değiştirildi', inField)).toBe(false);
    tx.commit();
  });

  /**
   * The load-bearing terminator: a pointerdown OUTSIDE the field must close the
   * burst BEFORE a timeline drag opens its own transaction.
   */
  it('closes on a pointerdown outside the field, so the next drag can begin', () => {
    const clipId = seedTextClipId();
    const win = withFakeWindow();
    try {
      const textarea: unknown = { tag: 'textarea' };
      expect(
        beginBurstEdit('clipText', 'Metin içeriği değiştirildi', (t) => (t as unknown) === textarea),
      ).toBe(true);
      updateBurstEdit((d) => void applyClipTextToDraft(d, [clipId], { content: 'yarım' }));

      win.fire(textarea); // press inside the field: the burst survives
      expect(isBurstEditOpen(), 'alanın İÇİNDEKİ tıklama yazımı bölmemeli').toBe(true);

      win.fire({ tag: 'timeline-canvas' }); // press anywhere else: closed
      expect(isBurstEditOpen()).toBe(false);
    } finally {
      win.restore();
      endBurstEdit();
    }

    // The store is free again — this would THROW if the burst had leaked.
    const tx = useDocStore.getState().beginTransaction('move', 'Klip taşındı');
    tx.abort();
    expect(textContentOf(clipId)).toBe('yarım');
  });

  it('yields to a pointer gesture: beginLiveEdit closes an open burst', () => {
    const clipId = seedTextClipId();
    beginBurstEdit('clipText', 'Metin içeriği değiştirildi', inField);
    updateBurstEdit((d) => void applyClipTextToDraft(d, [clipId], { content: 'yarım' }));
    expect(beginLiveEdit('clipTransform', 'Konum değiştirildi')).toBe(true);
    expect(isBurstEditOpen()).toBe(false);
    endLiveEdit();
    expect(textContentOf(clipId)).toBe('yarım');
  });

  it('closes itself after the idle timeout (autosave must not stay deferred)', async () => {
    const clipId = seedTextClipId();
    beginBurstEdit('clipText', 'Metin içeriği değiştirildi', inField);
    updateBurstEdit((d) => void applyClipTextToDraft(d, [clipId], { content: 'bekleyen' }));
    await new Promise((resolve) => setTimeout(resolve, BURST_EDIT_IDLE_MS + 100));
    expect(isBurstEditOpen(), 'boşta kalan burst kendi kendini kapatmalı').toBe(false);
    expect(useDocStore.getState().transactionOpen).toBe(false);
    expect(textContentOf(clipId)).toBe('bekleyen');
  });
});
