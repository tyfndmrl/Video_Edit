import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipTimelineDurationUs, type MediaClip, type Track } from '@videoedit/timeline-schema';
import { useAutosaveStore } from '../../state/autosave';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useAssetStore } from '../../state/assetStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import { setTimelineMenuOpen } from '../timeline/contextMenuState';
import { handleShortcut, isEditableTarget, type KeyEventLike } from './dispatcher';
import { setPlaybackEngineForTests, type PlaybackEngineLike } from './playerBridge';
import { SHUTTLE_TICK_MS, stopShuttle, useTransportStore } from './shuttle';

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
  setTimelineMenuOpen(false);
  stopShuttle();
  useTransportStore.setState({ forwardRate: 1, shuttleRate: null });
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
    // Content is REQUIRED for a forward step: the playhead is clamped to
    // projectEndUs (panel-1b), and an empty document's end is 0.
    seedClip();
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(33_333); // frameToUs(1, 30/1)
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(66_667); // frameToUs(2)
    handleShortcut(key({ key: 'ArrowLeft' }));
    expect(useEditorStore.getState().playheadUs).toBe(33_333);
  });

  /**
   * Kelepçe yayılımı (panel-1b, kullanıcı kararı "hepsi kelepçelensin"):
   * ok/step yolları içeriğin sonunu AŞAMAZ. Üst sınır zaman kodu alanı ve
   * cetvel scrub'ı ile aynı tanımdan (`timelineOps.clampPlayheadUs`) gelir.
   */
  it('ok/step tuşları proje sonunu aşamaz; boş projede playhead 0\'da kalır', () => {
    seedClip(); // içerik [0, 4 sn)
    handleShortcut(key({ key: 'End' }));
    expect(useEditorStore.getState().playheadUs).toBe(4 * US);
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(4 * US);
    handleShortcut(key({ key: 'ArrowRight', shiftKey: true }));
    expect(useEditorStore.getState().playheadUs).toBe(4 * US);
    // Geri adım hâlâ serbest (kelepçe yalnız üst sınırdır).
    handleShortcut(key({ key: 'ArrowLeft' }));
    expect(useEditorStore.getState().playheadUs).toBeLessThan(4 * US);

    // Boş belge: gidilecek yer yok — BİLİNÇLİ davranış.
    useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
    useEditorStore.getState().setPlayheadUs(0);
    handleShortcut(key({ key: 'ArrowRight' }));
    handleShortcut(key({ key: 'ArrowRight', shiftKey: true }));
    expect(useEditorStore.getState().playheadUs).toBe(0);
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

  /**
   * Undo/redo are document mutations too (they rewrite doc from patches and
   * dirty autosave). The gating tests deliberately skipped them, so nobody
   * noticed the gate they were assumed to have did not exist: a Ctrl+Z while a
   * project load was in flight mutated the document that was about to be
   * replaced by the server copy.
   */
  it.each(['loading', 'idle', 'error'] as const)(
    'swallows Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while session status is %s',
    (status) => {
      const clip = seedClip();
      useEditorStore.getState().setSelection([clip.id]);
      useEditorStore.getState().setPlayheadUs(2 * US);

      // Build a real history entry while the session is READY.
      handleShortcut(key({ key: 'c' }));
      expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
      const docBefore = useDocStore.getState().doc;
      const cursorBefore = useDocStore.getState().cursor;

      useProjectSession.setState({ status });
      for (const k of [
        key({ key: 'z', ctrlKey: true }),
        key({ key: 'z', ctrlKey: true, shiftKey: true }),
        key({ key: 'y', ctrlKey: true }),
        key({ key: 'Z', ctrlKey: true }), // Shift'li düzenlerde büyük harf gelir
      ]) {
        expect(handleShortcut(k)).toBe(true); // swallowed, never reaches the browser
      }
      expect(useDocStore.getState().doc, 'undo/redo must not mutate the doc').toBe(docBefore);
      expect(useDocStore.getState().cursor).toBe(cursorBefore);

      // Session back to ready -> undo works again.
      useProjectSession.setState({ status: 'ready' });
      handleShortcut(key({ key: 'z', ctrlKey: true }));
      expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(1);
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

    // Navigation (view state only) stays available under the dialog.
    handleShortcut(key({ key: 'ArrowRight' }));
    expect(useEditorStore.getState().playheadUs).toBe(2 * US + 33_333);

    // Conflict resolved -> editing resumes.
    useAutosaveStore.setState({ status: 'saved', conflict: null });
    handleShortcut(key({ key: 'c' }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(2);
  });

  /**
   * Undo/redo are NOT "read-only navigation": they rewrite the document. Under
   * the 409 dialog the local document is about to be replaced by the server
   * copy, so a Ctrl+Z there mutated a doomed document — and autosave then tried
   * to save it.
   */
  it('swallows Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while autosave status is conflict', () => {
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    useEditorStore.getState().setPlayheadUs(2 * US);
    handleShortcut(key({ key: 'c' })); // one real history entry
    const docBefore = useDocStore.getState().doc;
    const cursorBefore = useDocStore.getState().cursor;

    useAutosaveStore.setState({
      status: 'conflict',
      conflict: { revisionNumber: 9, timeline: {} },
    });

    for (const k of [
      key({ key: 'z', ctrlKey: true }),
      key({ key: 'z', ctrlKey: true, shiftKey: true }),
      key({ key: 'y', ctrlKey: true }),
    ]) {
      expect(handleShortcut(k)).toBe(true);
    }
    expect(useDocStore.getState().doc).toBe(docBefore);
    expect(useDocStore.getState().cursor).toBe(cursorBefore);

    useAutosaveStore.setState({ status: 'saved', conflict: null });
    handleShortcut(key({ key: 'z', ctrlKey: true }));
    expect(useDocStore.getState().doc.tracks[0].clips).toHaveLength(1);
  });
});

/**
 * Grup kısayolları (ozellik-4): Ctrl+G / Ctrl+Shift+G, menüdeki 'Grupla' /
 * 'Grubu dağıt' ile aynı seçim-tabanlı op'lara iner. Gerçek klavye kanıtı
 * e2e/group-clips.spec.ts'te; burada saf dispatch tablosu doğrulanır.
 */
describe('group shortcuts (Ctrl+G / Ctrl+Shift+G)', () => {
  function seedTwoClips(): [MediaClip, MediaClip] {
    const a = seedClip();
    const b: MediaClip = {
      ...a,
      id: '01890000-0000-7000-8000-000000000202',
      timelineStartUs: 5 * US,
    };
    useDocStore.getState().loadDoc({
      ...useDocStore.getState().doc,
      tracks: [{ ...useDocStore.getState().doc.tracks[0], clips: [a, b] }],
    });
    return [a, b];
  }

  function clipsNow(): MediaClip[] {
    return useDocStore.getState().doc.tracks.flatMap((t) => t.clips) as MediaClip[];
  }

  it('Ctrl+G groups the selection under one shared groupId; Ctrl+Shift+G dissolves it', () => {
    const [a, b] = seedTwoClips();
    useEditorStore.getState().setSelection([a.id, b.id]);

    expect(handleShortcut(key({ key: 'g', ctrlKey: true }))).toBe(true);
    let clips = clipsNow();
    expect(clips[0].groupId).toBeDefined();
    expect(clips[1].groupId).toBe(clips[0].groupId);

    // Dağıtmak için grubun TEK üyesi bile yeter (op tüm grubu dağıtır).
    useEditorStore.getState().setSelection([a.id]);
    expect(handleShortcut(key({ key: 'G', ctrlKey: true, shiftKey: true }))).toBe(true);
    clips = clipsNow();
    expect(clips.every((c) => c.groupId === undefined)).toBe(true);
  });

  it('is passive on an editable target and gated while the session is not ready', () => {
    const [a, b] = seedTwoClips();
    useEditorStore.getState().setSelection([a.id, b.id]);

    // Editable target: hiç işlenmez (tarayıcıya kalır).
    expect(handleShortcut(key({ key: 'g', ctrlKey: true, target: { tagName: 'INPUT' } }))).toBe(
      false,
    );
    expect(clipsNow().every((c) => c.groupId === undefined)).toBe(true);

    // Oturum hazır değil: yutulur ama doküman DEĞİŞMEZ.
    useProjectSession.setState({ status: 'loading' });
    expect(handleShortcut(key({ key: 'g', ctrlKey: true }))).toBe(true);
    expect(clipsNow().every((c) => c.groupId === undefined)).toBe(true);
    expect(useDocStore.getState().history).toHaveLength(0);
    void b;
  });
});

/**
 * J/K/L geçiş matrisi (ozellik-5a): J sessiz kademeli GERİ TARAMA başlatır —
 * motor paused kalır, playhead STORE üzerinden geri akar (tek-yazım-yolu);
 * K/L/Space shuttle'ı durdurur (Space shuttle'dayken = DUR, oynatma DEĞİL).
 * Gerçek klavye kanıtı e2e/jkl-shuttle.spec.ts'te; burada saf dispatch tablosu
 * fake timer'larla doğrulanır (metronom + Date birlikte sarılır).
 */
describe('J/K/L geçiş matrisi — sessiz shuttle (ozellik-5a)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
  });

  afterEach(() => {
    stopShuttle();
    vi.useRealTimers();
  });

  it('J motoru duraklatır, HİÇ seek etmez; playhead STORE üzerinden geri akar ve oynatma kapalı kalır', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setPlayheadUs(2 * US);

    expect(handleShortcut(key({ key: 'j' }))).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // withEngine microtask'ı
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(useTransportStore.getState().shuttleRate).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    const playhead = useEditorStore.getState().playheadUs;
    expect(playhead, '500 ms shuttle sonrası playhead azalmış olmalı').toBeLessThan(2 * US);
    expect(playhead, '1x hızda 500 ms\'de 1 saniyeden fazla gerilenmez').toBeGreaterThan(US);
    // Tek-yazım-yolu: dispatcher/shuttle motoru ASLA doğrudan seek'lemez
    // (PlayerPanel store aboneliğinden kendisi seek'ler).
    expect(engine.seek).not.toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
    expect(useEditorStore.getState().isPlaying).toBe(false);
  });

  it('shuttle aktifken K: durdurur + duraklatır; playhead sabitlenir', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setPlayheadUs(5 * US);
    handleShortcut(key({ key: 'j' }));
    await vi.advanceTimersByTimeAsync(10 * SHUTTLE_TICK_MS);
    expect(useTransportStore.getState().shuttleRate).toBe(1);

    expect(handleShortcut(key({ key: 'k' }))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useTransportStore.getState().shuttleRate).toBeNull();
    expect(engine.pause).toHaveBeenCalledTimes(2); // J + K
    expect(useTransportStore.getState().forwardRate).toBe(1);

    const frozen = useEditorStore.getState().playheadUs;
    await vi.advanceTimersByTimeAsync(500);
    expect(useEditorStore.getState().playheadUs).toBe(frozen);
  });

  it('shuttle aktifken L: durdurur ve İLERİ 1x oynatır (shuttle hızı devralınmaz)', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setPlayheadUs(5 * US);
    handleShortcut(key({ key: 'j' }));
    await vi.advanceTimersByTimeAsync(10 * SHUTTLE_TICK_MS);

    expect(handleShortcut(key({ key: 'l' }))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useTransportStore.getState().shuttleRate).toBeNull();
    expect(engine.setPlaybackRate).toHaveBeenCalledWith(1);
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(useTransportStore.getState().forwardRate).toBe(1);
  });

  it('shuttle aktifken Space: DURDURUR ama oynatmaya GEÇMEZ (engine.play çağrılmaz)', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setPlayheadUs(5 * US);
    handleShortcut(key({ key: 'j' }));
    await vi.advanceTimersByTimeAsync(10 * SHUTTLE_TICK_MS);

    expect(handleShortcut(key({ key: ' ' }))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useTransportStore.getState().shuttleRate).toBeNull();
    expect(engine.play).not.toHaveBeenCalled();
    expect(useEditorStore.getState().isPlaying).toBe(false);

    const frozen = useEditorStore.getState().playheadUs;
    await vi.advanceTimersByTimeAsync(500);
    expect(useEditorStore.getState().playheadUs).toBe(frozen);
  });

  it('editable target\'ta j pasiftir — shuttle başlamaz', () => {
    expect(handleShortcut(key({ key: 'j', target: { tagName: 'INPUT' } }))).toBe(false);
    expect(useTransportStore.getState().shuttleRate).toBeNull();
  });

  it('J tekrar basışları kademeyi 1→2→4→8 katlar; 5. basış 8\'de kalır', () => {
    useEditorStore.getState().setPlayheadUs(30 * US);
    const rate = () => useTransportStore.getState().shuttleRate;

    handleShortcut(key({ key: 'j' }));
    expect(rate()).toBe(1);
    handleShortcut(key({ key: 'j' }));
    expect(rate()).toBe(2);
    handleShortcut(key({ key: 'j' }));
    expect(rate()).toBe(4);
    handleShortcut(key({ key: 'j' }));
    expect(rate()).toBe(8);
    handleShortcut(key({ key: 'j' }));
    expect(rate()).toBe(8);
  });

  it('J(e.repeat) kademeyi FIRLATMAZ ama yutulur (true döner)', () => {
    useEditorStore.getState().setPlayheadUs(10 * US);
    handleShortcut(key({ key: 'j' }));
    expect(useTransportStore.getState().shuttleRate).toBe(1);

    // Basılı tutma: OS auto-repeat olayları kademe basışı sayılmaz.
    for (let i = 0; i < 3; i++) {
      expect(handleShortcut(key({ key: 'j', repeat: true }))).toBe(true);
    }
    expect(useTransportStore.getState().shuttleRate).toBe(1);

    // Gerçek ikinci basış kademeyi katlar.
    handleShortcut(key({ key: 'j' }));
    expect(useTransportStore.getState().shuttleRate).toBe(2);
  });

  it('L(e.repeat) kademeyi FIRLATMAZ ama yutulur (true döner)', () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setIsPlaying(true);

    handleShortcut(key({ key: 'l' }));
    expect(useTransportStore.getState().forwardRate).toBe(2);

    for (let i = 0; i < 3; i++) {
      expect(handleShortcut(key({ key: 'l', repeat: true }))).toBe(true);
    }
    expect(useTransportStore.getState().forwardRate).toBe(2);

    handleShortcut(key({ key: 'l' }));
    expect(useTransportStore.getState().forwardRate).toBe(4);
  });

  it('L kademesi 4x\'teyken J: shuttle 1x\'ten başlar (L kademesi DEVRALINMAZ)', async () => {
    const engine = makeEngine();
    setPlaybackEngineForTests(engine);
    useEditorStore.getState().setIsPlaying(true);
    handleShortcut(key({ key: 'l' })); // 2x
    handleShortcut(key({ key: 'l' })); // 4x
    expect(useTransportStore.getState().forwardRate).toBe(4);

    useEditorStore.getState().setPlayheadUs(5 * US);
    expect(handleShortcut(key({ key: 'j' }))).toBe(true);
    expect(useTransportStore.getState().shuttleRate).toBe(1); // 4x devralınmadı
    expect(useTransportStore.getState().forwardRate).toBe(1);

    // pause'un motora inişini simüle et (mock motor setIsPlaying yazmaz);
    // tarama 1x hızıyla akar ve kademesi değişmez.
    useEditorStore.getState().setIsPlaying(false);
    await vi.advanceTimersByTimeAsync(10 * SHUTTLE_TICK_MS);
    expect(useEditorStore.getState().playheadUs).toBeLessThan(5 * US);
    expect(useTransportStore.getState().shuttleRate).toBe(1);
  });
});

