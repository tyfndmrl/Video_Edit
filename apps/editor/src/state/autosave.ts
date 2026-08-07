/**
 * autosave — debounced, single-queued timeline persistence.
 *
 * Contract (design 01 §2.4 + chief architect 1.c):
 * - Trailing debounce 2 s after the last doc mutation, maxWait 15 s.
 * - PUT /api/projects/{id}/timeline { baseRevision, timeline } — optimistic
 *   concurrency via baseRevision in the BODY (not If-Match).
 * - Success bumps the local revision; 409 surfaces a "changed in another tab"
 *   conflict (payload carries the server revision + document) and autosave
 *   pauses until the user resolves it.
 * - Single-queued: while a save is in flight new changes wait; when the save
 *   lands the LATEST snapshot is sent (intermediate states are skipped).
 * - beforeunload/pagehide flush uses fetch keepalive (best effort).
 *
 * The controller is dependency-injected (save fn, timings) so the state
 * machine is unit-testable with fake timers; `initAutosave` wires the real
 * fetch + docStore subscription and mirrors state into useAutosaveStore.
 */
import { create } from 'zustand';
import type { TimelineDoc } from '@videoedit/timeline-schema';
import { getAccessToken } from '../entities/auth';
import { ApiError, apiFetch } from '../entities/apiClient';
import { useDocStore } from './docStore';

// ---------------------------------------------------------------------------
// Controller (pure state machine, DI'd side effects)
// ---------------------------------------------------------------------------

export type AutosaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface AutosaveConflict {
  revisionNumber: number;
  timeline: unknown;
}

export interface AutosaveState {
  status: AutosaveStatus;
  revision: number;
  lastSavedAt: number | null;
  errorMessage: string | null;
  conflict: AutosaveConflict | null;
}

export type SaveOutcome =
  | { type: 'ok'; revisionNumber: number }
  | { type: 'conflict'; revisionNumber: number; timeline: unknown }
  | { type: 'error'; message: string };

export interface AutosaveDeps {
  getDoc(): TimelineDoc;
  save(baseRevision: number, docSnapshot: TimelineDoc): Promise<SaveOutcome>;
  onState?(state: AutosaveState): void;
  /**
   * When true, noteChange only marks dirty (status 'dirty') WITHOUT arming the
   * debounce/maxWait timers — used while a docStore transaction is open so a
   * half-finished drag is never PUT to the server. The caller must invoke
   * noteChange once more when the condition clears (transaction commit) to arm
   * the timers.
   */
  deferTimers?(): boolean;
  debounceMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
}

export interface AutosaveController {
  /** Call on every document mutation (debounce restarts, maxWait does not). */
  noteChange(): void;
  /** Force an immediate save when dirty (dev tooling / tests). */
  flush(): void;
  /**
   * Flush unsaved changes and WAIT until autosave is quiescent: resolves with
   * the final state once nothing is dirty or in flight ('saved'/'idle'), or
   * immediately-on-settle when the save ends in 'error'/'conflict' (no retry
   * wait). Used by ExportDialog so an export renders the latest document.
   */
  saveNow(): Promise<AutosaveState>;
  /** Snapshot to persist on page hide, or null when there is nothing unsaved. */
  pendingSnapshot(): { baseRevision: number; doc: TimelineDoc } | null;
  /**
   * The user resolved the conflict by loading the server document; autosave
   * resumes from the server revision with a clean slate.
   */
  resolveConflictWithServerDoc(serverRevision: number): void;
  /** Project (re)load: adopt a revision, drop dirty/conflict state. */
  adoptRevision(revision: number): void;
  getState(): AutosaveState;
  dispose(): void;
}

export const AUTOSAVE_DEBOUNCE_MS = 2_000;
export const AUTOSAVE_MAX_WAIT_MS = 15_000;
export const AUTOSAVE_RETRY_MS = 5_000;

