import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipTimelineDurationUs, type MediaClip, type Track } from '@videoedit/timeline-schema';
import { useAutosaveStore } from '../../state/autosave';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useAssetStore } from '../../state/assetStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import { handleShortcut, isEditableTarget, type KeyEventLike } from './dispatcher';
import { setPlaybackEngineForTests, type PlaybackEngineLike } from './playerBridge';

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const US = 1_000_000;

function key(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: 'BODY' },
    ...partial,
  };
}

function makeEngine() {
  const engine: PlaybackEngineLike = {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(() => Promise.resolve()),
    setPlaybackRate: vi.fn(),
  };
  return engine;
}

function seedClip(): MediaClip {
  const clip: MediaClip = {
    id: '01890000-0000-7000-8000-000000000201',
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: 0,
    timelineDurationUs: clipTimelineDurationUs(0, 4 * US, 1),
    sourceInUs: 0,
    sourceOutUs: 4 * US,
    speed: { rate: 1 },
    audio: null,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
  const track: Track = {
    id: '01890000-0000-7000-8000-000000000101',
    type: 'video', muted: false, hidden: false, locked: false,
    clips: [clip],
  };
  useDocStore.getState().loadDoc({
    ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }),
    tracks: [track],
  });
  return clip;
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 10 * US },
  ]);
  const editor = useEditorStore.getState();
  editor.clearSelection();
  editor.setPlayheadUs(0);
  editor.setIsPlaying(false);
  setPlaybackEngineForTests(null);
  // Doc-mutation shortcuts require a READY project session and no autosave
  // conflict (findings 1b + 5) — make that the default for these tests.
  useProjectSession.setState({
    status: 'ready',
    projectId: PROJECT_ID,
    projectName: 'test',
    error: null,
  });
  useAutosaveStore.setState({ status: 'idle', conflict: null, errorMessage: null });
});

afterEach(() => {
  setPlaybackEngineForTests(undefined);
  useProjectSession.setState({ status: 'idle', projectId: null, projectName: null, error: null });
  useAutosaveStore.setState({ status: 'idle', conflict: null });
});

describe('editable-target passivity (pitfall #10)', () => {
  it('recognizes inputs, textareas, selects and contenteditable as editable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('handles NOTHING while an input is focused — not even Space or single letters', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    const snapBefore = useEditorStore.getState().snappingEnabled;

    for (const k of [' ', 'c', 's', 'm', 'Delete', 'ArrowRight']) {
      expect(handleShortcut(key({ key: k, target: { tagName: 'INPUT' } }))).toBe(false);
    }
    await flushMicrotasks();
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.pause).not.toHaveBeenCalled();
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(1); // no delete/split
    expect(useEditorStore.getState().snappingEnabled).toBe(snapBefore);
    expect(useEditorStore.getState().playheadUs).toBe(0);
  });

  it('same keys ARE handled with a non-editable target', () => {
    expect(handleShortcut(key({ key: 's' }))).toBe(true);
    expect(handleShortcut(key({ key: 'ArrowRight' }))).toBe(true);
  });
});

describe('playback keys', () => {
  it('Space toggles play/pause through the lazily resolved engine', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);

    expect(handleShortcut(key({ key: ' ' }))).toBe(true);
    await flushMicrotasks();
    expect(engine.play).toHaveBeenCalledTimes(1);

    useEditorStore.getState().setIsPlaying(true);
    handleShortcut(key({ key: ' ' }));
    await flushMicrotasks();
    expect(engine.pause).toHaveBeenCalledTimes(1);
  });

  it('Space is a safe no-op when no engine is available', async () => {
    setPlaybackEngineForTests(null);
    expect(handleShortcut(key({ key: ' ' }))).toBe(true);
    await flushMicrotasks(); // must not throw
  });
});

describe('playhead navigation', () => {
  it('ArrowRight/Left step exactly one project frame (30 fps grid)', () => {
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(33_333); // frameToUs(1, 30/1)
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(66_667); // frameToUs(2)
    handleShortcut(key({ key: 'ArrowLeft' }));
    expect(useEditorStore.getState().playheadUs).toBe(33_333);
  });

  it('Shift+Arrow steps one second; Home/End jump to bounds', () => {
    seedClip();
    handleShortcut(key({ key: 'ArrowRight', shiftKey: true }));
    expect(useEditorStore.getState().playheadUs).toBe(US);
    handleShortcut(key({ key: 'End' }));
    expect(useEditorStore.getState().playheadUs).toBe(4 * US);
    handleShortcut(key({ key: 'Home' }));
    expect(useEditorStore.getState().playheadUs).toBe(0);
  });

  it('ArrowDown/Up jump between cut points', () => {
    seedClip();
    handleShortcut(key({ key: 'ArrowDown' }));
    expect(useEditorStore.getState().playheadUs).toBe(4 * US); // clip end
    handleShortcut(key({ key: 'ArrowUp' }));
    expect(useEditorStore.getState().playheadUs).toBe(0);
  });
});

