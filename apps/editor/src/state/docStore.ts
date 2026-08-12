/**
 * docStore — the timeline document store.
 *
 * Holds the TimelineDoc (single source of truth for project content) plus the
 * patch-based undo/redo history. Everything in here is subject to undo AND to
 * autosave. View state (selection, playhead, zoom) lives in editorStore and is
 * deliberately NOT here (design doc 01-frontend-editor.md §2.1).
 *
 * It is also where the DOCUMENT GATE lives (assertDocGateDev): every write path
 * — single-step ops, keyboard shortcuts, inspector edits and every pointer drag
 * — ends in `mutate` or in a transaction `commit`, so validating there is the
 * only way to make the check impossible to forget. See assertDocGateDev.
 */
import { enablePatches, produceWithPatches, applyPatches, type Patch } from 'immer';
import { create } from 'zustand';
import {
  exportFrameGridIssues,
  validateTimelineDoc,
  type MicroSec,
  type TimelineDoc,
  type ProjectSettings,
  type Uuid,
} from '@videoedit/timeline-schema';
import { useAssetStore } from './assetStore';

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
  /**
   * True while projectSession is loading a project (fetch in flight). While
   * locked, mutate/beginTransaction AND undo/redo/jumpTo are refused: throw in
   * dev, no-op in prod (M2 chief-architect finding 1c — no edits may race a
   * project load).
   *
   * undo/redo/jumpTo are doc mutations too: they rewrite `doc` from patches and
   * make autosave dirty. Leaving them ungated let a history-panel click (or
   * Ctrl+Z) mutate a document that the in-flight load is about to replace, and
   * autosave then tried to PUT that doomed document.
   */
  locked: boolean;
  /**
   * Reactive mirror of "a transaction is open". Autosave subscribes to this to
   * defer its timers until the gesture commits (half-finished drags must never
   * be PUT to the server).
   */
  transactionOpen: boolean;
  /**
   * Incremented every time loadDoc APPLIES (including deferred applications
   * after a queued load). Lets subscribers distinguish "document replaced by a
   * load" from "document edited" even when the application is asynchronous.
   */
  loadSeq: number;

  /**
   * Single-step mutation: one recipe -> one undo entry (no entry if the recipe
   * changed nothing). Passes the dev document gate (assertDocGateDev).
   */
  mutate(actionType: string, label: string, recipe: (draft: TimelineDoc) => void): void;
  /**
   * Multi-step coalescing (drags, sliders, text bursts): one entry per
   * transaction. `commit()` passes the dev document gate — which is what puts
   * every INTERACTIVE path (mouse drags included) behind the same check as the
   * single-step ops.
   */
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

  /**
   * Replace the document (project open / restore). Clears the undo history.
   * If a transaction is open the load is QUEUED and applied when the
   * transaction commits or aborts (a project fetch landing mid-drag must not
   * throw — chief-architect finding 1d).
   */
  loadDoc(doc: TimelineDoc): void;
  /** Lock/unlock document mutations (projectSession loading window). */
  setLocked(locked: boolean): void;
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

/** A closed transaction handed out while the store is locked (prod no-op path). */
const NOOP_TRANSACTION: Transaction = {
  update() {},
  commit() {},
  abort() {},
};

// ---------------------------------------------------------------------------
// Dev document gate (runs at the COMMIT POINT — see assertDocGateDev)
// ---------------------------------------------------------------------------

/**
 * Source bounds for the gate: assetId -> durationUs, for assets that HAVE a
 * source time axis and a known duration.
 *
 * Deliberately a local copy of `timelineOps.knownAssetDurations` rather than an
 * import: the gate lives in the store, and the store is the LOWER layer — the
 * ops module imports it, so importing back would close a module cycle around
 * `useDocStore` itself. The two exclusions below are the ones that matter and
 * `docStore.test.ts` asserts the two maps are identical for the same asset
 * store, so this copy cannot silently drift from the one the ops plan with:
 *
 *  - STILL IMAGES are never in the map. A still has no source clock to run out
 *    of (the export compiler opens it with `-loop 1`), and ffprobe reports a
 *    meaningless 0.04 s for a JPEG — constraining a 4 s image clip against that
 *    number made "add a photo" fail.
 *  - NON-NUMBERS are dropped rather than trusted: a JSON `null` off the wire
 *    types as `number | undefined` and compares as `4000000 > null === true`.
 */
