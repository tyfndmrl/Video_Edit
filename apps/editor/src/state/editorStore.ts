/**
 * editorStore — ephemeral view/interaction state.
 *
 * NOT subject to undo and NOT autosaved (design doc 01-frontend-editor.md §2.1).
 * Undo only rewinds the document; playhead/selection stay where they are.
 */
import { create } from 'zustand';
import type { MicroSec, Uuid } from '@videoedit/timeline-schema';

export type EditorTool = 'select' | 'blade' | 'hand';

/**
 * Who is writing the playhead:
 * - 'user'   — an explicit seek intent (timeline scrub, arrow keys, Home/End).
 * - 'engine' — the playback engine's clock/settle callbacks.
 */
export type PlayheadWriteSource = 'user' | 'engine';

export interface EditorStore {
  /**
   * Project currently open in the editor. null -> the ProjectPicker renders
   * instead of the editor grid. Set via the picker (openProjectInEditor) or
   * the ?project=<id> URL parameter — the OFFICIAL shareable deep-link, kept
   * in sync by features/projects/projectPickerLogic (history.replaceState).
   */
  activeProjectId: Uuid | null;
  /** Selected clip ids (marquee / shift-click multi-select). */
  selection: Set<Uuid>;
  playheadUs: MicroSec;
  /**
   * Monotonic counter incremented on every 'user' playhead write. The player
   * subscribes to this to know a NEW user seek intent happened (a repeated
   * seek to the same time still bumps it).
   */
  userSeekSeq: number;
  /** Timeline zoom: horizontal pixels per microsecond (xPx = (timeUs - scrollUs) * pxPerUs). */
  pxPerUs: number;
  /** Timeline horizontal scroll offset, in microseconds. */
  scrollUs: MicroSec;
  snappingEnabled: boolean;
  tool: EditorTool;
  /**
   * Playback state. WRITTEN by the player engine (play/pause), READ by the
   * timeline/shortcuts (Space toggles based on it). Not undoable, not saved.
   */
  isPlaying: boolean;

  setActiveProjectId(id: Uuid | null): void;
  setSelection(ids: Iterable<Uuid>): void;
  addToSelection(id: Uuid): void;
  removeFromSelection(id: Uuid): void;
  clearSelection(): void;
  /**
   * Write the playhead (integer µs, clamped to >= 0).
   *
   * Source discipline (M2 chief-architect finding — single write path):
   * - 'user' (default): always accepted; bumps userSeekSeq.
   * - 'engine': accepted while playback is running. While PAUSED an engine
   *   write is accepted only if NO user seek happened since the engine last
   *   owned the playhead (i.e. the pause-settle write right after pause()).
   *   A stale engine write landing after a newer user seek is silently
   *   dropped — the store value (the user's frame-snapped target) stays
   *   authoritative until playback runs again.
   */
  setPlayheadUs(timeUs: MicroSec, source?: PlayheadWriteSource): void;
  setPxPerUs(pxPerUs: number): void;
  setScrollUs(scrollUs: MicroSec): void;
  toggleSnapping(): void;
  setTool(tool: EditorTool): void;
  setIsPlaying(playing: boolean): void;
}

/**
 * ?project=<id> is the official deep-link: an initial load with the parameter
 * opens that project directly (the ProjectPicker keeps the parameter in sync
 * on select/close, so the address bar stays shareable).
 */
function initialProjectId(): Uuid | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('project');
  } catch {
    // erişilemeyen/egzotik location (ör. opaque origin) — parametresiz açılışla eşdeğer
    return null;
  }
}

export const useEditorStore = create<EditorStore>()((set, get) => {
  /**
   * userSeekSeq value at the moment of the last ACCEPTED 'engine' write.
   * Engine writes while paused are accepted only when this still equals the
   * current userSeekSeq (see setPlayheadUs doc above). Accepted engine writes
   * re-sync it, so the engine regains paused-write rights whenever playback
   * runs after the user's latest seek.
   */
  let engineSyncSeq = 0;

  return {
    activeProjectId: initialProjectId(),
    selection: new Set<Uuid>(),
    playheadUs: 0,
    userSeekSeq: 0,
    pxPerUs: 0.0001, // 100 px per second — a sane default before fit-to-view runs
    scrollUs: 0,
    snappingEnabled: true,
    tool: 'select',
    isPlaying: false,

    setActiveProjectId: (id) => set({ activeProjectId: id }),
    setSelection: (ids) => set({ selection: new Set(ids) }),
    addToSelection: (id) =>
      set((s) => {
        const next = new Set(s.selection);
        next.add(id);
        return { selection: next };
      }),
    removeFromSelection: (id) =>
      set((s) => {
        const next = new Set(s.selection);
        next.delete(id);
        return { selection: next };
      }),
    clearSelection: () => set({ selection: new Set() }),
    setPlayheadUs: (timeUs, source = 'user') => {
      const t = Math.max(0, Math.round(timeUs));
      if (source === 'engine') {
        const s = get();
        // Paused + a user seek happened since the engine last owned the
        // playhead -> this is a stale async write; drop it silently.
        if (!s.isPlaying && engineSyncSeq !== s.userSeekSeq) return;
        engineSyncSeq = s.userSeekSeq;
        set({ playheadUs: t });
        return;
      }
      set((s) => ({ playheadUs: t, userSeekSeq: s.userSeekSeq + 1 }));
    },
    setPxPerUs: (pxPerUs) => set({ pxPerUs }),
    setScrollUs: (scrollUs) => set({ scrollUs: Math.max(0, scrollUs) }),
    toggleSnapping: () => set((s) => ({ snappingEnabled: !s.snappingEnabled })),
    setTool: (tool) => set({ tool }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),
  };
});
