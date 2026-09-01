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
  groupClips,
  pasteAtPlayhead,
  projectEndUs,
  selectAllClips,
  splitAtPlayhead,
  trimSelectedToPlayhead,
  ungroupClips,
} from '../../state/timelineOps';
import { isTimelineMenuOpen } from '../timeline/contextMenuState';
import { getTimelineViewControl } from '../timeline/viewControl';
import { withEngine } from './playerBridge';
import { startOrBumpShuttle, stopShuttle, useTransportStore } from './shuttle';
import {
  closeShortcutsOverlay,
  isShortcutsOverlayOpen,
  toggleShortcutsOverlay,
} from './shortcutsHelp';

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

/**
 * True when shortcuts that MUTATE the document may run. They are swallowed
 * (handled, but no-op) while:
 * - the project session is not ready (loading/error/no project — chief
 *   architect finding 1b: edits must not race openProject), or
 * - the autosave 409 conflict dialog is up (finding 5: editing a document
 *   that is about to be replaced by the server copy is meaningless).
 *
 * UNDO/REDO COUNT AS MUTATIONS. They rewrite the document from patches and
 * mark autosave dirty exactly like an edit; a Ctrl+Z under the conflict dialog
 * (or during a project load) mutated a document that was about to be replaced
 * by the server copy, and autosave then tried to save it.
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
  // Shuttle'dayken Space = DUR (NLE uzlaşımı) — oynatmaya GEÇMEZ. Shuttle
  // zaten motor-paused çalıştığı için durdurmak yeterlidir.
  const wasShuttling = stopShuttle();
  useTransportStore.getState().setForwardRate(1);
  if (wasShuttling) return;
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
      if (docMutationAllowed()) {
        if (e.shiftKey) store.redo();
        else store.undo();
      }
      return true;
    case 'y':
      if (docMutationAllowed()) store.redo();
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
    case 'g':
      // Grup çifti (ozellik-4): Ctrl+G grupla, Ctrl+Shift+G dağıt — menüdeki
      // 'Grupla'/'Grubu dağıt' ile AYNI seçim-tabanlı op'lar.
      if (docMutationAllowed()) {
        if (e.shiftKey) ungroupClips([...selection]);
        else groupClips([...selection]);
      }
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
  // Sağ tık menüsü açıkken klavyenin sahibi MENÜDÜR (aynı "modal açık" kuralı
  // editable target'ta olduğu gibi PASİF geçer: preventDefault etmeyiz, menü
  // kendi gezinmesini yapar, Escape'i de kendi capture listener'ı yutar).
  // Bu kapı olmadan menü açıkken Delete klip siliyor, 'c' bölüyor ve ArrowDown
  // playhead'i menünün gösterdiği hedefin dışına taşıyordu.
  if (isTimelineMenuOpen()) return false;
  if (e.altKey) return false;
  if (e.ctrlKey || e.metaKey) return handleCtrlShortcut(e);

  const editor = useEditorStore.getState();
  const doc = useDocStore.getState().doc;

  switch (e.key) {
    case '?':
      // Keşfedilebilirlik: kısayol listesi overlay'i (çoğu düzende Shift+/).
      toggleShortcutsOverlay();
      return true;
    case 'Escape':
      if (isShortcutsOverlayOpen()) {
        closeShortcutsOverlay();
        return true;
      }
      return false;
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
      // SESSİZ kademeli geri tarama (shuttle.ts): motor DAİMA paused kalır,
      // playhead store üzerinden geri akar (tek-yazım-yolu korunur — dispatcher
      // motoru seek'lemez). Basılı tutmanın OS auto-repeat'i YUTULUR: repeat
      // olayı shuttle'ı yeniden tetiklemez/kademe fırlatmaz ama yine true döner
      // (tarayıcıya düşmesin).
      useTransportStore.getState().setForwardRate(1);
      withEngine((engine) => engine.pause());
      if (!e.repeat) startOrBumpShuttle();
      return true;
    case 'k':
      useTransportStore.getState().setForwardRate(1);
      stopShuttle();
      withEngine((engine) => engine.pause());
      return true;
    case 'l': {
      // Shuttle'dan L: geri tarama durur, İLERİ oynatma 1x'ten başlar (shuttle
      // hızı devralınmaz — isPlaying false olduğu için alttaki kademe zaten
      // 1'e düşer). Oynarken L: mevcut kademe (2x…8x) aynen işler. e.repeat
      // J'deki gibi YUTULUR — basılı tutmak OS auto-repeat'iyle kademeyi 8x'e
      // fırlatmasın (küçük, savunulabilir davranış değişikliği; DECISIONS).
      if (e.repeat) return true;
      stopShuttle();
      const playing = useEditorStore.getState().isPlaying;
      const transport = useTransportStore.getState();
      const rate = playing ? Math.min(transport.forwardRate * 2, 8) : 1;
      transport.setForwardRate(rate);
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