export function docGateAssetDurations(): Map<string, MicroSec> {
  const map = new Map<string, MicroSec>();
  for (const a of useAssetStore.getState().assets.values()) {
    if (a.kind === 'image') continue;
    const durationUs: number | null | undefined = a.durationUs;
    if (typeof durationUs === 'number' && Number.isFinite(durationUs)) {
      map.set(a.id, durationUs);
    }
  }
  return map;
}

/**
 * THE document gate — dev-mode only, and the single place every write path is
 * forced through (`mutate` and transaction `commit`; see the calls below).
 *
 * Why it lives HERE and not at the call sites: it used to be an
 * `assertDocValidDev(...)` line that each op in timelineOps had to remember to
 * write after its own mutation. Single-step ops did; the INTERACTIVE paths did
 * not go through them at all — a timeline trim drag is
 * `beginTransaction` -> `tx.update(applyTrimToDraft)` -> `commit`, a gizmo drag
 * and an inspector slider are the same shape — so the gate depended on every
 * gesture author remembering to bolt it on afterwards. That is how a real
 * mouse drag could write a document the unit tests (which call the op wrappers)
 * would have rejected. At the commit point it cannot be forgotten: there is no
 * way to change the document without passing through `mutate` or `commit`.
 *
 * TWO gates, because the export compiler has two:
 *  1. `validateTimelineDoc` — the document invariants (structure, duration
 *     formula, source bounds against the asset durations above),
 *  2. `exportFrameGridIssues` — the compiler's frame-grid edge rule verbatim
 *     (ExportCompiler.Validate). A document that fails it saves fine (PUT 200)
 *     and comes back HTTP 422 from the render worker.
 *
 * Prod is untouched: the whole body is behind `import.meta.env.DEV`, so a user
 * never pays for a full zod parse per edit and never sees a throw.
 */
