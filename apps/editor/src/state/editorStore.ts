/**
 * editorStore — ephemeral view/interaction state.
 *
 * NOT subject to undo and NOT autosaved (design doc 01-frontend-editor.md §2.1).
 * Undo only rewinds the document; playhead/selection stay where they are.
 */
import { create } from 'zustand';
import type { MicroSec, Uuid } from '@videoedit/timeline-schema';

export type EditorTool = 'select' | 'blade' | 'hand';

export interface EditorStore {
  /**
   * Project currently open in the editor. null until a project is selected
   * (the library shows a "no project" state). A real project picker/router
   * arrives later; for now it can be set programmatically or via the
   * ?project=<id> URL parameter (dev convenience).
   */
  activeProjectId: Uuid | null;
  /** Selected clip ids (marquee / shift-click multi-select). */
  selection: Set<Uuid>;
  playheadUs: MicroSec;
  /** Timeline zoom: horizontal pixels per microsecond (xPx = (timeUs - scrollUs) * pxPerUs). */
  pxPerUs: number;
  /** Timeline horizontal scroll offset, in microseconds. */
  scrollUs: MicroSec;
  snappingEnabled: boolean;
  tool: EditorTool;

  setActiveProjectId(id: Uuid | null): void;
  setSelection(ids: Iterable<Uuid>): void;
  addToSelection(id: Uuid): void;
  removeFromSelection(id: Uuid): void;
  clearSelection(): void;
  setPlayheadUs(timeUs: MicroSec): void;
  setPxPerUs(pxPerUs: number): void;
  setScrollUs(scrollUs: MicroSec): void;
  toggleSnapping(): void;
  setTool(tool: EditorTool): void;
}

/** Dev convenience until the project picker exists: ?project=<id> in the URL. */
function initialProjectId(): Uuid | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('project');
  } catch {
    return null;
  }
}

export const useEditorStore = create<EditorStore>()((set) => ({
  activeProjectId: initialProjectId(),
  selection: new Set<Uuid>(),
  playheadUs: 0,
  pxPerUs: 0.0001, // 100 px per second — a sane default before fit-to-view runs
  scrollUs: 0,
  snappingEnabled: true,
  tool: 'select',

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
  setPlayheadUs: (timeUs) => set({ playheadUs: Math.max(0, Math.round(timeUs)) }),
  setPxPerUs: (pxPerUs) => set({ pxPerUs }),
  setScrollUs: (scrollUs) => set({ scrollUs: Math.max(0, scrollUs) }),
  toggleSnapping: () => set((s) => ({ snappingEnabled: !s.snappingEnabled })),
  setTool: (tool) => set({ tool }),
}));
