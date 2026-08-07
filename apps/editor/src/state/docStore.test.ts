import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyDoc,
  defaultProjectSettings,
  HISTORY_LIMIT,
  useDocStore,
} from './docStore';

const PROJECT_ID = '01890000-0000-7000-8000-000000000000';

function freshDoc() {
  return createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings });
}

function snapshot(): unknown {
  return JSON.parse(JSON.stringify(useDocStore.getState().doc));
}

beforeEach(() => {
  useDocStore.getState().loadDoc(freshDoc());
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

  it('rejects mutate/undo/redo/jumpTo/loadDoc/beginTransaction while a transaction is open', () => {
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
    expect(() => store.loadDoc(freshDoc())).toThrow(reentrant);
    expect(() => store.beginTransaction('x', 'X')).toThrow(reentrant);

    // The rejected calls must not have corrupted the open transaction.
    tx.update((d) => void (d.settings.width = 900));
    tx.commit();
    const s = useDocStore.getState();
    expect(s.doc.settings.width).toBe(900);
    expect(s.history).toHaveLength(1);
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