export function createAutosaveController(
  initialRevision: number,
  deps: AutosaveDeps,
): AutosaveController {
  const debounceMs = deps.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxWaitMs = deps.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  const retryMs = deps.retryMs ?? AUTOSAVE_RETRY_MS;

  let state: AutosaveState = {
    status: 'idle',
    revision: initialRevision,
    lastSavedAt: null,
    errorMessage: null,
    conflict: null,
  };
  let dirty = false;
  let inFlight = false;
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending saveNow() promises waiting for autosave to settle. */
  let saveNowWaiters: ((finalState: AutosaveState) => void)[] = [];

  function emit(patch: Partial<AutosaveState>): void {
    state = { ...state, ...patch };
    deps.onState?.(state);
  }

  /**
   * Resolve pending saveNow() promises once autosave is quiescent: nothing in
   * flight AND (nothing dirty, or saving is pointless — conflict/error keep
   * dirty=true on purpose and saveNow must not wait out the retry timer).
   */
  function settleSaveNowWaiters(): void {
    if (saveNowWaiters.length === 0 || inFlight) return;
    const stuck = state.status === 'conflict' || state.status === 'error';
    if (dirty && !stuck && !disposed) return;
    const waiters = saveNowWaiters;
    saveNowWaiters = [];
    for (const resolve of waiters) resolve(state);
  }

  function clearTimer(t: 'debounce' | 'maxWait' | 'retry'): void {
    if (t === 'debounce' && debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    } else if (t === 'maxWait' && maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    } else if (t === 'retry' && retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function fire(): void {
    if (disposed || state.status === 'conflict') return;
    if (!dirty) return;
    if (inFlight) return; // the in-flight completion re-fires for us
    clearTimer('debounce');
    clearTimer('maxWait');
    clearTimer('retry');

    dirty = false;
    inFlight = true;
    const baseRevision = state.revision;
    const snapshot = deps.getDoc();
    emit({ status: 'saving' });

    void deps.save(baseRevision, snapshot).then(
      (outcome) => {
        inFlight = false;
        if (disposed) {
          settleSaveNowWaiters();
          return;
        }
        if (outcome.type === 'ok') {
          emit({
            status: dirty ? 'dirty' : 'saved',
            revision: outcome.revisionNumber,
            lastSavedAt: Date.now(),
            errorMessage: null,
          });
          if (dirty) fire(); // latest snapshot wins — save again immediately
        } else if (outcome.type === 'conflict') {
          // The doc changed in another tab. Stop saving; the UI offers to load
          // the server document. Local changes stay dirty (and unsaved).
          dirty = true;
          emit({
            status: 'conflict',
            conflict: { revisionNumber: outcome.revisionNumber, timeline: outcome.timeline },
          });
        } else {
          dirty = true;
          emit({ status: 'error', errorMessage: outcome.message });
          clearTimer('retry');
          retryTimer = setTimeout(() => {
            retryTimer = null;
            fire();
          }, retryMs);
        }
        settleSaveNowWaiters();
      },
      (err: unknown) => {
        inFlight = false;
        if (disposed) {
          settleSaveNowWaiters();
          return;
        }
        dirty = true;
        emit({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) });
        clearTimer('retry');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          fire();
        }, retryMs);
        settleSaveNowWaiters();
      },
    );
  }

  return {
    noteChange() {
      if (disposed || state.status === 'conflict') {
        dirty = true;
        return;
      }
      dirty = true;
      if (state.status !== 'saving' && state.status !== 'error') emit({ status: 'dirty' });
      if (deps.deferTimers?.() === true) return; // mid-gesture: mark dirty only
      clearTimer('debounce');
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        fire();
      }, debounceMs);
      if (maxWaitTimer === null && !inFlight) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          fire();
        }, maxWaitMs);
      }
    },
    flush() {
      fire();
    },
    saveNow() {
      // Already quiescent (or stuck in conflict — saving is impossible until
      // the user resolves it): report the current state without a round trip.
      if (disposed || state.status === 'conflict' || (!dirty && !inFlight)) {
        return Promise.resolve(state);
      }
      return new Promise<AutosaveState>((resolve) => {
        saveNowWaiters.push(resolve);
        // fire() is a no-op while a save is in flight — that save's completion
        // re-fires for remaining dirty state and then settles the waiters.
        fire();
      });
    },
    pendingSnapshot() {
      if (!dirty && !inFlight) return null;
      if (state.status === 'conflict') return null;
      return { baseRevision: state.revision, doc: deps.getDoc() };
    },
    resolveConflictWithServerDoc(serverRevision) {
      dirty = false;
      clearTimer('debounce');
      clearTimer('maxWait');
      clearTimer('retry');
      emit({
        status: 'saved',
        revision: serverRevision,
        conflict: null,
        errorMessage: null,
        lastSavedAt: Date.now(),
      });
    },
    adoptRevision(revision) {
      dirty = false;
      clearTimer('debounce');
      clearTimer('maxWait');
      clearTimer('retry');
      emit({ status: 'idle', revision, conflict: null, errorMessage: null });
    },
    getState: () => state,
    dispose() {
      disposed = true;
      clearTimer('debounce');
      clearTimer('maxWait');
      clearTimer('retry');
      // Never leave a saveNow() caller hanging (in-flight saves settle their
      // own waiters on completion via the disposed branch above).
      if (!inFlight) settleSaveNowWaiters();
    },
  };
}

// ---------------------------------------------------------------------------
// App wiring: real save fn + zustand mirror + keepalive flush
// ---------------------------------------------------------------------------

export interface AutosaveStore extends AutosaveState {
  /** null until a project session initializes autosave. */
  projectId: string | null;
}

export const useAutosaveStore = create<AutosaveStore>()(() => ({
  projectId: null,
  status: 'idle',
  revision: 0,
  lastSavedAt: null,
  errorMessage: null,
  conflict: null,
}));

