/**
 * Central keyboard dispatcher (design 01 §3.4) — ONE window keydown listener,
 * no per-component hotkey hooks. Passive while an input/textarea/
 * contenteditable is focused (pitfall #10: single-letter shortcuts must never
 * fire while typing).
 *
 * `handleShortcut` is pure over its event-like argument (no DOM types) so the
 * dispatch table is unit-testable in a node environment.
 */
import { frameToUs, snapUsToFrameGrid, usToFrame } from '@videoedit/timeline-schema';
import { useAutosaveStore } from '../../state/autosave';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useProjectSession } from '../../state/projectSession';
import {
  addMarkerAtPlayhead,
  collectCutPoints,
  copyClips,
  cutClips,
  deleteClips,
  duplicateClips,
  pasteAtPlayhead,
  projectEndUs,
  selectAllClips,
  splitAtPlayhead,
  trimSelectedToPlayhead,
} from '../../state/timelineOps';
import { getTimelineViewControl } from '../timeline/viewControl';
import { withEngine } from './playerBridge';

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
  repeat?: boolean;
}

/** True for focus targets where typing must win over single-key shortcuts. */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

// L cycles 1x -> 2x while already playing (design: "L tekrar = 2x").
let forwardRate = 1;

/**
 * True when shortcuts that MUTATE the document may run. They are swallowed
 * (handled, but no-op) while:
 * - the project session is not ready (loading/error/no project — chief
 *   architect finding 1b: edits must not race openProject), or
 * - the autosave 409 conflict dialog is up (finding 5: editing a document
 *   that is about to be replaced by the server copy is meaningless).
 */
function docMutationAllowed(): boolean {
  if (useProjectSession.getState().status !== 'ready') return false;
  if (useAutosaveStore.getState().status === 'conflict') return false;
  return true;
}

function setPlayhead(timeUs: number): void {
  // Single write path (finding 2): the store is the ONLY playhead authority.
  // PlayerPanel subscribes to userSeekSeq/playheadUs and runs its own
  // fast+settle seek — no direct engine.seek from the dispatcher.
  useEditorStore.getState().setPlayheadUs(Math.max(0, Math.round(timeUs)));
}

function stepFrames(delta: number): void {
  const { doc } = useDocStore.getState();
  const fps = doc.settings.fps;
  const frame = usToFrame(useEditorStore.getState().playheadUs, fps);
  setPlayhead(frameToUs(Math.max(0, frame + delta), fps));
}

function stepSeconds(delta: number): void {
  const { doc } = useDocStore.getState();
  const t = useEditorStore.getState().playheadUs + delta * 1_000_000;
  setPlayhead(snapUsToFrameGrid(Math.max(0, t), doc.settings.fps));
}

function jumpToCutPoint(direction: -1 | 1): void {
  const doc = useDocStore.getState().doc;
  const playhead = useEditorStore.getState().playheadUs;
  const points = collectCutPoints(doc);
  if (direction === 1) {
    const next = points.find((p) => p > playhead);
    if (next !== undefined) setPlayhead(next);
  } else {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i] < playhead) {
        setPlayhead(points[i]);
        return;
      }
    }
    setPlayhead(0);
  }
}

function togglePlayback(): void {
  forwardRate = 1;
  const playing = useEditorStore.getState().isPlaying;
  withEngine((engine) => {
    if (playing) engine.pause();
    else {
      engine.setPlaybackRate(1);
      engine.play();
    }
  });
}

function handleCtrlShortcut(e: KeyEventLike): boolean {
  const store = useDocStore.getState();
  const selection = useEditorStore.getState().selection;
  switch (e.key.toLowerCase()) {
    case 'z':
      if (e.shiftKey) store.redo();
      else store.undo();
      return true;
    case 'y':
      store.redo();
      return true;
    case 'a':
      selectAllClips();
      return true;
    case 'c':
      copyClips([...selection]);
      return true;
    case 'x':
      if (docMutationAllowed()) cutClips([...selection]);
      return true;
    case 'v':
      if (docMutationAllowed()) pasteAtPlayhead();
      return true;
    case 'd':
      if (docMutationAllowed()) duplicateClips([...selection]);
      return true;
    default:
      return false;
  }
}

/**
 * Dispatch a key event. Returns true when the shortcut was handled (the DOM
 * listener then calls preventDefault). Never handles anything while an
 * editable element is focused.
 */
export function handleShortcut(e: KeyEventLike): boolean {
  if (isEditableTarget(e.target)) return false;
  if (e.altKey) return false;
  if (e.ctrlKey || e.metaKey) return handleCtrlShortcut(e);

  const editor = useEditorStore.getState();
  const doc = useDocStore.getState().doc;

  switch (e.key) {
    case ' ':
      togglePlayback();
      return true;
    case 'ArrowLeft':
      if (e.shiftKey) stepSeconds(-1);
      else stepFrames(-1);
      return true;
    case 'ArrowRight':
      if (e.shiftKey) stepSeconds(1);
      else stepFrames(1);
      return true;
    case 'ArrowUp':
      jumpToCutPoint(-1);
      return true;
    case 'ArrowDown':
      jumpToCutPoint(1);
      return true;
    case 'Home':
      setPlayhead(0);
      return true;
    case 'End':
      setPlayhead(projectEndUs(doc));
      return true;
    case 'Delete':
    case 'Backspace':
      if (docMutationAllowed() && editor.selection.size > 0) {
        deleteClips([...editor.selection], { ripple: e.shiftKey });
      }
      return true;
    default:
      break;
  }

  switch (e.key.toLowerCase()) {
    case 'j':
      // v1: no reverse playback — J behaves as a fast back-scrub (design §3.4 note).
      forwardRate = 1;
      withEngine((engine) => engine.pause());
      stepSeconds(-1);
      return true;
    case 'k':
      forwardRate = 1;
      withEngine((engine) => engine.pause());
      return true;
    case 'l': {
      const playing = useEditorStore.getState().isPlaying;
      forwardRate = playing ? Math.min(forwardRate * 2, 8) : 1;
      const rate = forwardRate;
      withEngine((engine) => {
        engine.setPlaybackRate(rate);
        engine.play();
      });
      return true;
    }
    case 'c':
      if (docMutationAllowed()) splitAtPlayhead();
      return true;
    case 'q':
      if (docMutationAllowed()) trimSelectedToPlayhead('left');
      return true;
    case 'w':
      if (docMutationAllowed()) trimSelectedToPlayhead('right');
      return true;
    case 's':
      editor.toggleSnapping();
      return true;
    case 'm':
      if (docMutationAllowed()) addMarkerAtPlayhead();
      return true;
    case '+':
    case '=':
      getTimelineViewControl()?.zoomBy(1.25);
      return true;
    case '-':
      getTimelineViewControl()?.zoomBy(1 / 1.25);
      return true;
    case 'z':
      if (e.shiftKey) {
        getTimelineViewControl()?.fitToProject();
        return true;
      }
      return false;
    default:
      return false;
  }
}

/** Install the single window keydown listener. Returns the uninstaller. */
export function installShortcutDispatcher(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (handleShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
