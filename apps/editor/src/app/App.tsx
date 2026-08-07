import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { LoginGate } from '../features/auth/LoginGate';
import { LibraryPanel } from '../features/library/LibraryPanel';
import { PlayerPanel } from '../features/player/PlayerPanel';
import { TimelinePanel } from '../features/timeline/TimelinePanel';
import { InspectorPanel } from '../features/inspector/InspectorPanel';
import { installShortcutDispatcher } from '../features/shortcuts/dispatcher';
import { useMediaUrlSync } from '../features/player/mediaUrls';
import { useEditorStore } from '../state/editorStore';
import { closeProject, openProject } from '../state/projectSession';

/**
 * Editor shell — 4-panel CSS grid layout:
 *
 *   +----------+----------------+-----------+
 *   | Library  |     Player     | Inspector |
 *   |          +----------------+           |
 *   |          |    Timeline    |           |
 *   +----------+----------------+-----------+
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        <EditorBoot />
        <div className="grid h-full grid-cols-[280px_minmax(0,1fr)_320px] grid-rows-[minmax(0,1fr)_280px] bg-surface-0">
          <aside className="row-span-2 min-h-0 border-r border-edge bg-surface-1">
            <LibraryPanel />
          </aside>
          <main className="min-h-0 bg-surface-0">
            <PlayerPanel />
          </main>
          <aside className="row-span-2 col-start-3 min-h-0 border-l border-edge bg-surface-1">
            <InspectorPanel />
          </aside>
          <section className="col-start-2 min-h-0 border-t border-edge bg-surface-1">
            <TimelinePanel />
          </section>
        </div>
      </LoginGate>
    </QueryClientProvider>
  );
}

/**
 * Editor-global side effects (behind the login gate so API calls carry auth):
 * - the single keyboard shortcut dispatcher,
 * - project session: load doc + arm autosave when a project is selected,
 * - presigned media URLs for filmstrip/waveform/proxy painters.
 */
function EditorBoot() {
  const projectId = useEditorStore((s) => s.activeProjectId);

  useEffect(() => installShortcutDispatcher(), []);

  useEffect(() => {
    if (projectId === null) {
      closeProject();
      return;
    }
    void openProject(projectId);
  }, [projectId]);

  // Presigned media URLs (proxy/poster/sprites/filmstrip/waveform) — the
  // single sync instance for the whole app (features/player/mediaUrls).
  useMediaUrlSync(projectId);
  return null;
}
