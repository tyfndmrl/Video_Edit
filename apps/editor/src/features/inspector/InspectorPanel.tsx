/**
 * Inspector panel — selected clip properties (features/inspector,
 * ClipPropertiesPanel)
 * + the "İşlem Geçmişi" section (undo/redo history, features/history)
 * + the "Dışa Aktarmalar" section (export job list, features/export).
 */
import { ClipPropertiesPanel } from './ClipPropertiesPanel';
import { ExportJobsCard } from '../export/ExportJobsCard';
import { HistoryPanel } from '../history/HistoryPanel';
import { MissingMediaNotice } from '../library/MissingMediaNotice';
import { useProjectSession } from '../../state/projectSession';

export function InspectorPanel() {
  const projectId = useProjectSession((s) => s.projectId);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-surface-2 px-3 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Özellikler
      </header>
      {/* Silinmiş medyaya bağlı seçim uyarısı (features/library/missingMedia). */}
      <MissingMediaNotice />
      <ClipPropertiesPanel />
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
