/**
 * TopBar — thin editor top bar (M3): project name on the left, autosave chip
 * (moved here from the timeline header) + the export entry point on the right.
 */
import { useState } from 'react';
import { AutosaveIndicator } from '../features/timeline/AutosaveIndicator';
import { ExportDialog } from '../features/export/ExportDialog';
import { useProjectSession } from '../state/projectSession';

export function TopBar() {
  const projectId = useProjectSession((s) => s.projectId);
  const projectName = useProjectSession((s) => s.projectName);
  const sessionReady = useProjectSession((s) => s.status) === 'ready';
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <header className="flex items-center gap-2 border-b border-edge bg-surface-2 px-3 py-1.5">
      <span className="min-w-0 truncate text-xs font-semibold text-fg" title={projectName ?? undefined}>
        {projectName ?? '—'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <AutosaveIndicator />
        <button
          type="button"
          disabled={!sessionReady}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-surface-0 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          onClick={() => setExportOpen(true)}
        >
          Dışa Aktar
        </button>
      </div>
      {sessionReady && projectId !== null && (
        <ExportDialog
          projectId={projectId}
          open={exportOpen}
          onClose={() => setExportOpen(false)}
        />
      )}
    </header>
  );
}
