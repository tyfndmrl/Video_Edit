import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { LoginGate } from '../features/auth/LoginGate';
import { LibraryPanel } from '../features/library/LibraryPanel';
import { PlayerPanel } from '../features/player/PlayerPanel';
import { TimelinePanel } from '../features/timeline/TimelinePanel';
import { InspectorPanel } from '../features/inspector/InspectorPanel';

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
