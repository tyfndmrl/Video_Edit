/**
 * Overlay placement policy — "the user asked for a text layer; where does it
 * go?".
 *
 * Deliberately the same shape as features/library/addToTimeline.ts: the POLICY
 * lives in the feature, every actual mutation goes through a state/timelineOps
 * op (frame snap, overlap refusal, invariant assert, undo entry and selection
 * all happen there). A failed attempt never mutates the document, so trying
 * tracks in order is safe.
 *
 * Policy:
 * 1. try each unlocked overlay track, at the playhead, in document order;
 * 2. if the playhead is occupied on all of them, open a NEW overlay track
 *    (a new text layer on top is what the user meant, and it can never fail).
 *
 * Note the asymmetry with addToTimeline (which falls back to the project end
 * before creating a track): an overlay is authored AT a moment — silently
 * dropping the caption 40 s later would be worse than stacking a lane.
 *
 * No project-session guard here, deliberately: every ENTRY POINT already gates
 * on it (the TopBar buttons and the library sticker button are disabled while
 * the project loads, TimelinePanel.runMenuAction returns early), and docStore
 * `locked` is the backstop that refuses the mutation itself. Re-checking here
 * would only make the pure "where does it go" policy untestable without a
 * session store.
 */
import type { ShapeClip, Uuid } from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import {
  addShapeClip,
  addStickerClip,
  addTextClip,
  type AddClipResult,
} from '../../state/timelineOps';
import {
  DEFAULT_SHAPE_SCALE,
  OVERLAY_DEFAULT_DURATION_US,
  defaultShapeStyle,
  defaultTextStyle,
} from './overlayDefaults';

/** Overlay tracks that can accept a clip right now, in document order. */
function candidateTrackIds(): Uuid[] {
  return useDocStore
    .getState()
    .doc.tracks.filter((t) => t.type === 'overlay' && !t.locked)
    .map((t) => t.id);
}

function startUsFor(timeUs?: number): number {
  return Math.max(0, Math.round(timeUs ?? useEditorStore.getState().playheadUs));
}

/**
 * Runs `attempt` against every candidate overlay track, then against a fresh
 * one. Returns the first success (or the last failure, which can only be a
 * precondition failure such as "asset is not ready").
 */
function placeOnOverlayTrack(
  attempt: (target: { trackId: Uuid } | { newTrack: true }) => AddClipResult,
): AddClipResult {
  let last: AddClipResult = { ok: false, reason: 'no overlay track' };
  for (const trackId of candidateTrackIds()) {
    last = attempt({ trackId });
    if (last.ok) return last;
    // A precondition failure (asset not ready, ...) will fail on every track;
    // only placement conflicts are worth retrying elsewhere.
    if (last.reason !== 'overlaps an existing clip') return last;
  }
  return attempt({ newTrack: true });
}

export function addTextAtPlayhead(opts: { timeUs?: number; content?: string } = {}): AddClipResult {
  const settings = useDocStore.getState().doc.settings;
  const style = defaultTextStyle(settings, opts.content);
  const startUs = startUsFor(opts.timeUs);
  return placeOnOverlayTrack((target) =>
    addTextClip(style, target, startUs, OVERLAY_DEFAULT_DURATION_US),
  );
}

export function addShapeAtPlayhead(
  opts: { timeUs?: number; type?: ShapeClip['shape']['type'] } = {},
): AddClipResult {
  const style = defaultShapeStyle(opts.type);
  const startUs = startUsFor(opts.timeUs);
  return placeOnOverlayTrack((target) =>
    addShapeClip(style, target, startUs, OVERLAY_DEFAULT_DURATION_US, DEFAULT_SHAPE_SCALE),
  );
}

export function addStickerAtPlayhead(
  assetId: Uuid,
  opts: { timeUs?: number } = {},
): AddClipResult {
  const startUs = startUsFor(opts.timeUs);
  return placeOnOverlayTrack((target) =>
    addStickerClip(assetId, target, startUs, OVERLAY_DEFAULT_DURATION_US),
  );
}