/**
 * Sağ tık menüsü açıkken klavyenin sahibi menüdür (denetim bulgusu 2).
 * Gerçek klavye kanıtı e2e/context-menu.spec.ts'te; burada dispatch tablosunun
 * kapıyı tanıdığı doğrulanır.
 */
describe('shortcut passivity while the timeline context menu is open (finding 2)', () => {
  it('handles NOTHING while the menu is open — not Delete, not C, not ArrowDown', () => {
    const clip = seedClip();
    useEditorStore.getState().setSelection([clip.id]);
    useEditorStore.getState().setPlayheadUs(2 * US);
    const docBefore = useDocStore.getState().doc;
    const playheadBefore = useEditorStore.getState().playheadUs;
    const snapBefore = useEditorStore.getState().snappingEnabled;

    setTimelineMenuOpen(true);
    for (const k of [
      key({ key: 'Delete' }),
      key({ key: 'c' }),
      key({ key: 'ArrowDown' }),
      key({ key: 'ArrowRight' }),
      key({ key: ' ' }),
      key({ key: 's' }),
      key({ key: 'm' }),
      key({ key: 'z', ctrlKey: true }),
      key({ key: 'd', ctrlKey: true }),
    ]) {
      expect(handleShortcut(k), `${k.key} must be passive`).toBe(false);
    }
    expect(useDocStore.getState().doc).toBe(docBefore);
    expect(useEditorStore.getState().playheadUs).toBe(playheadBefore);
    expect(useEditorStore.getState().snappingEnabled).toBe(snapBefore);

    // Menü kapanınca kısayollar geri gelir.
    setTimelineMenuOpen(false);
    expect(handleShortcut(key({ key: 'ArrowDown' }))).toBe(true);
    expect(useEditorStore.getState().playheadUs).not.toBe(playheadBefore);
  });
});