export function assertDocGateDev(d: TimelineDoc, context: string): void {
  if (!import.meta.env?.DEV) return;
  const result = validateTimelineDoc(d, docGateAssetDurations());
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Timeline invariant violation after "${context}":\n  ${issues}`);
  }
  const gridIssues = exportFrameGridIssues(d);
  if (gridIssues.length > 0) {
    const detail = gridIssues
      .map(
        (i) =>
          `tracks.${i.trackIndex}.clips.${i.clipIndex} (${i.clipId}): ` +
          `${i.field}=${i.valueUs} is off the project frame grid (nearest ${i.snappedUs})`,
      )
      .join('\n  ');
    throw new Error(
      `Export frame-grid violation after "${context}" — this document would fail export with HTTP 422:\n  ${detail}`,
    );
  }
}

export const useDocStore = create<DocStore>()((set, get) => {
  /**
   * The currently open transaction, if any. While a transaction is open,
   * mutate/undo/redo/jumpTo must not run: they would interleave with the
   * transaction's patches, and abort() would silently discard their changes
   * when it restores the begin() snapshot. loadDoc is the exception: it is
   * queued and applied when the transaction closes.
   */
  let activeTransaction: Transaction | null = null;
  /** Document waiting to be loaded once the open transaction closes. */
  let pendingLoadDoc: TimelineDoc | null = null;

  function assertNoActiveTransaction(op: string): void {
    if (activeTransaction !== null) {
      throw new Error(
        `Cannot ${op} while a transaction is open — finish or abort the active transaction first`,
      );
    }
  }

  /**
   * Refuse doc mutations while projectSession is loading: loud in dev,
   * silently ignored in prod (better to drop a keystroke than to corrupt the
   * incoming document / autosave baseline).
   */
  function refuseWhenLocked(op: string): boolean {
    if (!get().locked) return false;
    if (import.meta.env?.DEV) {
      throw new Error(`Cannot ${op} while the document store is locked (project loading)`);
    }
    return true;
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

  /** Server restore / project open: history is client-only and starts fresh. */
  function applyLoad(doc: TimelineDoc): void {
    set((s) => ({ doc, history: [], cursor: 0, loadSeq: s.loadSeq + 1 }));
  }

  function applyPendingLoadIfAny(): void {
    if (pendingLoadDoc === null) return;
    const doc = pendingLoadDoc;
    pendingLoadDoc = null;
    applyLoad(doc);
  }

  return {
    doc: initialDoc,
    history: [],
    cursor: 0,
    locked: false,
    transactionOpen: false,
    loadSeq: 0,

    mutate(actionType, label, recipe) {
      assertNoActiveTransaction('mutate');
      if (refuseWhenLocked('mutate')) return;
      const [nextDoc, patches, inversePatches] = produceWithPatches(get().doc, recipe);
      if (patches.length === 0) return; // no-op recipes never pollute history
      set({ doc: nextDoc });
      pushEntry({ label, actionType, patches, inversePatches, timestamp: Date.now() });
      // The gate, after the store is fully consistent (doc + history written):
      // a throw here is a dev-time alarm, not a half-applied edit.
      assertDocGateDev(nextDoc, `mutate(${actionType})`);
    },

    beginTransaction(actionType, label) {
      assertNoActiveTransaction('begin a transaction');
      if (refuseWhenLocked('begin a transaction')) return NOOP_TRANSACTION;
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
          // The document the GESTURE produced, captured before a queued load can
          // replace it: the gate judges what the drag wrote. A document that
          // arrived from the server is not the gesture's doing and may
          // legitimately be legacy/off-grid (see loadDoc — deliberately ungated).
          const gestureDoc = get().doc;
          const changed = patches.length > 0;
          if (changed) {
            pushEntry({ label, actionType, patches, inversePatches, timestamp: Date.now() });
          }
          // A queued load supersedes the gesture: apply it BEFORE announcing
          // the transaction close so subscribers (autosave) see the load first
          // and do not schedule a save of the now-replaced document.
          applyPendingLoadIfAny();
          set({ transactionOpen: false });
          // Every interactive gesture (timeline trim drag, gizmo drag, inspector
          // slider, keyframe drag) ends HERE — this is the single point where a
          // drag-written document can be caught. A transaction that produced no
          // patch changed nothing, so it is not judged: a click that opens and
          // closes a trim transaction without moving must not blow up on a
          // pre-existing violation it did not cause.
          if (changed) assertDocGateDev(gestureDoc, `commit(${actionType})`);
        },
        abort() {
          if (!open) return;
          open = false;
          activeTransaction = null;
          set({ doc: baseDoc });
          applyPendingLoadIfAny();
          set({ transactionOpen: false });
        },
      };
      activeTransaction = tx;
      set({ transactionOpen: true });
      return tx;
    },

    undo() {
      assertNoActiveTransaction('undo');
      if (refuseWhenLocked('undo')) return;
      const { history, cursor, doc } = get();
      if (cursor === 0) return;
      const entry = history[cursor - 1]!;
      set({ doc: applyPatches(doc, entry.inversePatches), cursor: cursor - 1 });
    },

    redo() {
      assertNoActiveTransaction('redo');
      if (refuseWhenLocked('redo')) return;
      const { history, cursor, doc } = get();
      if (cursor >= history.length) return;
      const entry = history[cursor]!;
      set({ doc: applyPatches(doc, entry.patches), cursor: cursor + 1 });
    },

    jumpTo(index) {
      assertNoActiveTransaction('jumpTo');
      if (refuseWhenLocked('jumpTo')) return;
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
      if (activeTransaction !== null) {
        // A gesture is mid-flight: queue the load; commit()/abort() applies it.
        pendingLoadDoc = doc;
        return;
      }
      pendingLoadDoc = null;
      applyLoad(doc);
    },

    setLocked(locked) {
      if (get().locked !== locked) set({ locked });
    },
  };
});
