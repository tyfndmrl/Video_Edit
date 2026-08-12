import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaClip, TimelineDoc } from '@videoedit/timeline-schema';
import {
  createEmptyDoc,
  defaultProjectSettings,
  docGateAssetDurations,
  HISTORY_LIMIT,
  useDocStore,
} from './docStore';
import { useAssetStore } from './assetStore';
import { applyTrimToDraft, knownAssetDurations } from './timelineOps';

const PROJECT_ID = '01890000-0000-7000-8000-000000000000';
const TRACK_ID = '01890000-0000-7000-8000-0000000000a0';
const CLIP_ID = '01890000-0000-7000-8000-0000000000c0';
const ASSET_ID = '01890000-0000-7000-8000-0000000000e0';

function freshDoc() {
  return createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings });
}

/**
 * One 30 fps video track with one clip on the grid: start = frame 30
 * (1_000_000 µs), end = frame 90 (3_000_000 µs). Both edges are frame
 * boundaries, so the document passes the gate as-is and any violation below is
 * the one the test wrote.
 */
function docWithClip(): TimelineDoc {
  const clip: MediaClip = {
    id: CLIP_ID,
    kind: 'video',
    assetId: ASSET_ID,
    timelineStartUs: 1_000_000,
    timelineDurationUs: 2_000_000,
    sourceInUs: 0,
    sourceOutUs: 2_000_000,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
  return {
    ...freshDoc(),
    tracks: [
      {
        id: TRACK_ID,
        type: 'video',
        name: 'V1',
        muted: false,
        hidden: false,
        locked: false,
        clips: [clip],
      },
    ],
  };
}

function snapshot(): unknown {
  return JSON.parse(JSON.stringify(useDocStore.getState().doc));
}

beforeEach(() => {
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(freshDoc());
  useAssetStore.getState().setAssets([]);
});

describe('docStore.mutate', () => {
  it('produces exactly one undo step per mutate call', () => {
    const store = useDocStore.getState();
    store.mutate('setWidth', 'Set width', (d) => {
      d.settings.width = 1280;
      d.settings.height = 720;
    });

    const s = useDocStore.getState();
    expect(s.history).toHaveLength(1);
    expect(s.cursor).toBe(1);
    expect(s.doc.settings.width).toBe(1280);
    expect(s.history[0]!.actionType).toBe('setWidth');
    expect(s.history[0]!.label).toBe('Set width');

    s.undo();
    expect(useDocStore.getState().doc.settings.width).toBe(1920);
    expect(useDocStore.getState().doc.settings.height).toBe(1080);
  });

  it('does not record an entry for a no-op recipe', () => {
    useDocStore.getState().mutate('noop', 'Nothing', () => {});
    expect(useDocStore.getState().history).toHaveLength(0);
  });

  it('clears the redo stack on a new mutation after undo', () => {
    const store = useDocStore.getState();
    store.mutate('a', 'A', (d) => void (d.settings.width = 100));
    store.mutate('b', 'B', (d) => void (d.settings.width = 200));
    store.undo();
    expect(useDocStore.getState().canRedo()).toBe(true);

    store.mutate('c', 'C', (d) => void (d.settings.width = 300));
    const s = useDocStore.getState();
    expect(s.history).toHaveLength(2); // A then C — B discarded
    expect(s.history.map((e) => e.actionType)).toEqual(['a', 'c']);
    expect(s.canRedo()).toBe(false);
  });
});

describe('docStore transactions', () => {
  it('coalesces many updates into a single history entry on commit', () => {
    const before = snapshot();
    const tx = useDocStore.getState().beginTransaction('trim', 'Clip trimmed');
    for (let i = 1; i <= 10; i++) {
      tx.update((d) => void (d.settings.width = 1920 + i));
    }
    tx.commit();

    const s = useDocStore.getState();
    expect(s.history).toHaveLength(1);
    expect(s.doc.settings.width).toBe(1930);

    s.undo();
    expect(snapshot()).toEqual(before);
  });

  it('abort restores the pre-begin state and leaves no history trace', () => {
    const before = snapshot();
    const historyBefore = useDocStore.getState().history.length;

    const tx = useDocStore.getState().beginTransaction('move', 'Clips moved');
    tx.update((d) => void (d.settings.width = 640));
    tx.update((d) => {
      d.markers.push({ id: '01890000-0000-7000-8000-00000000000a', timeUs: 1_000_000 });
    });
    expect(useDocStore.getState().doc.settings.width).toBe(640);
    tx.abort();

    expect(snapshot()).toEqual(before);
    expect(useDocStore.getState().history).toHaveLength(historyBefore);
    expect(useDocStore.getState().canRedo()).toBe(false);
  });

  it('commit without changes records nothing', () => {
    const tx = useDocStore.getState().beginTransaction('noop', 'Nothing');
    tx.commit();
    expect(useDocStore.getState().history).toHaveLength(0);
  });

  it('rejects mutate/undo/redo/jumpTo/beginTransaction while a transaction is open', () => {
    const store = useDocStore.getState();
    const tx = store.beginTransaction('trim', 'Clip trimmed');
    tx.update((d) => void (d.settings.width = 800));

    const reentrant = /finish or abort the active transaction first/;
    expect(() => store.mutate('w', 'Width', (d) => void (d.settings.width = 1))).toThrow(
      reentrant,
    );
    expect(() => store.undo()).toThrow(reentrant);
    expect(() => store.redo()).toThrow(reentrant);
    expect(() => store.jumpTo(-1)).toThrow(reentrant);
    expect(() => store.beginTransaction('x', 'X')).toThrow(reentrant);

    // The rejected calls must not have corrupted the open transaction.
    tx.update((d) => void (d.settings.width = 900));
    tx.commit();
    const s = useDocStore.getState();
    expect(s.doc.settings.width).toBe(900);
    expect(s.history).toHaveLength(1);
  });

  it('QUEUES loadDoc while a transaction is open and applies it on commit (finding 1d)', () => {
    const store = useDocStore.getState();
    const incoming = freshDoc();
    incoming.settings.width = 4096;

    const tx = store.beginTransaction('trim', 'Clip trimmed');
    tx.update((d) => void (d.settings.width = 800));
    expect(useDocStore.getState().transactionOpen).toBe(true);

    expect(() => store.loadDoc(incoming)).not.toThrow();
    // Not applied yet — the gesture still owns the document.
    expect(useDocStore.getState().doc.settings.width).toBe(800);

    const loadSeqBefore = useDocStore.getState().loadSeq;
    tx.commit();
    const s = useDocStore.getState();
    expect(s.transactionOpen).toBe(false);
    expect(s.doc.settings.width).toBe(4096); // queued load replaced the doc
    expect(s.history).toHaveLength(0); // and cleared the history
    expect(s.cursor).toBe(0);
    expect(s.loadSeq).toBe(loadSeqBefore + 1);
  });

  it('QUEUES loadDoc while a transaction is open and applies it on abort too', () => {
    const store = useDocStore.getState();
    const incoming = freshDoc();
    incoming.settings.width = 2048;

    const tx = store.beginTransaction('move', 'Clips moved');
    tx.update((d) => void (d.settings.width = 640));
    store.loadDoc(incoming);
    tx.abort();

    const s = useDocStore.getState();
    expect(s.doc.settings.width).toBe(2048);
    expect(s.history).toHaveLength(0);
    expect(s.transactionOpen).toBe(false);
  });

  it('resumes normal operation after abort', () => {
    const store = useDocStore.getState();
    const tx = store.beginTransaction('move', 'Clips moved');
    tx.update((d) => void (d.settings.width = 640));
    tx.abort();

    // mutate works again and produces a normal history entry
    store.mutate('w', 'Width', (d) => void (d.settings.width = 1234));
    expect(useDocStore.getState().doc.settings.width).toBe(1234);
    expect(useDocStore.getState().history).toHaveLength(1);
    useDocStore.getState().undo();
    expect(useDocStore.getState().doc.settings.width).toBe(1920);

    // a new transaction can be opened, and the aborted one stays dead
    const tx2 = store.beginTransaction('trim', 'Trim');
    expect(() => tx.update((d) => void (d.settings.width = 1))).toThrow(
      /Transaction is already closed/,
    );
    tx2.commit();
  });
});

describe('docStore lock (project-loading window, finding 1c)', () => {
  it('refuses mutate while locked: throws in dev, document and history untouched', () => {
    const store = useDocStore.getState();
    store.setLocked(true);
    const widthBefore = useDocStore.getState().doc.settings.width;

    // vitest runs with import.meta.env.DEV === true -> loud failure.
    expect(() =>
      store.mutate('w', 'Width', (d) => void (d.settings.width = 123)),
    ).toThrow(/locked/);
    expect(useDocStore.getState().doc.settings.width).toBe(widthBefore);
    expect(useDocStore.getState().history).toHaveLength(0);

    // Unlock -> mutations work again.
    store.setLocked(false);
    store.mutate('w', 'Width', (d) => void (d.settings.width = 123));
    expect(useDocStore.getState().doc.settings.width).toBe(123);
  });

  it('refuses beginTransaction while locked', () => {
    const store = useDocStore.getState();
    store.setLocked(true);
    expect(() => store.beginTransaction('trim', 'Clip trimmed')).toThrow(/locked/);
    expect(useDocStore.getState().transactionOpen).toBe(false);
    store.setLocked(false);
  });

  it('loadDoc is ALLOWED while locked (it is the loading path itself)', () => {
    const store = useDocStore.getState();
    store.setLocked(true);
    const incoming = freshDoc();
    incoming.settings.width = 999;
    expect(() => store.loadDoc(incoming)).not.toThrow();
    expect(useDocStore.getState().doc.settings.width).toBe(999);
    store.setLocked(false);
  });

  /**
   * undo/redo/jumpTo REWRITE the document from patches and make autosave
   * dirty — they are mutations, and the lock exists precisely to keep edits
   * from racing an in-flight project load. They used to walk straight past the
   * lock: a history-panel click (or Ctrl+Z) during a load mutated the document
   * the server copy was about to replace, and autosave tried to save it.
   */
  it('refuses undo/redo/jumpTo while locked (they are doc mutations too)', () => {
    const store = useDocStore.getState();
    store.mutate('w', 'Width 1', (d) => void (d.settings.width = 111));
    store.mutate('w', 'Width 2', (d) => void (d.settings.width = 222));
    const docBefore = useDocStore.getState().doc;
    const cursorBefore = useDocStore.getState().cursor;

    store.setLocked(true);
    // vitest runs with import.meta.env.DEV === true -> loud failure.
    expect(() => store.undo()).toThrow(/locked/);
    expect(() => store.redo()).toThrow(/locked/);
    expect(() => store.jumpTo(-1)).toThrow(/locked/);
    expect(useDocStore.getState().doc, 'document must be untouched').toBe(docBefore);
    expect(useDocStore.getState().cursor).toBe(cursorBefore);

    // Unlock -> history navigation works again.
    store.setLocked(false);
    store.undo();
    expect(useDocStore.getState().doc.settings.width).toBe(111);
    store.jumpTo(-1);
    expect(useDocStore.getState().cursor).toBe(0);
    store.redo();
    expect(useDocStore.getState().doc.settings.width).toBe(111);
  });
});

describe('docStore undo/redo round-trip', () => {
  it('undo-all then redo-all reproduces every intermediate state exactly', () => {
    const store = useDocStore.getState();
    const states: unknown[] = [snapshot()];

    store.mutate('m1', 'Add marker', (d) => {
      d.markers.push({ id: '01890000-0000-7000-8000-000000000001', timeUs: 0, label: 'start' });
    });
    states.push(snapshot());
    store.mutate('m2', 'Resize', (d) => {
      d.settings.width = 1280;
      d.settings.height = 720;
    });
    states.push(snapshot());
    const tx = store.beginTransaction('m3', 'Drag');
    tx.update((d) => void (d.markers[0]!.timeUs = 500_000));
    tx.update((d) => void (d.markers[0]!.timeUs = 2_000_000));
    tx.commit();
    states.push(snapshot());

    // undo all the way down
    for (let i = states.length - 2; i >= 0; i--) {
      useDocStore.getState().undo();
      expect(snapshot()).toEqual(states[i]);
    }
    expect(useDocStore.getState().canUndo()).toBe(false);

    // redo all the way up
    for (let i = 1; i < states.length; i++) {
      useDocStore.getState().redo();
      expect(snapshot()).toEqual(states[i]);
    }
    expect(useDocStore.getState().canRedo()).toBe(false);
  });

  it('jumpTo applies/reverts the intermediate entries in one call', () => {
    const store = useDocStore.getState();
    for (let i = 1; i <= 5; i++) {
      store.mutate('w', `Width ${i}`, (d) => void (d.settings.width = 1000 + i));
    }
    useDocStore.getState().jumpTo(1); // entries 0..1 applied
    expect(useDocStore.getState().doc.settings.width).toBe(1002);
    expect(useDocStore.getState().cursor).toBe(2);

    useDocStore.getState().jumpTo(4);
    expect(useDocStore.getState().doc.settings.width).toBe(1005);

    useDocStore.getState().jumpTo(-1); // before the first entry
    expect(useDocStore.getState().doc.settings.width).toBe(1920);
  });
});

describe('docStore history limit', () => {
  it(`keeps at most ${HISTORY_LIMIT} entries, dropping the oldest`, () => {
    const store = useDocStore.getState();
    const total = HISTORY_LIMIT + 5;
    for (let i = 1; i <= total; i++) {
      store.mutate('w', `Width ${i}`, (d) => void (d.settings.width = i));
    }

    const s = useDocStore.getState();
    expect(s.history).toHaveLength(HISTORY_LIMIT);
    expect(s.cursor).toBe(HISTORY_LIMIT);
    expect(s.history[0]!.label).toBe(`Width ${total - HISTORY_LIMIT + 1}`);
    expect(s.history[HISTORY_LIMIT - 1]!.label).toBe(`Width ${total}`);

    // undoing everything that remains lands on the state after the dropped entries
    useDocStore.getState().jumpTo(-1);
    expect(useDocStore.getState().doc.settings.width).toBe(total - HISTORY_LIMIT);
  });
});

/**
 * The document gate at the COMMIT POINT.
 *
 * Why these tests exist: the gate used to be a line every op wrote after its
 * own mutation (`assertDocValidDev`). The ops did write it — and the paths that
 * do NOT go through an op did not: an interactive drag is
 * `beginTransaction` -> `tx.update(...)` -> `commit()`, and nothing in that
 * chain was checked. The unit suite could not see the hole either, because unit
 * tests call the op wrappers (which were checked) while the user's mouse takes
 * the transaction path (which was not).
 *
 * So the assertions below are deliberately written at the TRANSACTION level,
 * not through an op: they fail the moment the check leaves `commit()`.
 */
describe('docStore document gate (dev)', () => {
  /** End of the clip after the edit, in µs. */
  function clipEnd(): number {
    const clip = useDocStore.getState().doc.tracks[0]!.clips[0]!;
    return clip.timelineStartUs + clip.timelineDurationUs;
  }

  it('commit() REFUSES a transaction that pushed a clip edge off the frame grid (drag path)', () => {
    useDocStore.getState().loadDoc(docWithClip());
    const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
    // What a pointermove writes: an absolute edge. 3_000_040 µs is 40 µs past
    // frame 90 and 33_293 µs short of frame 91 — a value no export accepts.
    // sourceOut follows the duration so ONLY the grid rule can fail here.
    tx.update((d) => {
      const clip = d.tracks[0]!.clips[0]! as MediaClip;
      clip.timelineDurationUs = 2_000_040;
      clip.sourceOutUs = 2_000_040;
    });

    expect(
      () => tx.commit(),
      'Sürükleme yolu (transaction) kapıdan geçmiyor: kapı çağrı noktalarına ' +
        'geri taşınmış olabilir.',
    ).toThrow(/Export frame-grid violation/);
  });

  it('mutate() REFUSES a single-step op that violates the document invariants', () => {
    useDocStore.getState().loadDoc(docWithClip());
    expect(() =>
      useDocStore.getState().mutate('trim', 'Klip kırpıldı', (d) => {
        const clip = d.tracks[0]!.clips[0]! as MediaClip;
        // Duration formula (invariant 3) broken: duration != (out - in) / rate.
        clip.timelineDurationUs = 2_000_000;
        clip.sourceOutUs = 1_500_000;
      }),
    ).toThrow(/Timeline invariant violation/);
  });

  it('binds the source bound to the SAME asset map the ops plan with', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET_ID, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 7_320_000 },
      // A still image has no source clock; ffprobe's 0.04 s for a JPEG must not
      // become a bound (this exclusion is why the map is not just "durationUs").
      { id: '01890000-0000-7000-8000-0000000000e1', kind: 'image', name: 'a.jpg', status: 'ready', durationUs: 40_000 },
      // A null off the wire types as a number and compares as `x > null`.
      {
        id: '01890000-0000-7000-8000-0000000000e2',
        kind: 'video',
        name: 'b.mp4',
        status: 'processing',
        durationUs: null as unknown as undefined,
      },
    ]);
    // Two maps, one rule: if timelineOps.knownAssetDurations ever changes, the
    // gate must change with it (they are separate copies to keep the store from
    // importing the ops layer — see docGateAssetDurations).
    expect([...docGateAssetDurations()]).toEqual([...knownAssetDurations()]);
    expect([...docGateAssetDurations()]).toEqual([[ASSET_ID, 7_320_000]]);
  });

  it('the REAL trim chain (beginTransaction -> applyTrimToDraft -> commit) survives a misaligned source', () => {
    // 7.320000 s is what ffprobe reports for the e2e fixture built by
    // e2e/support/media.ts (25 fps source, 30 fps project): pulling the right
    // edge past the end of the source lands on the source cap, and that cap is
    // NOT a frame boundary. This is the exact shape the gate exists for.
    useAssetStore.getState().setAssets([
      { id: ASSET_ID, kind: 'video', name: 'misaligned.mp4', status: 'ready', durationUs: 7_320_000 },
    ]);
    useDocStore.getState().loadDoc(docWithClip());

    const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
    // Drag far past the end of the source — the clamp is what produces the
    // off-grid edge if the trim math does not floor to the grid.
    tx.update((d) => {
      applyTrimToDraft(d, CLIP_ID, 'right', 20_000_000, 'normal', knownAssetDurations());
    });
    expect(() => tx.commit()).not.toThrow();

    // And it really did grow (the trim was not silently a no-op).
    expect(clipEnd()).toBeGreaterThan(3_000_000);
  });

  it('does NOT judge a gesture that changed nothing (a pre-existing violation is not the click\'s fault)', () => {
    // A document from an older revision / another project fps: off the grid on
    // arrival. loadDoc accepts it (the gate is for EDITS, not for the server).
    const legacy = docWithClip();
    (legacy.tracks[0]!.clips[0] as MediaClip).timelineDurationUs = 2_000_040;
    (legacy.tracks[0]!.clips[0] as MediaClip).sourceOutUs = 2_000_040;
    expect(() => useDocStore.getState().loadDoc(legacy)).not.toThrow();

    // TimelinePanel opens a trim transaction on pointerdown and commits it on
    // pointerup even when the pointer never moved: that click must not explode.
    const tx = useDocStore.getState().beginTransaction('trim', 'Klip kırpıldı');
    expect(() => tx.commit()).not.toThrow();
  });

  it('does NOT judge a document that arrived from the server mid-gesture', () => {
    useDocStore.getState().loadDoc(docWithClip());
    const incoming = docWithClip();
    (incoming.tracks[0]!.clips[0] as MediaClip).timelineDurationUs = 2_000_040;
    (incoming.tracks[0]!.clips[0] as MediaClip).sourceOutUs = 2_000_040;

    const tx = useDocStore.getState().beginTransaction('move', 'Klip taşındı');
    tx.update((d) => void (d.tracks[0]!.clips[0]!.timelineStartUs = 2_000_000));
    useDocStore.getState().loadDoc(incoming); // queued: applied by commit()
    // The gesture's own document is legal; the queued load's is not — and the
    // load is not the gesture's doing, so commit() must not throw over it.
    expect(() => tx.commit()).not.toThrow();
    expect(useDocStore.getState().doc.tracks[0]!.clips[0]!.timelineDurationUs).toBe(2_000_040);
  });
});
