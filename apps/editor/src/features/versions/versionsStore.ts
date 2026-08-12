/**
 * versionsStore — open/closed state of the "Sürümler" overlay plus the
 * in-flight status of the two write actions (checkpoint / restore).
 *
 * Same lightweight zustand-singleton pattern as features/shortcuts/shortcutsHelp.ts.
 * The actions themselves live in versionsActions.ts (they touch the doc store,
 * autosave and the API; keeping them out of this module keeps the UI state
 * import-cycle free).
 */
import { create } from 'zustand';

export type VersionsBusy = null | 'checkpoint' | 'restore';

export interface VersionsUiState {
  open: boolean;
  /** Non-null while a write action is running — the editor is locked then. */
  busy: VersionsBusy;
  /** Refusal/failure message shown inside the overlay (role="alert"). */
  error: string | null;
  /** Success message shown inside the overlay (role="status"). */
  notice: string | null;
}

export const useVersionsStore = create<VersionsUiState>()(() => ({
  open: false,
  busy: null,
  error: null,
  notice: null,
}));

export function openVersionsOverlay(): void {
  // Stale messages from a previous visit must not look like fresh feedback.
  useVersionsStore.setState({ open: true, error: null, notice: null });
}

/**
 * Close the overlay. Refused while a write action is in flight: during a
 * restore the document store is LOCKED and the doc is about to be replaced —
 * hiding that behind a closed panel would leave the user staring at a frozen
 * editor with no explanation.
 */
export function closeVersionsOverlay(): void {
  if (useVersionsStore.getState().busy !== null) return;
  useVersionsStore.setState({ open: false, error: null, notice: null });
}

export function toggleVersionsOverlay(): void {
  if (useVersionsStore.getState().open) {
    closeVersionsOverlay();
    return;
  }
  openVersionsOverlay();
}

export function isVersionsOverlayOpen(): boolean {
  return useVersionsStore.getState().open;
}
