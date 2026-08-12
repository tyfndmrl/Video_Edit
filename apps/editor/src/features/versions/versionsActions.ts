/**
 * versionsActions — the two write flows of the version history UI.
 *
 * Both share the same preamble: consult autosave, flush unsaved work, and
 * refuse when it cannot be persisted (versionsLogic.versionActionGate explains
 * why). Restore additionally LOCKS the document store for the whole operation
 * and reloads the document from the server response.
 *
 * Why the lock spans the flush AND the POST (not just the POST): between
 * "flush finished" and "server document adopted" any local edit would be built
 * on a document that is about to be thrown away, and — worse — the next
 * autosave would PUT it over the restored revision. This is the same window
 * projectSession.openProject guards with setLocked (M2 chief-architect
 * finding 1). While locked, docStore refuses mutate/beginTransaction/undo/redo
 * /jumpTo and historyLogic disables the undo/redo/history-panel controls, so
 * "the editor is locked during a restore" is one flag, not a second mechanism.
 */
import { ApiError } from '../../entities/apiClient';
import {
  createCheckpoint,
  projectRevisionsQueryKey,
  restoreRevision,
} from '../../entities/versions';
import { queryClient } from '../../app/queryClient';
import { getAutosaveController, useAutosaveStore } from '../../state/autosave';
import { useDocStore } from '../../state/docStore';
import { loadServerDoc, useProjectSession } from '../../state/projectSession';
import {
  checkpointSuccessNotice,
  mapVersionActionError,
  normalizeCheckpointLabel,
  restoreSuccessNotice,
  versionActionBlockReason,
  versionActionGate,
  type VersionAction,
} from './versionsLogic';
import { useVersionsStore } from './versionsStore';

/**
 * Guards against a stale restore applying its document: bumped on every
 * restore start, checked before the response is adopted (openProject uses the
 * same openSeq trick).
 */
let restoreSeq = 0;

interface FlushResult {
  blocked: boolean;
  reason: string;
}

/**
 * Persist unsaved work for `projectId`, then re-evaluate the gate on the
 * SETTLED status (a flush can itself end in conflict/error).
 *
 * The autosave status is read LIVE (not from a React render snapshot) and only
 * counts when it belongs to this project — a controller armed for another
 * project has nothing to say about this one.
 */
async function flushForVersionAction(
  projectId: string,
  action: VersionAction,
): Promise<FlushResult> {
  const live = useAutosaveStore.getState();
  let status = live.projectId === projectId ? live.status : null;
  let gate = versionActionGate(status);

  const controller = getAutosaveController();
  if (gate === 'flush' && controller !== null) {
    const settled = await controller.saveNow();
    status = settled.status;
    gate = versionActionGate(status);
  }

  if (gate === 'blocked') {
    return {
      blocked: true,
      reason:
        versionActionBlockReason(status, action) ??
        'Kaydedilmemiş değişiklikler sunucuya yazılamadı; işlem durduruldu.',
    };
  }
  return { blocked: false, reason: '' };
}

function failureMessage(err: unknown, action: VersionAction): string {
  if (err instanceof ApiError) return mapVersionActionError(err.status, action);
  return action === 'restore'
    ? 'Sürüme dönülemedi: sunucuya ulaşılamıyor. Doküman değişmedi.'
    : 'Kayıt noktası oluşturulamadı: sunucuya ulaşılamıyor.';
}

/**
 * Manual checkpoint of the current document ("Şu anki hali kaydet").
 *
 * The server snapshots ITS copy, so the flush above is what makes the
 * checkpoint mean "what I see right now" instead of "whatever was last
 * autosaved". Returns true on success.
 */
export async function createProjectCheckpoint(
  projectId: string,
  rawLabel: string,
): Promise<boolean> {
  if (useVersionsStore.getState().busy !== null) return false;

  const validated = normalizeCheckpointLabel(rawLabel);
  if (!validated.ok) {
    useVersionsStore.setState({ error: validated.message, notice: null });
    return false;
  }

  useVersionsStore.setState({ busy: 'checkpoint', error: null, notice: null });
  try {
    const flush = await flushForVersionAction(projectId, 'checkpoint');
    if (flush.blocked) {
      useVersionsStore.setState({ busy: null, error: flush.reason });
      return false;
    }

    const revision = await createCheckpoint(projectId, validated.label);
    useVersionsStore.setState({
      busy: null,
      error: null,
      notice: checkpointSuccessNotice(revision.revisionNumber, validated.label),
    });
    await queryClient.invalidateQueries({ queryKey: projectRevisionsQueryKey(projectId) });
    return true;
  } catch (err) {
    useVersionsStore.setState({ busy: null, error: failureMessage(err, 'checkpoint') });
    return false;
  }
}

/**
 * Restore the project to `revisionNumber` ("Bu sürüme dön").
 *
 * Not destructive in the sense that the server first snapshots the current
 * document as PreRestore — but it DOES replace the open document and clear the
 * undo history, so the UI asks for confirmation before calling this.
 */
export async function restoreProjectRevision(
  projectId: string,
  revisionNumber: number,
): Promise<boolean> {
  if (useVersionsStore.getState().busy !== null) return false;

  useVersionsStore.setState({ busy: 'restore', error: null, notice: null });
  const seq = ++restoreSeq;
  useDocStore.getState().setLocked(true);

  /** Still the operation that owns the doc/lock for this project? */
  const stillOwns = (): boolean =>
    seq === restoreSeq && useProjectSession.getState().projectId === projectId;

  try {
    const flush = await flushForVersionAction(projectId, 'restore');
    if (flush.blocked) {
      useVersionsStore.setState({ busy: null, error: flush.reason });
      return false;
    }

    const restored = await restoreRevision(projectId, revisionNumber);

    // A newer restore, a project switch or a close happened while the request
    // was in flight: that operation owns the document AND the lock now, so
    // adopting this (stale) document would overwrite it.
    if (!stillOwns()) {
      useVersionsStore.setState({ busy: null });
      return false;
    }

    // Replaces the doc, CLEARS the undo history and re-bases autosave on the
    // new revision without marking it dirty (projectSession.loadServerDoc —
    // the same path the 409 dialog uses).
    loadServerDoc(restored.timeline, restored.revisionNumber);
    useVersionsStore.setState({
      busy: null,
      error: null,
      notice: restoreSuccessNotice(revisionNumber, restored.revisionNumber),
    });
    await queryClient.invalidateQueries({ queryKey: projectRevisionsQueryKey(projectId) });
    return true;
  } catch (err) {
    useVersionsStore.setState({ busy: null, error: failureMessage(err, 'restore') });
    return false;
  } finally {
    // Release only a lock we still own. If the session moved on, openProject/
    // closeProject took over the lock and releases it itself — unlocking here
    // would open an edit window in the MIDDLE of their load.
    if (stillOwns()) {
      useDocStore.getState().setLocked(false);
    }
  }
}
