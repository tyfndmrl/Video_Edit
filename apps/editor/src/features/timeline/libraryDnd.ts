/**
 * libraryDnd — pointer-based drag from the library panel into the timeline
 * (design 01 §3.3: custom pointer DnD, HTML5 DnD/dnd-kit are canvas-hostile).
 *
 * The library card keeps pointer capture and feeds positions into this store;
 * the timeline reads the store to paint its insert ghost and registers a drop
 * target that receives the final position on release.
 */
import { create } from 'zustand';
import type { MicroSec, Uuid } from '@videoedit/timeline-schema';
import type { AssetKind } from '../../state/assetStore';

export interface LibraryDragPayload {
  assetId: Uuid;
  kind: AssetKind;
  name: string;
  durationUs: MicroSec;
}

export interface LibraryDragState extends LibraryDragPayload {
  clientX: number;
  clientY: number;
}

interface LibraryDndStore {
  drag: LibraryDragState | null;
}

export const useLibraryDndStore = create<LibraryDndStore>()(() => ({ drag: null }));

export interface TimelineDropTarget {
  /** Called on pointerup with the last client position. */
  drop(pos: { clientX: number; clientY: number }, payload: LibraryDragPayload): void;
}

let dropTarget: TimelineDropTarget | null = null;

export function registerTimelineDropTarget(target: TimelineDropTarget): () => void {
  dropTarget = target;
  return () => {
    if (dropTarget === target) dropTarget = null;
  };
}

export function startLibraryDrag(payload: LibraryDragPayload, clientX: number, clientY: number): void {
  useLibraryDndStore.setState({ drag: { ...payload, clientX, clientY } });
}

export function updateLibraryDrag(clientX: number, clientY: number): void {
  const drag = useLibraryDndStore.getState().drag;
  if (!drag) return;
  useLibraryDndStore.setState({ drag: { ...drag, clientX, clientY } });
}

export function endLibraryDrag(clientX: number, clientY: number): void {
  const drag = useLibraryDndStore.getState().drag;
  useLibraryDndStore.setState({ drag: null });
  if (drag && dropTarget) {
    dropTarget.drop({ clientX, clientY }, drag);
  }
}

export function cancelLibraryDrag(): void {
  useLibraryDndStore.setState({ drag: null });
}
