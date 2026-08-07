/**
 * Inspector panel — selected clip properties, keyframe editor (M3 placeholder)
 * + the "İşlem Geçmişi" section (undo/redo history, features/history)
 * + the "Dışa Aktarmalar" section (export job list, features/export).
 */
import { ExportJobsCard } from '../export/ExportJobsCard';
import { HistoryPanel } from '../history/HistoryPanel';
import { useProjectSession } from '../../state/projectSession';

export function InspectorPanel() {
  const projectId = useProjectSession((s) => s.projectId);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Özellikler
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-fg-muted">
        Seçili klip özellikleri M4'te gelecek.
      </div>
      <section className="max-h-[35%] shrink-0 overflow-y-auto border-t border-edge">
        <h3 className="sticky top-0 border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
          İşlem Geçmişi
        </h3>
        <HistoryPanel />
      </section>
      <section className="max-h-[50%] shrink-0 overflow-y-auto border-t border-edge">
        <h3 className="sticky top-0 border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Dışa Aktarmalar
        </h3>
        {sessionReady && projectId !== null ? (
          <ExportJobsCard projectId={projectId} />
        ) : (
          <p className="px-3 py-2 text-xs text-fg-muted">Proje açık değil.</p>
        )}
      </section>
    </div>
  );
}