interface SaveTimelineResponse {
  revisionNumber: number;
}

async function putTimeline(
  projectId: string,
  baseRevision: number,
  docSnapshot: TimelineDoc,
): Promise<SaveOutcome> {
  try {
    const res = await apiFetch<SaveTimelineResponse>(`/api/projects/${projectId}/timeline`, {
      method: 'PUT',
      body: { baseRevision, timeline: docSnapshot },
    });
    return { type: 'ok', revisionNumber: res.revisionNumber };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const body = err.body as { revisionNumber?: number; timeline?: unknown } | undefined;
      return {
        type: 'conflict',
        revisionNumber: body?.revisionNumber ?? baseRevision,
        timeline: body?.timeline,
      };
    }
    return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

let activeController: AutosaveController | null = null;
let unsubscribeDoc: (() => void) | null = null;
let removeUnloadListeners: (() => void) | null = null;
/** Set while projectSession loads a server document — must not mark dirty. */
let suppressDirty = false;

export function getAutosaveController(): AutosaveController | null {
  return activeController;
}

/** Run `fn` (a loadDoc-style replacement) without marking the doc dirty. */
export function withAutosaveSuppressed(fn: () => void): void {
  suppressDirty = true;
  try {
    fn();
  } finally {
    suppressDirty = false;
  }
}

/**
 * Best-effort flush on tab close: fetch with keepalive survives page unload
 * (bodies >64 KB may be dropped by the browser — accepted best effort; the
 * regular debounced autosave is the primary persistence path).
 */
function flushWithKeepalive(projectId: string): void {
  const pending = activeController?.pendingSnapshot();
  if (!pending) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch(`/api/projects/${projectId}/timeline`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ baseRevision: pending.baseRevision, timeline: pending.doc }),
    keepalive: true,
  }).catch(() => {
    // page is going away — nothing to report to
  });
}

/**
 * Initialize autosave for a project (called by projectSession after loadDoc).
 * Tears down any previous project's wiring (flushing its unsaved work — see
 * disposeAutosave). Returns the controller.
 */
export function initAutosave(projectId: string, initialRevision: number): AutosaveController {
  disposeAutosave();

  const controller = createAutosaveController(initialRevision, {
    getDoc: () => useDocStore.getState().doc,
    save: (baseRevision, docSnapshot) => putTimeline(projectId, baseRevision, docSnapshot),
    onState: (s) => useAutosaveStore.setState({ ...s, projectId }),
    // While a docStore transaction (drag gesture) is open, only mark dirty —
    // the subscription below re-arms the timers when the transaction closes.
    deferTimers: () => useDocStore.getState().transactionOpen,
  });
  activeController = controller;
  useAutosaveStore.setState({
    projectId,
    status: 'idle',
    revision: initialRevision,
    lastSavedAt: null,
    errorMessage: null,
    conflict: null,
  });

  /** Doc changed during the currently/last open transaction (needs a commit-time noteChange). */
  let txDirty = false;
  unsubscribeDoc = useDocStore.subscribe((s, prev) => {
    if (s.loadSeq !== prev.loadSeq) {
      // Document replaced wholesale (project load / conflict resolution) —
      // never a dirty edit, and it supersedes any mid-transaction changes.
      txDirty = false;
      return;
    }
    if (s.doc !== prev.doc && !suppressDirty) {
      if (s.transactionOpen) txDirty = true;
      controller.noteChange();
    }
    if (!s.transactionOpen && prev.transactionOpen && txDirty) {
      // Transaction closed: arm the timers that were deferred mid-gesture.
      txDirty = false;
      controller.noteChange();
    }
  });

  const cleanups: (() => void)[] = [];
  if (typeof window !== 'undefined') {
    const onHide = () => flushWithKeepalive(projectId);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onHide);
    cleanups.push(() => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onHide);
    });
  }
  if (typeof document !== 'undefined') {
    // Tab backgrounded: flush through the NORMAL save path (regular fetch, no
    // keepalive 64 KB body cap; success also bumps the local revision so the
    // controller stays consistent when the tab comes back).
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') controller.flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }
  removeUnloadListeners = cleanups.length > 0 ? () => cleanups.forEach((fn) => fn()) : null;
  return controller;
}

export function disposeAutosave(): void {
  const controller = activeController;
  activeController = null;
  if (controller) {
    // Closing / switching projects: best-effort final PUT of unsaved work for
    // the OLD project before the controller dies (regular awaited fetch inside
    // putTimeline; fire-and-forget here because dispose must remain sync).
    const pending = controller.pendingSnapshot();
    const projectId = useAutosaveStore.getState().projectId;
    if (pending && projectId) {
      void putTimeline(projectId, pending.baseRevision, pending.doc);
    }
    controller.dispose();
  }
  unsubscribeDoc?.();
  unsubscribeDoc = null;
  removeUnloadListeners?.();
  removeUnloadListeners = null;
}
