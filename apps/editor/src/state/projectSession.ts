/**
 * projectSession — opening a project and keeping the doc/server relationship.
 *
 * - openProject: GET /api/projects/{id} -> loadDoc + revisionNumber -> autosave.
 * - loadServerDoc: replace the local document with a server one WITHOUT
 *   marking autosave dirty and WITH a cleared undo history (loadDoc does that).
 * - resolveConflictFromServer: the "changed in another tab" dialog action.
 */
import { create } from 'zustand';
import { validateTimelineDoc, type TimelineDoc } from '@videoedit/timeline-schema';
import { apiFetch } from '../entities/apiClient';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import {
  disposeAutosave,
  getAutosaveController,
  initAutosave,
  useAutosaveStore,
  withAutosaveSuppressed,
} from './autosave';

export interface ProjectDetailDto {
  id: string;
  name: string;
  revisionNumber: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  audioSampleRate: number;
  timeline: unknown;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSessionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectSessionState {
  status: ProjectSessionStatus;
  projectId: string | null;
  projectName: string | null;
  error: string | null;
}

export const useProjectSession = create<ProjectSessionState>()(() => ({
  status: 'idle',
  projectId: null,
  projectName: null,
  error: null,
}));

/**
 * Replace the local doc with a server document (project open, conflict
 * resolution, restore). Clears undo history and does not trigger autosave.
 * The document is validated in dev — a contract-violating server doc is a
 * bug worth failing loudly on.
 */
export function loadServerDoc(timeline: unknown, revisionNumber: number): void {
  if (import.meta.env?.DEV) {
    const result = validateTimelineDoc(timeline);
    if (!result.success) {
      // Loud but non-fatal: the server is the source of truth; refusing to
      // load would brick the project. Log the contract violation.
      console.error('Server timeline failed validation:', result.error.issues);
    }
  }
  withAutosaveSuppressed(() => {
    useDocStore.getState().loadDoc(timeline as TimelineDoc);
  });
  getAutosaveController()?.adoptRevision(revisionNumber);
}

let openSeq = 0;

/**
 * Open a project: fetch the document, load it, arm autosave.
 *
 * Race protection (chief-architect finding 1): the docStore is LOCKED for the
 * whole fetch window, so no doc mutation (shortcut, drop, button) can slip in
 * between "loading started" and "server doc adopted" and then be silently
 * wiped or — worse — autosaved over the wrong revision.
 */
export async function openProject(projectId: string): Promise<void> {
  const seq = ++openSeq;
  useProjectSession.setState({ status: 'loading', projectId, projectName: null, error: null });
  useDocStore.getState().setLocked(true);
  const historyLenAtStart = useDocStore.getState().history.length;
  try {
    const detail = await apiFetch<ProjectDetailDto>(`/api/projects/${projectId}`);
    if (seq !== openSeq) return; // a newer openProject superseded this one (it owns the lock now)
    if (import.meta.env?.DEV && useDocStore.getState().history.length !== historyLenAtStart) {
      // The lock should make this impossible; failing loudly (but still
      // loading — the server doc is the source of truth) beats silent races.
      console.error(
        'openProject: document history changed while the project was loading — an edit bypassed the docStore lock',
      );
    }
    withAutosaveSuppressed(() => {
      useDocStore.getState().loadDoc(detail.timeline as TimelineDoc);
    });
    initAutosave(projectId, detail.revisionNumber);
    useDocStore.getState().setLocked(false);
    if (import.meta.env?.DEV) {
      const result = validateTimelineDoc(detail.timeline);
      if (!result.success) {
        console.error('Server timeline failed validation:', result.error.issues);
      }
    }
    useProjectSession.setState({ status: 'ready', projectName: detail.name, error: null });
  } catch (err) {
    if (seq !== openSeq) return;
    // The open failed: the previous project's doc/autosave must NOT stay live
    // behind the error screen (finding 10). Flush+kill autosave, reset to an
    // empty doc for the requested project, and release the lock.
    disposeAutosave();
    withAutosaveSuppressed(() => {
      useDocStore.getState().loadDoc(createEmptyDoc(projectId, defaultProjectSettings));
    });
    useDocStore.getState().setLocked(false);
    useProjectSession.setState({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function closeProject(): void {
  openSeq++;
  disposeAutosave();
  useDocStore.getState().setLocked(false);
  useProjectSession.setState({ status: 'idle', projectId: null, projectName: null, error: null });
}

/**
 * Conflict dialog action: adopt the server's document (the local unsaved
 * changes are discarded, undo history cleared — design 01 §2.4).
 */
export function resolveConflictFromServer(): void {
  const conflict = useAutosaveStore.getState().conflict;
  const controller = getAutosaveController();
  if (!conflict || !controller) return;
  withAutosaveSuppressed(() => {
    useDocStore.getState().loadDoc(conflict.timeline as TimelineDoc);
  });
  controller.resolveConflictWithServerDoc(conflict.revisionNumber);
}
