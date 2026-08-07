/**
 * historyLogic — pure derivation of the "İşlem Geçmişi" row model.
 *
 * Kept separate from HistoryPanel.tsx so it is unit-testable under the editor's
 * node test environment (vite.config.ts only collects `.test.ts`, no DOM), the
 * same split as features/export/exportLogic.ts.
 *
 * docStore semantics this module encodes (docStore.ts §jumpTo):
 *   - history is linear; entries [0, cursor) are APPLIED, [cursor, length) is
 *     the redo stack (i.e. undone).
 *   - jumpTo(index) makes entries [0..index] applied, so it sets
 *     cursor = index + 1; jumpTo(-1) is "before the first entry".
 * A row's `index` is therefore exactly the argument to pass to jumpTo().
 */
import type { HistoryEntry } from '../../state/docStore';

/** Baseline row ("Başlangıç") — the document state before any entry. */
export const HISTORY_BASE_INDEX = -1;

export interface HistoryRow {
  /** jumpTo() argument. -1 = baseline, i = entries [0..i] applied. */
  index: number;
  label: string;
  /** Machine tag from the entry ('trim' | 'move' | ...); '' for the baseline row. */
  actionType: string;
  /** HH:MM:SS (local) of the entry; '' for the baseline row. */
  time: string;
  /** This row is the document's current state (cursor === index + 1). */
  current: boolean;
  /** Entry sits in the redo stack (undone) — rendered dimmed. */
  undone: boolean;
}

/** Zero-padded local HH:MM:SS. */
export function formatHistoryTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Reverse-chronological row model (newest first), with the "Başlangıç"
 * baseline as the last row so undoing past the first entry stays reachable
 * from the panel. Returns [] for an empty history (panel shows the empty
 * state instead).
 */
export function buildHistoryRows(history: HistoryEntry[], cursor: number): HistoryRow[] {
  if (history.length === 0) return [];
  // Defensive: a cursor outside [0, length] can only come from a bug elsewhere;
  // clamping keeps the panel from marking no row (or two rows) as current.
  const safeCursor = Math.max(0, Math.min(cursor, history.length));

  const rows: HistoryRow[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    rows.push({
      index: i,
      label: entry.label,
      actionType: entry.actionType,
      time: formatHistoryTime(entry.timestamp),
      current: safeCursor === i + 1,
      undone: i >= safeCursor,
    });
  }
  rows.push({
    index: HISTORY_BASE_INDEX,
    label: 'Başlangıç',
    actionType: '',
    time: '',
    current: safeCursor === 0,
    undone: false,
  });
  return rows;
}

/**
 * Accessible description of what clicking a row does, given where the cursor
 * is now. Used for the row's title/aria-label so the direction is never
 * ambiguous (the panel jumps both backwards and forwards).
 */
export function historyRowHint(row: HistoryRow): string {
  if (row.current) return 'Mevcut konum';
  return row.undone ? 'Bu işleme ileri sar' : 'Bu işleme geri dön';
}
