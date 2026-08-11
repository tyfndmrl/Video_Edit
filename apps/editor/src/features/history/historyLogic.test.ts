/**
 * historyLogic tests — row derivation (label/time/current/dimmed), the
 * baseline row, the empty state, and a jumpTo direction round-trip against the
 * REAL docStore so the row `index` -> jumpTo() contract cannot silently drift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildHistoryRows,
  formatHistoryTime,
  historyNavigationBlockReason,
  historyRowHint,
  HISTORY_BASE_INDEX,
} from './historyLogic';
import {
  createEmptyDoc,
  defaultProjectSettings,
  useDocStore,
  type HistoryEntry,
} from '../../state/docStore';

function entry(label: string, timestamp: number, actionType = 'w'): HistoryEntry {
  return { label, actionType, patches: [], inversePatches: [], timestamp };
}

/** 2024-05-04 09:07:05 local time — padding-sensitive on purpose. */
const T = new Date(2024, 4, 4, 9, 7, 5).getTime();

describe('formatHistoryTime', () => {
  it('formats as zero-padded local HH:MM:SS', () => {
    expect(formatHistoryTime(T)).toBe('09:07:05');
    expect(formatHistoryTime(new Date(2024, 4, 4, 23, 59, 59).getTime())).toBe('23:59:59');
    expect(formatHistoryTime(new Date(2024, 4, 4, 0, 0, 0).getTime())).toBe('00:00:00');
  });
});

describe('buildHistoryRows', () => {
  it('returns no rows for an empty history (panel renders "Henüz işlem yok.")', () => {
    expect(buildHistoryRows([], 0)).toEqual([]);
  });

  it('lists newest first and appends the "Başlangıç" baseline row', () => {
    const history = [
      entry('Klip kırpıldı', T),
      entry('Klip taşındı', T + 1000),
      entry('Klip bölündü', T + 2000),
    ];
    const rows = buildHistoryRows(history, 3);

    expect(rows.map((r) => r.label)).toEqual([
      'Klip bölündü',
      'Klip taşındı',
      'Klip kırpıldı',
      'Başlangıç',
    ]);
    expect(rows.map((r) => r.index)).toEqual([2, 1, 0, HISTORY_BASE_INDEX]);
    expect(rows.map((r) => r.time)).toEqual(['09:07:07', '09:07:06', '09:07:05', '']);
    expect(rows[0]!.actionType).toBe('w');
  });

  it('marks the entry at cursor-1 as current and everything above it as undone', () => {
    const history = [entry('a', T), entry('b', T), entry('c', T), entry('d', T)];
    // cursor 2 -> entries 0,1 applied; 2,3 are the redo stack.
    const rows = buildHistoryRows(history, 2);

    expect(rows.map((r) => [r.index, r.current, r.undone])).toEqual([
      [3, false, true],
      [2, false, true],
      [1, true, false],
      [0, false, false],
      [HISTORY_BASE_INDEX, false, false],
    ]);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
  });

  it('marks the baseline row as current when everything is undone (cursor 0)', () => {
    const rows = buildHistoryRows([entry('a', T), entry('b', T)], 0);
    expect(rows.at(-1)).toMatchObject({ index: HISTORY_BASE_INDEX, current: true, undone: false });
    expect(rows.filter((r) => r.undone)).toHaveLength(2);
    // The baseline is never dimmed — it is always a reachable state.
    expect(rows.at(-1)!.undone).toBe(false);
  });

  it('marks the newest row as current when nothing is undone (cursor === length)', () => {
    const rows = buildHistoryRows([entry('a', T), entry('b', T)], 2);
    expect(rows[0]).toMatchObject({ index: 1, current: true, undone: false });
    expect(rows.some((r) => r.undone)).toBe(false);
  });

  it('clamps an out-of-range cursor to exactly one current row', () => {
    const history = [entry('a', T), entry('b', T)];
    expect(buildHistoryRows(history, 99).filter((r) => r.current)).toHaveLength(1);
    expect(buildHistoryRows(history, 99)[0]!.index).toBe(1);
    expect(buildHistoryRows(history, -5).filter((r) => r.current)).toHaveLength(1);
    expect(buildHistoryRows(history, -5).at(-1)!.index).toBe(HISTORY_BASE_INDEX);
  });
});

describe('historyRowHint', () => {
  it('names the direction of the jump each row performs', () => {
    const rows = buildHistoryRows([entry('a', T), entry('b', T), entry('c', T)], 2);
    expect(historyRowHint(rows[0]!)).toBe('Bu işleme ileri sar'); // undone entry
    expect(historyRowHint(rows[1]!)).toBe('Mevcut konum');
    expect(historyRowHint(rows[2]!)).toBe('Bu işleme geri dön');
    expect(historyRowHint(rows[3]!)).toBe('Bu işleme geri dön'); // Başlangıç
  });
});

