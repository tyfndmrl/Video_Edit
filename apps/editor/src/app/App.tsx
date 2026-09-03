import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { TopBar } from './TopBar';
import { LoginGate } from '../features/auth/LoginGate';
import { LibraryPanel } from '../features/library/LibraryPanel';
import { PlayerPanel } from '../features/player/PlayerPanel';
import { TimelinePanel } from '../features/timeline/TimelinePanel';
import {
  selectTimelineHeightPx,
  setTimelineAvailablePx,
  useTimelineHeightStore,
} from '../features/timeline/timelineHeight';
import { InspectorPanel } from '../features/inspector/InspectorPanel';
import { installShortcutDispatcher } from '../features/shortcuts/dispatcher';
import { ShortcutsHelpOverlay } from '../features/shortcuts/ShortcutsHelpOverlay';
import { ProjectPicker } from '../features/projects/ProjectPicker';
import { useMediaUrlSync } from '../features/player/mediaUrls';
import { bootstrapFontCatalogue } from '../features/text/fontCatalogue';
import { useEditorStore } from '../state/editorStore';
import { closeProject, openProject } from '../state/projectSession';

/**
 * App shell: login gate -> proje seçici (activeProjectId null) VEYA editör.
 *
 * Editor layout — top bar + 4-panel CSS grid:
 *
 *   +---------------------------------------+
 *   |                Top bar                |
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
        <AppContent />
        <ShortcutsHelpOverlay />
      </LoginGate>
    </QueryClientProvider>
  );
}

/** activeProjectId null iken editör grid'i yerine tam ekran proje seçici. */
function AppContent() {
  const projectId = useEditorStore((s) => s.activeProjectId);
  if (projectId === null) return <ProjectPicker />;
  // Paneller BURADA yaratılır ve EditorGrid'e children olarak geçer: grid
  // yüksekliğe abone olduğu için her sürükleme karesinde yeniden render olur,
  // ama bu elementlerin KİMLİĞİ değişmediğinden dört panelin hiçbiri yeniden
  // render EDİLMEZ (children-as-props).
  return (
    <EditorGrid
      topBar={<TopBar />}
      library={<LibraryPanel />}
      player={<PlayerPanel />}
      inspector={<InspectorPanel />}
      timeline={<TimelinePanel />}
    />
  );
}

/**
 * Dört panelin CSS grid'i. Timeline satırı artık sabit değil: yükseklik
 * `features/timeline/timelineHeight` store'undan gelir ve satır INLINE style
 * ile yazılır — Tailwind JIT çalışma zamanı değeri için sınıf üretemez
 * (`grid-rows-[…280px]` derleme zamanı sabitiydi).
 *
 * Yatay düzlem yapısal olarak KORUNUR: `grid-cols` ve tüm row-span/col-start
 * yerleşimleri aynen kalır, yalnız 3. satırın yüksekliği değişir; artan/azalan
 * payı yutan tek hücre oynatıcıdır (2. satır `minmax(0,1fr)`).
 */
function EditorGrid({
  topBar,
  library,
  player,
  inspector,
  timeline,
}: {
  topBar: ReactNode;
  library: ReactNode;
  player: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
}) {
  const timelineHeightPx = useTimelineHeightStore(selectTimelineHeightPx);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const topBarRef = useRef<HTMLDivElement | null>(null);

  // Oynatıcı + timeline'a kalan yükseklik = grid − üst çubuk. İLK ölçüm
  // layout efektinde (boyanmadan önce) alınır: bir kare bile yanlış satır
  // yüksekliğiyle boyamak, tuvalin letterbox kutusunu oynatırdı.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = (): void => {
      const gridH = grid.getBoundingClientRect().height;
      const barH = topBarRef.current?.getBoundingClientRect().height ?? 0;
      setTimelineAvailablePx(Math.max(0, gridH - barH));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    if (topBarRef.current) ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={gridRef}
      className="grid h-full grid-cols-[280px_minmax(0,1fr)_320px] bg-surface-0"
      style={{ gridTemplateRows: `auto minmax(0,1fr) ${timelineHeightPx}px` }}
    >
      <div ref={topBarRef} className="col-span-3">
        {topBar}
      </div>
      <aside className="row-span-2 row-start-2 min-h-0 border-r border-edge bg-surface-1">
        {library}
      </aside>
      <main className="col-start-2 row-start-2 min-h-0 bg-surface-0">{player}</main>
      <aside className="col-start-3 row-span-2 row-start-2 min-h-0 border-l border-edge bg-surface-1">
        {inspector}
      </aside>
      {/* id: tutamağın aria-controls hedefi (ve e2e'nin ölçtüğü kutu). */}
      <section
        id="timeline-section"
        className="col-start-2 row-start-3 min-h-0 border-t border-edge bg-surface-1"
      >
        {timeline}
      </section>
    </div>
  );
}

/**
 * Editor-global side effects (behind the login gate so API calls carry auth):
 * - the single keyboard shortcut dispatcher,
 * - project session: load doc + arm autosave when a project is selected,
 * - presigned media URLs for filmstrip/waveform/proxy painters,
 * - the font catalogue (GET /api/fonts) + its @font-face rules.
 */
function EditorBoot() {
  const projectId = useEditorStore((s) => s.activeProjectId);

  useEffect(() => installShortcutDispatcher(), []);

  // Font catalogue FIRST: a new text clip is born with DEFAULT_FONT_ID and the
  // preview measures with the curated @font-face file. Loading it late would
  // mean the first text raster uses fallback metrics (it self-corrects — the
  // raster key carries the catalogue revision — but the flash is avoidable).
  // Failure is non-fatal: the editor keeps the last known / compiled-in list.
  useEffect(() => bootstrapFontCatalogue(), []);

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