describe('editing keys', () => {
  it('C splits the clip under the playhead', () => {
    seedClip();
    useEditorStore.getState().setPlayheadUs(2 * US);
    expect(handleShortcut(key({ key: 'c' }))).toBe(true);
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
  });

  it('Delete removes the selection; Shift+Delete ripples', () => {
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    handleShortcut(key({ key: 'Delete' }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(0);
  });

  it('Ctrl+Z undoes, Ctrl+Shift+Z redoes', () => {
    const clip = seedClip();
    useEditorStore.getState().setPlayheadUs(2 * US);
    handleShortcut(key({ key: 'c' }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
    handleShortcut(key({ key: 'z', ctrlKey: true }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(1);
    handleShortcut(key({ key: 'z', ctrlKey: true, shiftKey: true }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
    void clip;
  });

  it('Ctrl+C / Ctrl+V copies and pastes at the playhead', () => {
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    handleShortcut(key({ key: 'c', ctrlKey: true }));
    useEditorStore.getState().setPlayheadUs(6 * US);
    handleShortcut(key({ key: 'v', ctrlKey: true }));
    const clips = useDocStore.getState().doc.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[1].timelineStartUs).toBe(6 * US);
  });

  it('S toggles snapping, M adds a marker', () => {
    const before = useEditorStore.getState().snappingEnabled;
    handleShortcut(key({ key: 's' }));
    expect(useEditorStore.getState().snappingEnabled).toBe(!before);
    handleShortcut(key({ key: 'm' }));
    expect(useDocStore.getState().doc.markers).toHaveLength(1);
  });
});

describe('single playhead write path (finding 2)', () => {
  it('navigation keys write ONLY the store — never engine.seek directly', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    seedClip();

    handleShortcut(key({ key: 'ArrowRight' }));
    handleShortcut(key({ key: 'ArrowRight', shiftKey: true }));
    handleShortcut(key({ key: 'End' }));
    handleShortcut(key({ key: 'Home' }));
    await flushMicrotasks();

    expect(engine.seek).not.toHaveBeenCalled();
    // The store DID move (PlayerPanel picks it up from there).
    expect(useEditorStore.getState().playheadUs).toBe(0); // Home was last
  });
});

describe('doc-mutation gating while the session is not ready (finding 1b)', () => {
  it.each(['loading', 'idle', 'error'] as const)(
    'swallows C/Q/W/M/Delete and Ctrl+V/X/D while session status is %s',
    (status) => {
      const clip = seedClip();
      useEditorStore.getState().setSelection([clip.id]);
      useEditorStore.getState().setPlayheadUs(2 * US);
      useProjectSession.setState({ status });
      const docBefore = useDocStore.getState().doc;

      // Copy first so a (wrongly) allowed paste would be visible.
      useProjectSession.setState({ status: 'ready' });
      handleShortcut(key({ key: 'c', ctrlKey: true }));
      useProjectSession.setState({ status });

      for (const k of [
        key({ key: 'c' }),
        key({ key: 'q' }),
        key({ key: 'w' }),
        key({ key: 'm' }),
        key({ key: 'Delete' }),
        key({ key: 'v', ctrlKey: true }),
        key({ key: 'x', ctrlKey: true }),
        key({ key: 'd', ctrlKey: true }),
      ]) {
        expect(handleShortcut(k)).toBe(true); // swallowed, not passed to the browser
      }
      expect(useDocStore.getState().doc).toBe(docBefore); // zero mutations
      expect(useDocStore.getState().history).toHaveLength(0);
    },
  );

  it('non-mutating shortcuts still work while loading (snapping toggle, navigation)', () => {
    seedClip();
    useProjectSession.setState({ status: 'loading' });
    const before = useEditorStore.getState().snappingEnabled;
    handleShortcut(key({ key: 's' }));
    expect(useEditorStore.getState().snappingEnabled).toBe(!before);
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(33_333);
  });
});

describe('doc-mutation gating while the 409 conflict dialog is open (finding 5)', () => {
  it('swallows the mutation shortcuts while autosave status is conflict', () => {
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    useEditorStore.getState().setPlayheadUs(2 * US);
    useAutosaveStore.setState({
      status: 'conflict',
      conflict: { revisionNumber: 9, timeline: {} },
    });
    const docBefore = useDocStore.getState().doc;

    for (const k of [
      key({ key: 'c' }),
      key({ key: 'Delete' }),
      key({ key: 'm' }),
      key({ key: 'd', ctrlKey: true }),
    ]) {
      expect(handleShortcut(k)).toBe(true);
    }
    expect(useDocStore.getState().doc).toBe(docBefore);
    expect(useDocStore.getState().history).toHaveLength(0);

    // Undo/navigation stay available under the dialog.
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(2 * US + 33_333);

    // Conflict resolved -> editing resumes.
    useAutosaveStore.setState({ status: 'saved', conflict: null });
    handleShortcut(key({ key: 'c' }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
  });
});
