/**
 * ExportDialog — start an export (M3). Same lightweight fixed-overlay pattern
 * as timeline/ConflictDialog (no dialog library).
 *
 * Single profile for now ('1080p · H.264', preselected). POST failures:
 * - 422: the ProblemDetails detail is shown in red inside the dialog,
 * - 429: concurrent-limit info message,
 * - anything else: generic error.
 * On success the dialog closes and the job shows up in the Inspector's
 * "Dışa Aktarmalar" section (exports query invalidated).
 *
 * Autosave awareness: the export renders the last SAVED document, so submit
 * first consults exportAutosaveGate — 'flush' awaits controller.saveNow(),
 * 'blocked' (conflict/error, also post-flush) refuses with the reason. The
 * open dialog shows a one-line last-save summary.
 *
 * Frame-grid pre-flight: `exportFrameGridBlockReason` runs the export
 * compiler's own frame-grid rule on the live document before submitting, so an
 * off-grid clip is explained in the dialog instead of coming back as an opaque
 * 422 from the render worker.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../entities/apiClient';
import {
  projectExportsQueryKey,
  startExport,
  type ExportProfile,
} from '../../entities/exports';
import { getAutosaveController, useAutosaveStore } from '../../state/autosave';
import { useDocStore } from '../../state/docStore';
import {
  autosaveSummary,
  exportAutosaveGate,
  exportBlockReason,
  exportFrameGridBlockReason,
  mapExportError,
  type ExportStartError,
} from './exportLogic';

const PROFILES: { id: ExportProfile; label: string; description: string }[] = [
  { id: '1080p', label: '1080p · H.264', description: '1920×1080, MP4 (H.264 + AAC)' },
];

export function ExportDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [profile] = useState<ExportProfile>('1080p');
  const [submitting, setSubmitting] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<ExportStartError | null>(null);
  // Autosave status for THIS project (null when autosave belongs to another
  // project or is not initialized — then there is nothing to flush).
  const saveStatus = useAutosaveStore((s) => (s.projectId === projectId ? s.status : null));

  if (!open) return null;

  const close = (): void => {
    setError(null);
    setSubmitting(false);
    setFlushing(false);
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    // Frame-grid pre-flight: the compiler rejects an off-grid clip with a 422
    // that arrives only after the job has been queued and picked up. Same rule,
    // run here, before anything is submitted.
    const gridReason = exportFrameGridBlockReason(useDocStore.getState().doc);
    if (gridReason !== null) {
      setSubmitting(false);
      setError({ kind: 'unsupported', message: gridReason });
      return;
    }

    // Export renders the last SAVED revision — flush unsaved work first, and
    // refuse when autosave cannot persist (conflict/error). Read the LIVE
    // status (not the render snapshot) so a just-finished save is not re-run.
    const live = useAutosaveStore.getState();
    let gatedStatus = live.projectId === projectId ? live.status : null;
    let gate = exportAutosaveGate(gatedStatus);
    const controller = getAutosaveController();
    if (gate === 'flush' && controller) {
      setFlushing(true);
      const settled = await controller.saveNow();
      setFlushing(false);
      gatedStatus = settled.status;
      gate = exportAutosaveGate(settled.status);
    }
    if (gate === 'blocked') {
      setSubmitting(false);
      setError({
        kind: 'generic',
        message:
          exportBlockReason(gatedStatus) ??
          'Kaydedilemeyen değişiklikler var — export sunucudaki son kaydedilen hali kullanır.',
      });
      return;
    }

    try {
      await startExport(projectId, profile);
      // The new job must land in the Inspector card right away.
      await queryClient.invalidateQueries({ queryKey: projectExportsQueryKey(projectId) });
      close();
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        setError(mapExportError(err.status, err.body));
      } else {
        setError({
          kind: 'generic',
          message: 'Dışa aktarma başlatılamadı: sunucuya ulaşılamıyor.',
        });
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        className="w-96 rounded-lg border border-edge bg-surface-2 p-4 shadow-xl"
      >
        <h2 id="export-dialog-title" className="text-sm font-semibold text-fg">
          Dışa Aktar
        </h2>
        <p className="mt-1 text-xs text-fg-muted">Profil seçin ve dışa aktarmayı başlatın.</p>

        <div className="mt-3 flex flex-col gap-1.5">
          {PROFILES.map((p) => {
            const selected = p.id === profile;
            return (
              <div
                key={p.id}
                aria-selected={selected}
                className={`flex items-center justify-between rounded border px-3 py-2 ${
                  selected ? 'border-accent/60 bg-accent/10' : 'border-edge'
                }`}
              >
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-fg">{p.label}</span>
                  <span className="text-[10px] text-fg-muted">{p.description}</span>
                </div>
                {selected && <span className="text-[10px] font-semibold text-accent">Seçili</span>}
              </div>
            );
          })}
        </div>

        <p className="mt-2 text-[10px] text-fg-muted" data-testid="export-autosave-summary">
          {autosaveSummary(saveStatus)}
        </p>

        {error && (
          <p
            role="alert"
            className={`mt-3 rounded border px-2.5 py-2 text-xs leading-relaxed ${
              error.kind === 'limit'
                ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                : 'border-danger/40 bg-danger/10 text-danger'
            }`}
          >
            {error.message}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={close}
          >
            Vazgeç
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void submit()}
          >
            {flushing ? 'Kaydediliyor…' : submitting ? 'Başlatılıyor…' : 'Dışa aktar'}
          </button>
        </div>
      </div>
    </div>
  );
}
