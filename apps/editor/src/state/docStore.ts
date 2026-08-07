/**
 * docStore — the timeline document store.
 *
 * Holds the TimelineDoc (single source of truth for project content) plus the
 * patch-based undo/redo history. Everything in here is subject to undo AND to
 * autosave. View state (selection, playhead, zoom) lives in editorStore and is
 * deliberately NOT here (design doc 01-frontend-editor.md §2.1).
 */
import { enablePatches, produceWithPatches, applyPatches, type Patch } from 'immer';
import { create } from 'zustand';
import type { TimelineDoc, ProjectSettings, Uuid } from '@videoedit/timeline-schema';

// produceWithPatches requires the immer patches plugin.
enablePatches();

export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  /** Human-readable, shown in the history panel ("Clip trimmed", "3 clips moved"). */
  label: string;
  /** Machine tag ('trim' | 'move' | 'split' | ...) used for coalescing decisions. */
  actionType: string;
  patches: Patch[];
  inversePatches: Patch[];
  timestamp: number;
}

export interface Transaction {
  /** Apply an incremental mutation (called on every pointermove). No history entry yet. */
  update(recipe: (draft: TimelineDoc) => void): void;
  /** Finish: pushes a SINGLE history entry covering begin -> now. No-op if nothing changed. */
  commit(): void;
  /** Cancel: restores the document to its state at begin(); leaves no trace in history. */
  abort(): void;
}

export interface DocStore {
  doc: TimelineDoc;
  /** Linear history. Entries [0, cursor) are applied; [cursor, length) is the redo stack. */
  history: HistoryEntry[];
  cursor: number;

  /** Single-step mutation: one recipe -> one undo entry (no entry if the recipe changed nothing). */
  mutate(actionType: string, label: string, recipe: (draft: TimelineDoc) => void): void;
  /** Multi-step coalescing (drags, sliders, text bursts): one entry per transaction. */
  beginTransaction(actionType: string, label: string): Transaction;

  undo(): void;
  redo(): void;
  /**
   * Jump so that entries [0..index] are applied (history panel click).
   * index === -1 jumps to the state before the first entry.
   */
  jumpTo(index: number): void;
  canUndo(): boolean;
  canRedo(): boolean;

  /** Replace the document (project open / restore). Clears the undo history. */
  loadDoc(doc: TimelineDoc): void;
}

/** Empty document factory. Settings come from the project record on the server. */
export function createEmptyDoc(projectId: Uuid, settings: ProjectSettings): TimelineDoc {
  return {
    schemaVersion: 1,
    projectId,
    settings,
    tracks: [],
    markers: [],
  };
}

export const defaultProjectSettings: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  audioSampleRate: 48000,
  backgroundColor: '#000000',
};

/** Placeholder until a real project is loaded via loadDoc(). */
const initialDoc = createEmptyDoc(
  '00000000-0000-0000-0000-000000000000',
  defaultProjectSettings,
);

export const useDocStore = create<DocStore>()((set, get) => {
  /**
   * The currently open transaction, if any. While a transaction is open,
   * mutate/undo/redo/jumpTo/loadDoc must not run: they would interleave with
   * the transaction's patches, and abort() would silently discard their
   * changes when it restores the begin() snapshot.
   */
  let activeTransaction: Transaction | null = null;

  function assertNoActiveTransaction(op: string): void {
    if (activeTransaction !== null) {
      throw new Error(
        `Cannot ${op} while a transaction is open — finish or abort the active transaction first`,
      );
    }
  }

  function pushEntry(entry: HistoryEntry): void {
    const { history, cursor } = get();
    // Any new action clears the redo stack (linear history).
    let next = history.slice(0, cursor);
    next.push(entry);
    if (next.length > HISTORY_LIMIT) {
      next = next.slice(next.length - HISTORY_LIMIT);
    }
    set({ history: next, cursor: next.length });
  }

  return {
    doc: initialDoc,
    history: [],
    cursor: 0,

    mutate(actionType, label, recipe) {
      assertNoActiveTransaction('mutate');
      const [nextDoc, patches, inversePatches] = produceWithPatches(get().doc, recipe);
      if (patches.length === 0) return; // no-op recipes never pollute history
      set({ doc: nextDoc });
      pushEntry({ label, actionType, patches, inversePatches, timestamp: Date.now() });
    },

    beginTransaction(actionType, label) {
      assertNoActiveTransaction('begin a transaction');
      const baseDoc = get().doc; // immutable snapshot — safe to keep by reference
      let patches: Patch[] = [];
      let inversePatches: Patch[] = [];
      let open = true;

      const tx: Transaction = {
        update(recipe) {
          if (!open) throw new Error('Transaction is already closed');
          if (activeTransaction !== tx) {
            throw new Error('Transaction is no longer active');
          }
          const [nextDoc, p, inv] = produceWithPatches(get().doc, recipe);
          // Forward patches apply in order; inverse patches must apply in
          // reverse step order, so later steps are prepended.
          patches = patches.concat(p);
          inversePatches = inv.concat(inversePatches);
          set({ doc: nextDoc });
        },
        commit() {
          if (!open) return;
          open = false;
          activeTransaction = null;
          if (patches.length === 0) return; // nothing changed -> no entry
          pushEntry({ label, actionType, patches, inversePatches, timestamp: Date.now() });
        },
        abort() {
          if (!open) return;
          open = false;
          activeTransaction = null;
          set({ doc: baseDoc });
        },
      };
      activeTransaction = tx;
      return tx;
    },

    undo() {
      assertNoActiveTransaction('undo');
      const { history, cursor, doc } = get();
      if (cursor === 0) return;
      const entry = history[cursor - 1]!;
      set({ doc: applyPatches(doc, entry.inversePatches), cursor: cursor - 1 });
    },

    redo() {
      assertNoActiveTransaction('redo');
      const { history, cursor, doc } = get();
      if (cursor >= history.length) return;
      const entry = history[cursor]!;
      set({ doc: applyPatches(doc, entry.patches), cursor: cursor + 1 });
    },

    jumpTo(index) {
      assertNoActiveTransaction('jumpTo');
      const { history } = get();
      const target = Math.max(-1, Math.min(index, history.length - 1)) + 1;
      let { doc, cursor } = get();
      while (cursor > target) {
        doc = applyPatches(doc, history[cursor - 1]!.inversePatches);
        cursor -= 1;
      }
      while (cursor < target) {
        doc = applyPatches(doc, history[cursor]!.patches);
        cursor += 1;
      }
      set({ doc, cursor });
    },

    canUndo: () => get().cursor > 0,
    canRedo: () => get().cursor < get().history.length,

    loadDoc(doc) {
      assertNoActiveTransaction('loadDoc');
      // Server restore / project open: history is client-only and starts fresh.
      set({ doc, history: [], cursor: 0 });
    },
  };
});