describe('row index -> docStore.jumpTo contract', () => {
  beforeEach(() => {
    useDocStore.setState({
      doc: createEmptyDoc('00000000-0000-0000-0000-000000000000', defaultProjectSettings),
      history: [],
      cursor: 0,
      locked: false,
      transactionOpen: false,
    });
  });

  it('round-trips backwards and forwards using the index shown in the panel', () => {
    const store = useDocStore.getState();
    for (let i = 1; i <= 4; i++) {
      store.mutate('w', `Genişlik ${i}`, (d) => void (d.settings.width = 1000 + i));
    }

    const atTop = buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor);
    expect(atTop[0]).toMatchObject({ index: 3, label: 'Genişlik 4', current: true });

    // Click the row labelled "Genişlik 2" (index 1) -> jump BACKWARDS.
    const back = atTop.find((r) => r.label === 'Genişlik 2')!;
    useDocStore.getState().jumpTo(back.index);
    expect(useDocStore.getState().doc.settings.width).toBe(1002);
    expect(useDocStore.getState().cursor).toBe(back.index + 1);

    let rows = buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor);
    expect(rows.find((r) => r.label === 'Genişlik 2')!.current).toBe(true);
    // Everything newer is now dimmed (undone), nothing older is.
    expect(rows.filter((r) => r.undone).map((r) => r.label)).toEqual([
      'Genişlik 4',
      'Genişlik 3',
    ]);

    // Click a dimmed row -> jump FORWARDS (redo), same index semantics.
    const forward = rows.find((r) => r.label === 'Genişlik 4')!;
    expect(forward.undone).toBe(true);
    useDocStore.getState().jumpTo(forward.index);
    expect(useDocStore.getState().doc.settings.width).toBe(1004);
    expect(useDocStore.getState().cursor).toBe(4);

    // Click "Başlangıç" -> back to the pre-history document.
    rows = buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor);
    useDocStore.getState().jumpTo(rows.at(-1)!.index);
    expect(useDocStore.getState().doc.settings.width).toBe(defaultProjectSettings.width);
    expect(useDocStore.getState().cursor).toBe(0);
    expect(
      buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor).at(-1)!
        .current,
    ).toBe(true);
  });

  it('keeps the current row in sync with undo/redo done from the top bar', () => {
    const store = useDocStore.getState();
    store.mutate('w', 'Genişlik 1', (d) => void (d.settings.width = 1001));
    store.mutate('w', 'Genişlik 2', (d) => void (d.settings.width = 1002));

    useDocStore.getState().undo();
    let rows = buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor);
    expect(rows.find((r) => r.current)!.label).toBe('Genişlik 1');
    expect(rows.find((r) => r.label === 'Genişlik 2')!.undone).toBe(true);

    useDocStore.getState().redo();
    rows = buildHistoryRows(useDocStore.getState().history, useDocStore.getState().cursor);
    expect(rows.find((r) => r.current)!.label).toBe('Genişlik 2');
    expect(rows.some((r) => r.undone)).toBe(false);
  });
});

/**
 * Geçmişte gezinme kapısı (denetim bulgusu 1). Panel satırları ve TopBar'ın
 * Geri al/Yinele düğmeleri bu TEK kuralı paylaşır; kural docStore'un lock'u ve
 * dispatcher'ın 409 kapısıyla aynı koşulları taşır — "düğme aktif ama tıklayınca
 * doküman birazdan sunucu kopyasıyla değiştirilecek" durumu kalmasın.
 */
describe('historyNavigationBlockReason (undo/redo/jumpTo kapısı)', () => {
  const free = { transactionOpen: false, locked: false, autosaveStatus: 'saved' };

  it('allows navigation when nothing blocks it', () => {
    expect(historyNavigationBlockReason(free)).toBeNull();
    expect(historyNavigationBlockReason({ ...free, autosaveStatus: 'dirty' })).toBeNull();
    expect(historyNavigationBlockReason({ ...free, autosaveStatus: 'saving' })).toBeNull();
    expect(historyNavigationBlockReason({ ...free, autosaveStatus: 'error' })).toBeNull();
  });

  it('blocks while a gesture (transaction) is open — jumpTo would throw', () => {
    expect(historyNavigationBlockReason({ ...free, transactionOpen: true })).toMatch(/sürükleme/i);
  });

  it('blocks while the store is locked (project loading)', () => {
    expect(historyNavigationBlockReason({ ...free, locked: true })).toMatch(/yükleni/i);
  });

  it('blocks while the 409 conflict dialog is up', () => {
    expect(historyNavigationBlockReason({ ...free, autosaveStatus: 'conflict' })).toMatch(
      /çakışma/i,
    );
  });

  /** Kapı ile docStore'un gerçek davranışı ayrışmamalı. */
  it('agrees with docStore: every blocked case is refused by the store as well', () => {
    useDocStore.setState({
      doc: createEmptyDoc('00000000-0000-0000-0000-000000000000', defaultProjectSettings),
      history: [],
      cursor: 0,
      locked: false,
      transactionOpen: false,
    });
    const store = useDocStore.getState();
    store.mutate('w', 'Genişlik 1', (d) => void (d.settings.width = 1001));

    // locked -> hem kapı hem store reddeder.
    store.setLocked(true);
    expect(historyNavigationBlockReason({ ...free, locked: true })).not.toBeNull();
    expect(() => useDocStore.getState().undo()).toThrow(/locked/);
    store.setLocked(false);

    // transaction açık -> hem kapı hem store reddeder.
    const tx = useDocStore.getState().beginTransaction('trim', 'Kırpma');
    expect(useDocStore.getState().transactionOpen).toBe(true);
    expect(
      historyNavigationBlockReason({ ...free, transactionOpen: true }),
    ).not.toBeNull();
    expect(() => useDocStore.getState().jumpTo(-1)).toThrow(/transaction/i);
    tx.abort();
  });
});
