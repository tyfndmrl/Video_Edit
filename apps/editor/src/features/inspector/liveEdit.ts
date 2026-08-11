/**
 * liveEdit — one docStore transaction per POINTER GESTURE in the inspector.
 *
 * Dragging a volume slider fires a change event per pixel. Without coalescing
 * that is one undo entry per pixel and one autosave PUT per pixel. The timeline
 * already solved this for trim/move drags (docStore.beginTransaction: many
 * incremental updates, ONE history entry, autosave timers deferred until
 * commit); this module is the same mechanism for panel controls.
 *
 * Gesture boundaries:
 * - pointerdown on a slider / scrub area  -> begin()
 * - every intermediate value              -> update()
 * - pointerup / pointercancel / unmount   -> end()   (single history entry)
 *
 * Non-gesture edits (typing a number, arrow keys on a focused slider) must NOT
 * open a transaction: they are already one discrete change each and go through
 * the plain op wrappers. `isLiveEditOpen()` is how a control tells the two
 * apart.
 */
import type { TimelineDoc } from '@videoedit/timeline-schema';
import { useDocStore, type Transaction } from '../../state/docStore';
import { assertDocValidDev } from '../../state/timelineOps';

let active: Transaction | null = null;
/** Cleanup for an open TYPING burst (see beginBurstEdit). */
let burstCleanup: (() => void) | null = null;
/**
 * True from pointerdown to pointerup on a panel control, EVEN IF no transaction
 * could be opened. The two states are different questions:
 * - `isLiveEditOpen()`  — "is there a transaction to coalesce into?"
 * - `isGestureActive()` — "does a pointer gesture own the panel right now?"
 * Discrete paths (typing, Enter, stepper arrows, blur) must stand down for the
 * second one: a mousedown on a scrub label blurs whatever input had focus, and
 * that blur would otherwise commit a stale number INTO the drag's transaction,
 * under the drag's history label.
 */
let gestureOpen = false;
/** Safety net: a pointerup outside the control must still close the gesture. */
let releaseListeners: (() => void) | null = null;

export function isLiveEditOpen(): boolean {
  return active !== null;
}

/** A pointer gesture owns the panel (whether or not it got a transaction). */
export function isGestureActive(): boolean {
  return gestureOpen;
}

/**
 * The gesture started but the store refused a transaction. Controls must then
 * write NOTHING until the pointer is released: falling back to plain ops would
 * turn one drag into a history entry (and an autosave PUT) per pixel, which is
 * the exact regression this module exists to prevent.
 */
export function isLiveEditBlocked(): boolean {
  return gestureOpen && active === null;
}

/**
 * Opens a coalescing transaction. Returns false when one cannot be opened
 * (document locked during a project load, or a timeline drag already owns the
 * store) — the gesture is still marked active so the caller can stand down.
 */
export function beginLiveEdit(actionType: string, label: string): boolean {
  // A burst edit may still own the store (the user clicked a slider straight
  // from the textarea); close it first or the store refuses this gesture.
  endBurstEdit();
  if (gestureOpen) endLiveEdit();
  const store = useDocStore.getState();
  gestureOpen = true;
  if (typeof window !== 'undefined') {
    const onRelease = (): void => endLiveEdit();
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    releaseListeners = () => {
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }
  if (store.locked || store.transactionOpen) return false;
  active = store.beginTransaction(actionType, label);
  return true;
}

/** Intermediate value inside the open gesture. No-op when none is open. */
export function updateLiveEdit(recipe: (draft: TimelineDoc) => void): void {
  active?.update(recipe);
}

/** Closes the gesture: ONE history entry, then the usual invariant assert. */
export function endLiveEdit(): void {
  releaseListeners?.();
  releaseListeners = null;
  gestureOpen = false;
  const tx = active;
  active = null;
  if (tx === null) return;
  tx.commit();
  assertDocValidDev('inspector live edit');
}

// ---------------------------------------------------------------------------
// Bursts: a stream of NON-pointer edits that must collapse into one entry
// (typing into the text content field, dragging inside the OS colour picker)
// ---------------------------------------------------------------------------

/**
 * How long a typing burst may stay open with no keystrokes. Also the upper
 * bound on how long autosave is deferred by typing (autosave watches
 * docStore.transactionOpen).
 */
export const BURST_EDIT_IDLE_MS = 1200;

/** True while a burst edit owns the store. */
export function isBurstEditOpen(): boolean {
  return burstCleanup !== null;
}

/**
 * Opens a coalescing transaction for a TYPING burst: many keystrokes, ONE
 * history entry ("Metin içeriği değiştirildi"), one autosave PUT.
 *
 * Why this is not `beginLiveEdit`: that one is bounded by a POINTER gesture and
 * its window `pointerup` safety net would close a typing burst on the very
 * click that focused the field. A typing burst instead ends on:
 * - blur / Enter-out (`endBurstEdit`, the normal path),
 * - `BURST_EDIT_IDLE_MS` without a keystroke,
 * - ANY pointerdown outside the field — capture phase, so it lands BEFORE a
 *   timeline/gizmo drag calls `docStore.beginTransaction`, which THROWS while
 *   another transaction is open. That listener is the load-bearing one: without
 *   it, typing then dragging a clip crashes the editor.
 */
export function beginBurstEdit(
  actionType: string,
  label: string,
  isInsideField: (target: EventTarget | null) => boolean,
): boolean {
  endBurstEdit();
  if (gestureOpen) endLiveEdit();
  const store = useDocStore.getState();
  if (store.locked || store.transactionOpen) return false;
  active = store.beginTransaction(actionType, label);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (isInsideField(e.target)) return;
    endBurstEdit();
  };
  const arm = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => endBurstEdit(), BURST_EDIT_IDLE_MS);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onPointerDown, true);
  }
  arm();
  rearmBurst = arm;
  burstCleanup = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    rearmBurst = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onPointerDown, true);
    }
  };
  return true;
}

let rearmBurst: (() => void) | null = null;

/** Feeds one keystroke into the open burst and restarts the idle timer. */
export function updateBurstEdit(recipe: (draft: TimelineDoc) => void): void {
  if (burstCleanup === null) return;
  active?.update(recipe);
  rearmBurst?.();
}

/** Closes a typing burst (idempotent): ONE history entry + invariant assert. */
export function endBurstEdit(): void {
  if (burstCleanup === null) return;
  burstCleanup();
  burstCleanup = null;
  const tx = active;
  active = null;
  if (tx === null) return;
  tx.commit();
  assertDocValidDev('inspector text edit');
}
