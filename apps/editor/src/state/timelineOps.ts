/**
 * timelineOps — every timeline document mutation goes through here.
 *
 * All ops run through docStore's mutate/transaction API (patch-based undo) and
 * every committed op is followed by a dev-mode validateTimelineDoc assert
 * (structure + document invariants + source bounds from the assetStore).
 *
 * Time math uses ONLY the shared schema package helpers (roundHalfUp grid,
 * duration formula) so the editor stays bit-identical with the export
 * compiler (docs/rendering-semantics.md §1).
 *
 * Pure `apply*ToDraft` helpers are exported for interactive drags: the
 * pointer code calls them inside a docStore transaction (one undo entry per
 * drag), while the plain op wrappers commit a single `mutate` each.
 */
import {
  clipTimelineDurationUs,
  frameToUs,
  maxScaleFor,
  roundHalfUp,
  sampleKeyframes,
  snapUsToFrameGrid,
  usToFrame,
  validateTimelineDoc,
  isMediaClip,
  TRANSFORM_SCALE_DECIMALS,
  TRANSFORM_SCALE_MIN,
  type Clip,
  type Keyframe,
  type KeyframeTracks,
  type MediaClip,
  type MicroSec,
  type ProjectSettings,
  type Rational,
  type ShapeClip,
  type StickerClip,
  type TextClip,
  type TimelineDoc,
  type Track,
  type TrackType,
  type Transition,
  type TransitionType,
  type Uuid,
} from '@videoedit/timeline-schema';
import { uuidv7 } from '../lib/uuid';
import { useAssetStore, type AssetSummary } from './assetStore';
import { useDocStore } from './docStore';
import { useEditorStore } from './editorStore';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/**
 * Result of a document op.
 *
 * `notice` is the SUCCESS counterpart of `reason`: the op ran, but it had to
 * adjust something the user did not ask for (a transition auto-shortened by a
 * trim, a transition dropped because its cut disappeared). The rendering
 * contract requires those corrections to happen (rendering-semantics §5.5) and
 * the UI contract requires them to be VISIBLE — silent repair is exactly the
 * "it does something else than what I did" complaint. Both fields carry stable
 * English codes; features/timeline/feedback.ts turns them into Turkish.
 */
export type OpResult = { ok: true; notice?: string } | { ok: false; reason: string };
const OK: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });
const okWith = (notice: string | undefined): OpResult =>
  notice === undefined ? OK : { ok: true, notice };

/** Still images have no intrinsic duration; default clip length (4 s). */
export const IMAGE_DEFAULT_DURATION_US = 4_000_000;

export function clipEndUs(clip: Clip): MicroSec {
  return clip.timelineStartUs + clip.timelineDurationUs;
}

function doc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function minClipDurationUs(fps: Rational): MicroSec {
  return Math.max(1, frameToUs(1, fps));
}

/** assetId -> durationUs for every asset whose duration is known. */
export function knownAssetDurations(): Map<string, MicroSec> {
  const map = new Map<string, MicroSec>();
  for (const a of useAssetStore.getState().assets.values()) {
    if (a.durationUs !== undefined) map.set(a.id, a.durationUs);
  }
  return map;
}

interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

function locateClip(d: TimelineDoc, clipId: Uuid): ClipLocation | null {
  for (let ti = 0; ti < d.tracks.length; ti++) {
    const track = d.tracks[ti];
    const ci = track.clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) return { track, trackIndex: ti, clip: track.clips[ci], clipIndex: ci };
  }
  return null;
}

/**
 * Dev-mode invariant assert — run after EVERY committed op. Throws so tests
 * and dev sessions cannot silently produce a contract-violating document.
 */
export function assertDocValidDev(context: string): void {
  if (!import.meta.env?.DEV) return;
  const result = validateTimelineDoc(useDocStore.getState().doc, knownAssetDurations());
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Timeline invariant violation after "${context}":\n  ${issues}`);
  }
}

function trackTypeForClipKind(kind: Clip['kind']): TrackType {
  if (kind === 'audio') return 'audio';
  if (kind === 'video' || kind === 'image') return 'video';
  return 'overlay';
}

function insertClipSorted(track: Track, clip: Clip): void {
  const i = track.clips.findIndex((c) => c.timelineStartUs > clip.timelineStartUs);
  if (i < 0) track.clips.push(clip);
  else track.clips.splice(i, 0, clip);
}

/** True when [startUs, startUs+durationUs) does not overlap any clip in the track. */
function fitsInTrack(
  track: Track,
  startUs: MicroSec,
  durationUs: MicroSec,
  ignoreIds?: ReadonlySet<Uuid>,
): boolean {
  const endUs = startUs + durationUs;
  for (const c of track.clips) {
    if (ignoreIds?.has(c.id)) continue;
    if (startUs < clipEndUs(c) && c.timelineStartUs < endUs) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transition math (rendering-semantics §5) — pure, no store access
// ---------------------------------------------------------------------------

/** Which cut of a clip a transition sits on: the one before it, or after it. */
export type TransitionEdge = 'in' | 'out';

/**
 * Duration a freshly added transition ASKS for (1 s). The effective value is
 * always the even-frame snap of `min(request, caps)` — see planTransitionDuration.
 */
export const DEFAULT_TRANSITION_DURATION_US = 1_000_000;

/** Notice codes (see OpResult.notice). */
export const TRANSITION_SHORTENED_HANDLE = 'transition shortened by source handle';
export const TRANSITION_SHORTENED_LENGTH = 'transition shortened by clip length';
export const TRANSITION_DROPPED = 'transition removed by edit';

/**
 * Largest EVEN frame count whose grid duration is `<= us` (0 when there is
 * none). Used for CAPS: `usToFrame` rounds half-up and would happily hand back
 * a frame whose duration is above the cap, which is how an "auto-shortened"
 * transition ends up one frame over the invariant it was shortened to satisfy.
 * The walk-down uses the shared grid helpers only (no local fps arithmetic).
 */
export function evenFramesAtMost(us: MicroSec, fps: Rational): number {
  if (!(us > 0)) return 0;
  let f = usToFrame(Math.floor(us), fps);
  for (let guard = 0; guard < 4 && f > 0 && frameToUs(f, fps) > us; guard++) f -= 1;
  return f - (f % 2);
}

/**
 * Even-frame snap of a REQUESTED duration (rendering-semantics §5.2):
 * `D_frames = 2 * max(1, roundHalfUp(frameFromUs(D) / 2))` — i.e. at least one
 * whole frame per side so `D/2` is an integer frame count.
 */
export function evenFramesNearest(us: MicroSec, fps: Rational): number {
  const frames = usToFrame(Math.max(0, Math.round(us)), fps);
  return 2 * Math.max(1, roundHalfUp(frames / 2));
}

/** Source-domain handle for one side of a cut: roundHalfUp((D/2) * rate). */
function transitionHandleUs(durationUs: MicroSec, rate: number): MicroSec {
  return roundHalfUp((durationUs / 2) * rate);
}

/**
 * The invariant's OWN handle check (invariants.ts checkTransitionEdge), byte
 * for byte. `a` is the outgoing clip, `b` the incoming one. An unknown asset
 * duration means "no tail constraint" — the same thing the invariant does, so
 * the editor never writes a document its own validator would reject and never
 * refuses one the validator would accept.
 */
function transitionHandleFits(
  durationUs: MicroSec,
  a: MediaClip,
  b: MediaClip,
  assetDurations: ReadonlyMap<string, MicroSec>,
): boolean {
  if (b.sourceInUs < transitionHandleUs(durationUs, b.speed.rate)) return false;
  const assetDurationA = assetDurations.get(a.assetId);
  return (
    assetDurationA === undefined ||
    a.sourceOutUs + transitionHandleUs(durationUs, a.speed.rate) <= assetDurationA
  );
}

export interface TransitionPlan {
  durationUs: MicroSec;
  frames: number;
  /** null = the request survived untouched; otherwise which cap cut it down. */
  limitedBy: 'handle' | 'length' | null;
}

/**
 * Effective transition duration for the cut `a|b` (rendering-semantics §5.2 +
 * §5.5), or null when the cut cannot carry one at all.
 *
 * PRODUCT DECISION (§5.5 gives the choice; this is the branch we took and we
 * take it EVERYWHERE — add, duration edit, and post-trim reconcile):
 * when the request does not fit we SHORTEN to the largest legal even-frame
 * duration and tell the user; only when even the 2-frame minimum does not fit
 * do we refuse. Rejecting instead would mean a user who trims a clip loses the
 * transition entirely for a one-frame shortage, and "add" would fail with a
 * number the user has no way to guess.
 *
 * Two caps, both from the normative doc:
 *  - length: `D * 2 <= min(A.timelineDurationUs, B.timelineDurationUs)`
 *  - handle: `D <= 2 * min(availA / rateA, availB / rateB)` where
 *    `availA = assetDurA - A.sourceOut` and `availB = B.sourceIn`
 * The analytic caps only NARROW the search; the returned duration is always
 * re-checked with the invariant's own predicate before it is handed back.
 */
export function planTransitionDuration(
  a: MediaClip,
  b: MediaClip,
  requestedUs: MicroSec,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): TransitionPlan | null {
  const lengthCapUs = Math.floor(Math.min(a.timelineDurationUs, b.timelineDurationUs) / 2);
  const assetDurationA = assetDurations.get(a.assetId);
  const availA =
    assetDurationA === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, assetDurationA - a.sourceOutUs);
  const handleCapUs = 2 * Math.min(availA / a.speed.rate, b.sourceInUs / b.speed.rate);

  const wantedFrames = evenFramesNearest(requestedUs, fps);
  const lengthFrames = evenFramesAtMost(lengthCapUs, fps);
  const handleFrames = evenFramesAtMost(Math.min(handleCapUs, lengthCapUs), fps);

  let frames = Math.min(wantedFrames, lengthFrames, handleFrames);
  // Analytic caps come from the same formulas but carry a rounding tail; step
  // down (2 frames = one whole frame per side) until the exact rules pass.
  for (let guard = 0; guard < 8 && frames >= 2; guard++) {
    const durationUs = frameToUs(frames, fps);
    if (
      durationUs * 2 <= Math.min(a.timelineDurationUs, b.timelineDurationUs) &&
      transitionHandleFits(durationUs, a, b, assetDurations)
    ) {
      const limitedBy =
        frames >= wantedFrames ? null : frames <= handleFrames && handleFrames < lengthFrames ? 'handle' : 'length';
      return { durationUs, frames, limitedBy };
    }
    frames -= 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transition reconciliation after edits
// ---------------------------------------------------------------------------

/** What reconcileTransitions had to do; `removed` counts CUTS, not edges. */
export interface TransitionReconcileReport {
  shortened: number;
  removed: number;
  /**
   * Which cap forced the (last) shortening. Carried so the bubble can name the
   * real cause — "kaynak payı" and "komşu klip süresi" send the user to two
   * DIFFERENT fixes, and guessing one of them is worse than saying nothing.
   */
  shortenedBy: 'handle' | 'length' | null;
}

const NO_TRANSITION_CHANGE: TransitionReconcileReport = {
  shortened: 0,
  removed: 0,
  shortenedBy: null,
};

/** Notice code for a report, or undefined when nothing changed. */
export function transitionReconcileNotice(
  report: TransitionReconcileReport,
): string | undefined {
  if (report.removed > 0) return TRANSITION_DROPPED;
  if (report.shortened === 0) return undefined;
  return report.shortenedBy === 'handle'
    ? TRANSITION_SHORTENED_HANDLE
    : TRANSITION_SHORTENED_LENGTH;
}

export function mergeTransitionReports(
  a: TransitionReconcileReport,
  b: TransitionReconcileReport,
): TransitionReconcileReport {
  return {
    shortened: a.shortened + b.shortened,
    removed: a.removed + b.removed,
    shortenedBy: b.shortenedBy ?? a.shortenedBy,
  };
}

/**
 * Transitions are metadata on a cut between two ADJACENT media clips and must
 * be symmetric (invariants rule 5). Any op that moves/trims/splits/deletes can
 * break adjacency, shrink a neighbour below `2*D` or eat the source handle —
 * after such an op this pass brings the track back onto the contract:
 *
 *  - cut still there, duration still legal  -> untouched
 *  - cut still there, duration too long     -> SHORTENED to the legal maximum
 *  - cut gone / no legal duration left      -> REMOVED from BOTH sides
 *
 * The returned report is what makes the repair visible: every caller turns it
 * into an OpResult notice and the timeline shows a bubble. Silent repair was
 * the old behaviour and it is exactly what a user reads as "it deleted my
 * transition for no reason".
 */
function reconcileTransitions(
  track: Track,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): TransitionReconcileReport {
  const report: TransitionReconcileReport = { shortened: 0, removed: 0, shortenedBy: null };
  const cs = track.clips;
  const keptOut = new Set<number>();
  const keptIn = new Set<number>();

  for (let i = 0; i + 1 < cs.length; i++) {
    const a = cs[i];
    const b = cs[i + 1];
    if (!isMediaClip(a) || !isMediaClip(b)) continue;
    if (clipEndUs(a) !== b.timelineStartUs) continue;
    // A one-sided leftover still describes the cut the user made; the outgoing
    // side wins when the two disagree (it is the side the UI writes first).
    const wanted: Transition | undefined = a.transitionOut ?? b.transitionIn;
    if (wanted === undefined) continue;

    const plan = planTransitionDuration(a, b, wanted.durationUs, fps, assetDurations);
    if (plan === null) {
      delete a.transitionOut;
      delete b.transitionIn;
      report.removed++;
      continue;
    }
    if (plan.durationUs !== wanted.durationUs) {
      report.shortened++;
      report.shortenedBy = plan.limitedBy ?? report.shortenedBy;
    }
    // Rewritten as two SEPARATE literals: sharing one object would make the two
    // sides alias each other in the draft and produce misleading undo patches.
    a.transitionOut = { type: wanted.type, durationUs: plan.durationUs };
    b.transitionIn = { type: wanted.type, durationUs: plan.durationUs };
    keptOut.add(i);
    keptIn.add(i + 1);
  }

  // Anything not claimed by a live cut above is stale metadata.
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!isMediaClip(c)) continue;
    if (c.transitionOut !== undefined && !keptOut.has(i)) {
      delete c.transitionOut;
      report.removed++;
      // The counterpart belongs to the SAME cut — drop it here so the loop
      // below does not count the same removal twice.
      const n = cs[i + 1];
      if (n !== undefined && isMediaClip(n) && !keptIn.has(i + 1)) delete n.transitionIn;
    }
    if (c.transitionIn !== undefined && !keptIn.has(i)) {
      delete c.transitionIn;
      report.removed++;
    }
  }
  return report;
}

/**
 * Re-fits a media clip's audio fades inside its CURRENT duration.
 *
 * The export compiler refuses `fadeInUs + fadeOutUs > timelineDurationUs`
 * (ExportCompiler.ValidateMediaClip, mirrored as invariant rule 8). Every op
 * that SHORTENS a clip therefore has to re-clamp fades it never touched —
 * otherwise a 10 s clip with a 5 s fade-in trimmed down to 2 s produces a
 * document the export rejects with HTTP 422, and the editor never says so.
 *
 * Policy when the two fades no longer fit together: shrink them
 * PROPORTIONALLY. Both sides are FLOORED at the same ratio, so the result is
 * symmetric for symmetric input and the sum can never exceed the duration
 * (floor(a·d/t) + floor(b·d/t) <= (a+b)·d/t = d). Proportional keeps the shape
 * the user built and, unlike "trim one side first", has no arbitrary winner.
 *
 * Call this next to EVERY write of `timelineDurationUs`. Operates on a DRAFT
 * clip (inside mutate/transaction) — store documents are frozen.
 */
export function clampAudioFadesToDuration(clip: Clip): void {
  if (!isMediaClip(clip) || clip.audio === null) return;
  const durationUs = Math.max(0, clip.timelineDurationUs);
  const audio = clip.audio;
  let fadeIn = Math.max(0, roundHalfUp(audio.fadeInUs));
  let fadeOut = Math.max(0, roundHalfUp(audio.fadeOutUs));
  const total = fadeIn + fadeOut;
  if (total > durationUs) {
    fadeIn = Math.floor((fadeIn * durationUs) / total);
    fadeOut = Math.floor((fadeOut * durationUs) / total);
  }
  audio.fadeInUs = fadeIn;
  audio.fadeOutUs = fadeOut;
}

/**
 * Left-edge trims shift clip content relative to the clip start; keyframes are
 * clip-start-relative, so they shift by (newDur - oldDur) and anything that
 * falls outside [0, newDur] is dropped. Right-edge trims: shift 0, clamp only.
 */
function remapKeyframes(clip: Clip, shiftUs: MicroSec, newDurationUs: MicroSec): void {
  const tracks = clip.keyframes;
  for (const key of Object.keys(tracks) as (keyof KeyframeTracks)[]) {
    const kfs = tracks[key];
    if (!kfs) continue;
    const mapped = kfs
      .map((k) => ({ ...k, timeUs: k.timeUs + shiftUs }))
      .filter((k) => k.timeUs >= 0 && k.timeUs <= newDurationUs);
    if (mapped.length > 0) tracks[key] = mapped;
    else delete tracks[key];
  }
}

// ---------------------------------------------------------------------------
// addTrack / track toggles
// ---------------------------------------------------------------------------

function makeTrack(type: TrackType, name?: string): Track {
  return { id: uuidv7(), type, name, muted: false, hidden: false, locked: false, clips: [] };
}

/** Appends a track at the end (bottom row = bottom-most render layer). */
export function addTrack(type: TrackType, name?: string): Uuid {
  const track = makeTrack(type, name);
  useDocStore.getState().mutate('addTrack', 'Track eklendi', (d) => {
    d.tracks.push(track);
  });
  assertDocValidDev('addTrack');
  return track.id;
}

function toggleTrackFlag(trackId: Uuid, flag: 'muted' | 'hidden' | 'locked', label: string): OpResult {
  const exists = doc().tracks.some((t) => t.id === trackId);
  if (!exists) return fail('track not found');
  useDocStore.getState().mutate('trackFlag', label, (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (t) t[flag] = !t[flag];
  });
  assertDocValidDev('toggleTrackFlag');
  return OK;
}

export const toggleTrackMuted = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'muted', 'Track sessize alındı/açıldı');
export const toggleTrackHidden = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'hidden', 'Track gizlendi/gösterildi');
export const toggleTrackLocked = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'locked', 'Track kilitlendi/açıldı');

/**
 * Why `trackId` cannot be deleted, or null when it can.
 *
 * Exported so the timeline context menu can grey the item out with EXACTLY the
 * rule deleteTrack enforces — a menu must never offer an action the op refuses.
 * The "last video track" guard is a UX invariant (an editor without a video
 * lane has nowhere to drop footage), not a schema one.
 */
export function trackDeleteBlockReason(d: TimelineDoc, trackId: Uuid): string | null {
  const track = d.tracks.find((t) => t.id === trackId);
  if (!track) return 'track not found';
  if (track.locked) return 'track is locked';
  if (track.type === 'video' && d.tracks.filter((t) => t.type === 'video').length <= 1) {
    return 'cannot delete the last video track';
  }
  return null;
}

/**
 * Deletes a track WITH the clips it contains (one undo entry). Refuses locked
 * tracks and the last video track (see trackDeleteBlockReason).
 */
export function deleteTrack(trackId: Uuid): OpResult {
  const d = doc();
  const blocked = trackDeleteBlockReason(d, trackId);
  if (blocked !== null) return fail(blocked);
  const track = d.tracks.find((t) => t.id === trackId);
  if (!track) return fail('track not found');

  const removedClipIds = new Set(track.clips.map((c) => c.id));
  const label =
    track.clips.length > 0 ? `Track silindi (${track.clips.length} klip)` : 'Track silindi';
  useDocStore.getState().mutate('deleteTrack', label, (dd) => {
    const i = dd.tracks.findIndex((t) => t.id === trackId);
    if (i >= 0) dd.tracks.splice(i, 1);
  });
  assertDocValidDev('deleteTrack');

  // Selection may not survive its clips.
  const editor = useEditorStore.getState();
  const next = [...editor.selection].filter((id) => !removedClipIds.has(id));
  if (next.length !== editor.selection.size) editor.setSelection(next);
  return OK;
}

// ---------------------------------------------------------------------------
// addClipFromAsset
// ---------------------------------------------------------------------------

function buildClipFromAsset(asset: AssetSummary, startUs: MicroSec): MediaClip | null {
  const sourceDurationUs = asset.kind === 'image' ? IMAGE_DEFAULT_DURATION_US : asset.durationUs;
  if (sourceDurationUs === undefined || sourceDurationUs <= 0) return null;
  return {
    id: uuidv7(),
    kind: asset.kind,
    assetId: asset.id,
    timelineStartUs: startUs,
    timelineDurationUs: clipTimelineDurationUs(0, sourceDurationUs, 1),
    sourceInUs: 0,
    sourceOutUs: sourceDurationUs,
    speed: { rate: 1 },
    audio:
      asset.kind === 'image' ? null : { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

export type AddClipTarget = { trackId: Uuid } | { newTrack: true };

export type AddClipResult =
  | { ok: true; clipId: Uuid; trackId: Uuid }
  | { ok: false; reason: string };

/**
 * Creates a MediaClip from a READY asset (sourceIn=0, sourceOut=duration,
 * speed 1, default audio) at the given time, snapped to the project fps grid.
 * Rejects overlaps and track-type mismatches; `newTrack` appends a fresh track.
 */
export function addClipFromAsset(
  assetId: Uuid,
  target: AddClipTarget,
  timelineStartUs: MicroSec,
): AddClipResult {
  const d = doc();
  const asset = useAssetStore.getState().getAsset(assetId);
  if (!asset) return { ok: false, reason: 'asset not found' };
  if (asset.status !== 'ready') return { ok: false, reason: 'asset is not ready' };

  const startUs = snapUsToFrameGrid(Math.max(0, Math.round(timelineStartUs)), d.settings.fps);
  const clip = buildClipFromAsset(asset, startUs);
  if (!clip) return { ok: false, reason: 'asset has no known duration' };

  const requiredType = trackTypeForClipKind(clip.kind);

  if ('trackId' in target) {
    const track = d.tracks.find((t) => t.id === target.trackId);
    if (!track) return { ok: false, reason: 'track not found' };
    if (track.locked) return { ok: false, reason: 'track is locked' };
    if (track.type !== requiredType) return { ok: false, reason: 'track type mismatch' };
    if (!fitsInTrack(track, clip.timelineStartUs, clip.timelineDurationUs)) {
      return { ok: false, reason: 'overlaps an existing clip' };
    }
    useDocStore.getState().mutate('addClip', `${asset.name} eklendi`, (dd) => {
      const t = dd.tracks.find((x) => x.id === target.trackId);
      if (t) insertClipSorted(t, clip);
    });
    assertDocValidDev('addClipFromAsset');
    useEditorStore.getState().setSelection([clip.id]);
    return { ok: true, clipId: clip.id, trackId: target.trackId };
  }

  const newTrack = makeTrack(requiredType);
  useDocStore.getState().mutate('addClip', `${asset.name} eklendi`, (dd) => {
    newTrack.clips.push(clip);
    dd.tracks.push(newTrack);
  });
  assertDocValidDev('addClipFromAsset(newTrack)');
  useEditorStore.getState().setSelection([clip.id]);
  return { ok: true, clipId: clip.id, trackId: newTrack.id };
}

// ---------------------------------------------------------------------------
// moveClips
// ---------------------------------------------------------------------------

export interface MovePlan {
  ok: true;
  moves: { clipId: Uuid; fromTrackIndex: number; toTrackIndex: number; newStartUs: MicroSec }[];
}

export type MovePlanResult = MovePlan | { ok: false; reason: string };

/**
 * Validates moving `clipIds` by a uniform microsecond delta (relative
 * positions preserved EXACTLY) and an optional vertical track shift.
 *
 * Frame-grid policy (same as every other op — docs/rendering-semantics §1):
 * the REFERENCE clip's target start (clipIds[0]; the drag code puts the
 * grabbed anchor first) is snapped to the project fps grid, and that snapped
 * delta is applied to the whole selection ONCE — relative offsets between the
 * moved clips are preserved exactly. Overlaps reject the whole move (MVP: no
 * auto-ripple, per design §3.3).
 */
export function planMoveClips(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  deltaUs: MicroSec,
  trackDelta = 0,
): MovePlanResult {
  if (clipIds.length === 0) return { ok: false, reason: 'nothing to move' };
  const moves: MovePlan['moves'] = [];
  const moving = new Set(clipIds);

  // Snap the delta once against the reference clip so the anchor's new start
  // sits on the frame grid (a raw pointer delta must never land off-grid).
  // Negative targets are NOT clamped here — they must still reject below.
  const ref = locateClip(d, clipIds[0]);
  if (!ref) return { ok: false, reason: 'clip not found' };
  const refTargetUs = Math.round(ref.clip.timelineStartUs + deltaUs);
  deltaUs =
    (refTargetUs < 0 ? refTargetUs : snapUsToFrameGrid(refTargetUs, d.settings.fps)) -
    ref.clip.timelineStartUs;

  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc) return { ok: false, reason: 'clip not found' };
    if (loc.track.locked) return { ok: false, reason: 'track is locked' };
    const toTrackIndex = loc.trackIndex + trackDelta;
    if (toTrackIndex < 0 || toTrackIndex >= d.tracks.length) {
      return { ok: false, reason: 'no track at target position' };
    }
    const toTrack = d.tracks[toTrackIndex];
    if (toTrack.locked) return { ok: false, reason: 'target track is locked' };
    if (toTrack.type !== loc.track.type) return { ok: false, reason: 'track type mismatch' };
    const newStartUs = loc.clip.timelineStartUs + deltaUs;
    if (newStartUs < 0) return { ok: false, reason: 'before timeline start' };
    moves.push({ clipId, fromTrackIndex: loc.trackIndex, toTrackIndex, newStartUs });
  }

  // Overlap check per destination track: stationary clips + incoming movers.
  const byTarget = new Map<number, MovePlan['moves']>();
  for (const m of moves) {
    const list = byTarget.get(m.toTrackIndex) ?? [];
    list.push(m);
    byTarget.set(m.toTrackIndex, list);
  }
  for (const [trackIndex, incoming] of byTarget) {
    const track = d.tracks[trackIndex];
    const intervals: { start: MicroSec; end: MicroSec }[] = [];
    for (const c of track.clips) {
      if (moving.has(c.id)) continue;
      intervals.push({ start: c.timelineStartUs, end: clipEndUs(c) });
    }
    for (const m of incoming) {
      const clip = locateClip(d, m.clipId)!.clip;
      intervals.push({ start: m.newStartUs, end: m.newStartUs + clip.timelineDurationUs });
    }
    intervals.sort((a, b) => a.start - b.start);
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i - 1].end > intervals[i].start) {
        return { ok: false, reason: 'overlaps an existing clip' };
      }
    }
  }
  return { ok: true, moves };
}

export function moveClips(clipIds: readonly Uuid[], deltaUs: MicroSec, trackDelta = 0): OpResult {
  if (deltaUs === 0 && trackDelta === 0) return OK;
  const d0 = doc();
  const plan = planMoveClips(d0, clipIds, deltaUs, trackDelta);
  if (!plan.ok) return plan;
  // The grid snap may collapse the delta to zero — never pollute history then.
  const noop = plan.moves.every((m) => {
    const loc = locateClip(d0, m.clipId);
    return (
      loc !== null &&
      m.fromTrackIndex === m.toTrackIndex &&
      m.newStartUs === loc.clip.timelineStartUs
    );
  });
  if (noop) return OK;

  const label = clipIds.length === 1 ? 'Klip taşındı' : `${clipIds.length} klip taşındı`;
  const durations = knownAssetDurations();
  let report = NO_TRANSITION_CHANGE;
  useDocStore.getState().mutate('move', label, (dd) => {
    const moving = new Set(clipIds);
    const extracted = new Map<Uuid, Clip>();
    const touched = new Set<number>();
    for (let ti = 0; ti < dd.tracks.length; ti++) {
      const t = dd.tracks[ti];
      const remaining: Clip[] = [];
      for (const c of t.clips) {
        if (moving.has(c.id)) {
          extracted.set(c.id, c);
          touched.add(ti);
        } else {
          remaining.push(c);
        }
      }
      t.clips = remaining;
    }
    for (const m of plan.moves) {
      const clip = extracted.get(m.clipId);
      if (!clip) continue;
      clip.timelineStartUs = m.newStartUs;
      insertClipSorted(dd.tracks[m.toTrackIndex], clip);
      touched.add(m.toTrackIndex);
    }
    for (const ti of touched) {
      report = mergeTransitionReports(
        report,
        reconcileTransitions(dd.tracks[ti], dd.settings.fps, durations),
      );
    }
  });
  assertDocValidDev('moveClips');
  return okWith(transitionReconcileNotice(report));
}

// ---------------------------------------------------------------------------
// trimClip (normal / ripple / roll)
// ---------------------------------------------------------------------------

export type TrimEdge = 'left' | 'right';
export type TrimMode = 'normal' | 'ripple' | 'roll';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Right-edge trim of a media clip toward `targetEndUs` (already clamped by
 * the caller into a feasible window). Mutates the clip so the duration
 * invariant holds EXACTLY: sourceOut is derived first, then
 * timelineDurationUs = round((out-in)/rate). Returns the actual new end.
 */
function trimMediaRight(
  clip: MediaClip,
  targetEndUs: MicroSec,
  maxEndUs: MicroSec,
  minDurUs: MicroSec,
  assetDurationUs: MicroSec | undefined,
): MicroSec {
  const start = clip.timelineStartUs;
  const rate = clip.speed.rate;
  let newOut = clip.sourceInUs + roundHalfUp((targetEndUs - start) * rate);
  if (assetDurationUs !== undefined) newOut = Math.min(newOut, assetDurationUs);
  newOut = Math.max(newOut, clip.sourceInUs + 1);
  let newDur = clipTimelineDurationUs(clip.sourceInUs, newOut, rate);
  // Rounding can overshoot the timeline cap by ~1 us; walk back.
  for (let guard = 0; guard < 32 && start + newDur > maxEndUs && newOut > clip.sourceInUs + 1; guard++) {
    newOut -= 1;
    newDur = clipTimelineDurationUs(clip.sourceInUs, newOut, rate);
  }
  // Rounding can undershoot the minimum duration; walk forward.
  const sourceCap = assetDurationUs ?? Number.MAX_SAFE_INTEGER;
  for (let guard = 0; guard < 32 && newDur < minDurUs && newOut < sourceCap; guard++) {
    newOut += 1;
    newDur = clipTimelineDurationUs(clip.sourceInUs, newOut, rate);
  }
  clip.sourceOutUs = newOut;
  clip.timelineDurationUs = newDur;
  remapKeyframes(clip, 0, newDur);
  clampAudioFadesToDuration(clip);
  return start + newDur;
}

/**
 * Left-edge trim of a media clip. `anchor === 'end'` keeps the clip end fixed
 * (normal trim); `anchor === 'start'` keeps the start fixed (ripple trim —
 * followers are shifted by the caller using the returned duration delta).
 */
function trimMediaLeft(
  clip: MediaClip,
  targetStartUs: MicroSec,
  minStartUs: MicroSec,
  minDurUs: MicroSec,
  anchor: 'end' | 'start',
): { newStartUs: MicroSec; durationDeltaUs: MicroSec } {
  const oldStart = clip.timelineStartUs;
  const oldDur = clip.timelineDurationUs;
  const end = oldStart + oldDur;
  const rate = clip.speed.rate;

  let newIn = clip.sourceInUs + roundHalfUp((targetStartUs - oldStart) * rate);
  newIn = clamp(newIn, 0, clip.sourceOutUs - 1);
  let newDur = clipTimelineDurationUs(newIn, clip.sourceOutUs, rate);
  if (anchor === 'end') {
    for (let guard = 0; guard < 32 && end - newDur < minStartUs && newIn < clip.sourceOutUs - 1; guard++) {
      newIn += 1;
      newDur = clipTimelineDurationUs(newIn, clip.sourceOutUs, rate);
    }
  }
  for (let guard = 0; guard < 32 && newDur < minDurUs && newIn > 0; guard++) {
    newIn -= 1;
    newDur = clipTimelineDurationUs(newIn, clip.sourceOutUs, rate);
  }

  clip.sourceInUs = newIn;
  clip.timelineDurationUs = newDur;
  if (anchor === 'end') clip.timelineStartUs = end - newDur;
  remapKeyframes(clip, newDur - oldDur, newDur);
  clampAudioFadesToDuration(clip);
  return { newStartUs: clip.timelineStartUs, durationDeltaUs: newDur - oldDur };
}

/**
 * Applies a trim to the draft document. Absolute `targetEdgeUs` semantics make
 * this safe to call repeatedly during a drag (each call recomputes from the
 * current clip state). Snaps the edge to the project fps grid.
 */
export function applyTrimToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  edge: TrimEdge,
  targetEdgeUs: MicroSec,
  mode: TrimMode,
  assetDurations: ReadonlyMap<string, MicroSec>,
): OpResult {
  const loc = locateClip(d, clipId);
  if (!loc) return fail('clip not found');
  if (loc.track.locked) return fail('track is locked');
  const fps = d.settings.fps;
  const minDur = minClipDurationUs(fps);
  const { track, clip, clipIndex } = loc;
  const prev = clipIndex > 0 ? track.clips[clipIndex - 1] : undefined;
  const next = clipIndex + 1 < track.clips.length ? track.clips[clipIndex + 1] : undefined;
  let target = snapUsToFrameGrid(Math.max(0, Math.round(targetEdgeUs)), fps);

  // Roll requires an adjacent media neighbor on the trimmed edge; degrade to
  // normal when there is none (design §3.3: roll only at a shared cut).
  let effectiveMode = mode;
  if (mode === 'roll') {
    const neighbor = edge === 'right' ? next : prev;
    const adjacent =
      neighbor !== undefined &&
      isMediaClip(neighbor) &&
      isMediaClip(clip) &&
      (edge === 'right'
        ? clipEndUs(clip) === neighbor.timelineStartUs
        : clipEndUs(neighbor) === clip.timelineStartUs);
    if (!adjacent) effectiveMode = 'normal';
  }

  if (effectiveMode === 'roll') {
    // Normalize to "roll the cut after clip A": A = clip (right edge) or prev (left edge).
    const aIndex = edge === 'right' ? clipIndex : clipIndex - 1;
    const a = track.clips[aIndex] as MediaClip;
    const b = track.clips[aIndex + 1] as MediaClip;
    const aStart = a.timelineStartUs;
    const bEnd = clipEndUs(b);
    const aAssetDur = assetDurations.get(a.assetId);
    const aMaxEnd =
      aAssetDur !== undefined
        ? aStart + clipTimelineDurationUs(a.sourceInUs, aAssetDur, a.speed.rate)
        : Number.MAX_SAFE_INTEGER;
    const bMinStart = bEnd - clipTimelineDurationUs(0, b.sourceOutUs, b.speed.rate);
    const lo = Math.max(aStart + minDur, bMinStart);
    const hi = Math.min(bEnd - minDur, aMaxEnd);
    if (lo > hi) return fail('no room to roll');
    target = clamp(target, lo, hi);

    const newCut = trimMediaRight(a, target, hi, minDur, aAssetDur);
    trimMediaLeft(b, newCut, newCut, minDur, 'end');
    // Rounding may leave B starting 1 us before A's end — push B's in-point.
    for (let guard = 0; guard < 32 && b.timelineStartUs < newCut && b.sourceInUs < b.sourceOutUs - 1; guard++) {
      b.sourceInUs += 1;
      b.timelineDurationUs = clipTimelineDurationUs(b.sourceInUs, b.sourceOutUs, b.speed.rate);
      b.timelineStartUs = bEnd - b.timelineDurationUs;
    }
    // The rounding walk above shortened B again after trimMediaLeft clamped it.
    clampAudioFadesToDuration(b);
    if (b.timelineStartUs < clipEndUs(a)) return fail('roll rounding failed');
    return okWith(
      transitionReconcileNotice(reconcileTransitions(track, fps, assetDurations)),
    );
  }

  if (edge === 'right') {
    const start = clip.timelineStartUs;
    const minEnd = start + minDur;
    let maxEnd = Number.MAX_SAFE_INTEGER;
    if (isMediaClip(clip)) {
      const assetDur = assetDurations.get(clip.assetId);
      if (assetDur !== undefined) {
        maxEnd = start + clipTimelineDurationUs(clip.sourceInUs, assetDur, clip.speed.rate);
      }
    }
    if (effectiveMode === 'normal' && next) maxEnd = Math.min(maxEnd, next.timelineStartUs);
    if (maxEnd < minEnd) return fail('no room to trim');
    target = clamp(target, minEnd, maxEnd);

    const oldEnd = clipEndUs(clip);
    let newEnd: MicroSec;
    if (isMediaClip(clip)) {
      newEnd = trimMediaRight(clip, target, maxEnd, minDur, assetDurations.get(clip.assetId));
    } else {
      clip.timelineDurationUs = target - start;
      remapKeyframes(clip, 0, clip.timelineDurationUs);
      clampAudioFadesToDuration(clip);
      newEnd = target;
    }
    if (effectiveMode === 'ripple') {
      const delta = newEnd - oldEnd;
      for (let i = clipIndex + 1; i < track.clips.length; i++) {
        track.clips[i].timelineStartUs += delta;
      }
    }
    return okWith(
      transitionReconcileNotice(reconcileTransitions(track, fps, assetDurations)),
    );
  }

  // edge === 'left'
  const end = clipEndUs(clip);
  const maxStart = end - minDur;
  let minStart = effectiveMode === 'normal' && prev ? clipEndUs(prev) : 0;
  if (isMediaClip(clip)) {
    minStart = Math.max(
      minStart,
      end - clipTimelineDurationUs(0, clip.sourceOutUs, clip.speed.rate),
    );
  }
  if (minStart > maxStart) return fail('no room to trim');
  target = clamp(target, minStart, maxStart);

  if (isMediaClip(clip)) {
    if (effectiveMode === 'ripple') {
      const { durationDeltaUs } = trimMediaLeft(clip, target, 0, minDur, 'start');
      for (let i = clipIndex + 1; i < track.clips.length; i++) {
        track.clips[i].timelineStartUs += durationDeltaUs;
      }
    } else {
      trimMediaLeft(clip, target, minStart, minDur, 'end');
    }
  } else {
    const oldDur = clip.timelineDurationUs;
    if (effectiveMode === 'ripple') {
      const newDur = end - target;
      clip.timelineDurationUs = newDur;
      remapKeyframes(clip, newDur - oldDur, newDur);
      clampAudioFadesToDuration(clip);
      for (let i = clipIndex + 1; i < track.clips.length; i++) {
        track.clips[i].timelineStartUs += newDur - oldDur;
      }
    } else {
      clip.timelineStartUs = target;
      clip.timelineDurationUs = end - target;
      remapKeyframes(clip, clip.timelineDurationUs - oldDur, clip.timelineDurationUs);
      clampAudioFadesToDuration(clip);
    }
  }
  return okWith(transitionReconcileNotice(reconcileTransitions(track, fps, assetDurations)));
}

/** Single-step trim op (Q/W shortcuts, tests). Drags use applyTrimToDraft in a transaction. */
export function trimClip(
  clipId: Uuid,
  edge: TrimEdge,
  targetEdgeUs: MicroSec,
  mode: TrimMode = 'normal',
): OpResult {
  const durations = knownAssetDurations();
  let result: OpResult = fail('unchanged');
  useDocStore.getState().mutate('trim', 'Klip kırpıldı', (d) => {
    result = applyTrimToDraft(d, clipId, edge, targetEdgeUs, mode, durations);
  });
  assertDocValidDev('trimClip');
  return result;
}

// ---------------------------------------------------------------------------
// splitClipAt
// ---------------------------------------------------------------------------

interface KeyframeSplit {
  a: Keyframe[];
  b: Keyframe[];
}

/**
 * Divide a keyframe list at `cutUs` (clip-relative). Keyframes before the cut
 * stay in A, after go to B (rebased); the interpolated boundary value is
 * written to BOTH parts so neither side visually jumps (design §3.3 rule).
 */
export function splitKeyframes(
  kfs: readonly Keyframe[],
  cutUs: MicroSec,
  durationBUs: MicroSec,
): KeyframeSplit {
  const before = kfs.filter((k) => k.timeUs < cutUs);
  const at = kfs.find((k) => k.timeUs === cutUs);
  const after = kfs.filter((k) => k.timeUs > cutUs);
  const boundaryValue = at ? at.value : sampleKeyframes(kfs, cutUs);
  const boundaryEasing = at
    ? at.easing
    : before.length > 0
      ? before[before.length - 1].easing
      : ({ type: 'linear' } as const);
  const a: Keyframe[] = [
    ...before.map((k) => ({ ...k })),
    { timeUs: cutUs, value: boundaryValue, easing: { type: 'linear' } },
  ];
  const b: Keyframe[] = [
    { timeUs: 0, value: boundaryValue, easing: boundaryEasing },
    ...after
      .map((k) => ({ ...k, timeUs: k.timeUs - cutUs }))
      .filter((k) => k.timeUs <= durationBUs),
  ];
  return { a, b };
}

/**
 * Splits a clip at an absolute timeline time (snapped to the fps grid).
 * Media clips get exact source continuity (B.sourceIn === A.sourceOut);
 * keyframes are divided per the schema rule via splitKeyframes.
 */
export function applySplitToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  timeUs: MicroSec,
  assetDurations: ReadonlyMap<string, MicroSec> = knownAssetDurations(),
): OpResult {
  const loc = locateClip(d, clipId);
  if (!loc) return fail('clip not found');
  if (loc.track.locked) return fail('track is locked');
  const fps = d.settings.fps;
  const { track, clip, clipIndex } = loc;
  const start = clip.timelineStartUs;
  const end = clipEndUs(clip);
  const t = snapUsToFrameGrid(Math.max(0, Math.round(timeUs)), fps);
  if (t <= start || t >= end) return fail('split point outside clip');

  const next = clipIndex + 1 < track.clips.length ? track.clips[clipIndex + 1] : undefined;
  let durA: MicroSec;
  let durB: MicroSec;
  let second: Clip;

  if (isMediaClip(clip)) {
    const rate = clip.speed.rate;
    let outA = clip.sourceInUs + roundHalfUp((t - start) * rate);
    outA = clamp(outA, clip.sourceInUs + 1, clip.sourceOutUs - 1);
    durA = clipTimelineDurationUs(clip.sourceInUs, outA, rate);
    for (let guard = 0; guard < 32 && durA >= end - start && outA > clip.sourceInUs + 1; guard++) {
      outA -= 1;
      durA = clipTimelineDurationUs(clip.sourceInUs, outA, rate);
    }
    if (durA < 1 || durA >= end - start) return fail('split too close to clip edge');

    let inB = outA;
    durB = clipTimelineDurationUs(inB, clip.sourceOutUs, rate);
    const startB = start + durA;
    // Duration rounding may make A+B exceed the original span by 1 us; if that
    // would overlap the next clip, drop a source microsecond from B's head.
    const maxEndB = next ? next.timelineStartUs : Number.MAX_SAFE_INTEGER;
    for (let guard = 0; guard < 32 && startB + durB > Math.min(end, maxEndB) && inB < clip.sourceOutUs - 1; guard++) {
      inB += 1;
      durB = clipTimelineDurationUs(inB, clip.sourceOutUs, rate);
    }
    if (durB < 1 || startB + durB > maxEndB) return fail('split rounding failed');

    const b: MediaClip = {
      ...clip,
      id: uuidv7(),
      timelineStartUs: startB,
      timelineDurationUs: durB,
      sourceInUs: inB,
      sourceOutUs: clip.sourceOutUs,
      keyframes: {},
      effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
      audio: clip.audio ? { ...clip.audio, fadeInUs: 0 } : null,
      transform: { ...clip.transform },
    };
    delete b.transitionIn;
    if (clip.transitionOut) b.transitionOut = { ...clip.transitionOut };

    clip.sourceOutUs = outA;
    clip.timelineDurationUs = durA;
    if (clip.audio) clip.audio.fadeOutUs = 0;
    delete clip.transitionOut;
    // A keeps its fade-in, B keeps its fade-out — but each half is SHORTER than
    // the original, so the surviving fade has to be re-fitted (rule 8).
    clampAudioFadesToDuration(clip);
    clampAudioFadesToDuration(b);
    second = b;
  } else {
    durA = t - start;
    durB = end - t;
    if (durA < 1 || durB < 1) return fail('split too close to clip edge');
    second = {
      ...clip,
      id: uuidv7(),
      timelineStartUs: t,
      timelineDurationUs: durB,
      keyframes: {},
      effects: clip.effects.map((e) => ({ ...e, params: { ...e.params } })),
      transform: { ...clip.transform },
    } as Clip;
    clip.timelineDurationUs = durA;
    clampAudioFadesToDuration(clip);
    clampAudioFadesToDuration(second);
  }

  // Divide keyframe tracks (boundary value interpolated into both parts).
  const originalKfs = clip.keyframes;
  const aKfs: KeyframeTracks = {};
  const bKfs: KeyframeTracks = {};
  for (const key of Object.keys(originalKfs) as (keyof KeyframeTracks)[]) {
    const kfs = originalKfs[key];
    if (!kfs || kfs.length === 0) continue;
    const { a, b } = splitKeyframes(kfs, durA, durB);
    aKfs[key] = a.filter((k) => k.timeUs <= durA);
    bKfs[key] = b;
  }
  clip.keyframes = aKfs;
  second.keyframes = bKfs;

  track.clips.splice(clipIndex + 1, 0, second);
  // Split must not BREAK the outer cuts: A keeps its transitionIn, B inherits
  // the transitionOut (both moved above), and the reconcile pass only shortens
  // them if a half is now too short to host the old duration.
  const report = reconcileTransitions(track, fps, assetDurations);

  // UX nicety: keep the selection covering both halves.
  const selection = useEditorStore.getState().selection;
  if (selection.has(clipId)) useEditorStore.getState().addToSelection(second.id);
  return okWith(transitionReconcileNotice(report));
}

export function splitClipAt(clipId: Uuid, timeUs: MicroSec): OpResult {
  let result: OpResult = fail('unchanged');
  const durations = knownAssetDurations();
  useDocStore.getState().mutate('split', 'Klip bölündü', (d) => {
    result = applySplitToDraft(d, clipId, timeUs, durations);
  });
  assertDocValidDev('splitClipAt');
  return result;
}

/** Clips whose [start, end) strictly contains `timeUs`, skipping locked tracks. */
export function clipsAtTime(d: TimelineDoc, timeUs: MicroSec): Uuid[] {
  const ids: Uuid[] = [];
  for (const track of d.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      if (clip.timelineStartUs < timeUs && timeUs < clipEndUs(clip)) ids.push(clip.id);
    }
  }
  return ids;
}

/**
 * Clips a playhead-relative op (split / trim-to-playhead) would act on:
 * the clips under `timeUs`, narrowed to the selection when there is one.
 * Single definition shared by the ops and their block-reason helpers.
 */
function playheadTargets(
  d: TimelineDoc,
  timeUs: MicroSec,
  selection: ReadonlySet<Uuid>,
): Uuid[] {
  const under = clipsAtTime(d, snapUsToFrameGrid(timeUs, d.settings.fps));
  return selection.size > 0 ? under.filter((id) => selection.has(id)) : under;
}

/**
 * Why splitting at `timeUs` is impossible, or null.
 *
 * `timeUs` is a parameter (not a live playhead read) so the context menu can
 * reason about the playhead FROZEN at menu-open time — the same instant the
 * action will use. NOTE: this covers the op's precondition ("no clip under
 * playhead"); a per-clip edge case inside applySplitToDraft can still fail and
 * the op reports it — the menu never claims more than the op guarantees.
 */
export function splitBlockReason(
  d: TimelineDoc,
  timeUs: MicroSec,
  selection: ReadonlySet<Uuid>,
): string | null {
  return playheadTargets(d, timeUs, selection).length === 0 ? 'no clip under playhead' : null;
}

/** Same rule for Q/W (trimSelectedToPlayhead) — identical precondition. */
export function trimToPlayheadBlockReason(
  d: TimelineDoc,
  timeUs: MicroSec,
  selection: ReadonlySet<Uuid>,
): string | null {
  return playheadTargets(d, timeUs, selection).length === 0 ? 'no clip under playhead' : null;
}

/**
 * C shortcut: split the selected clips under the playhead, or — when nothing
 * is selected — every clip under the playhead (unlocked tracks). One undo entry.
 *
 * `timeUs` overrides the live playhead: the context menu passes the value it
 * FROZE when it opened, so the cut lands where the user saw the playhead, not
 * where an arrow key moved it while the menu was up.
 */
export function splitAtPlayhead(timeUs?: MicroSec): OpResult {
  const d = doc();
  const t = timeUs ?? useEditorStore.getState().playheadUs;
  const selection = useEditorStore.getState().selection;
  const targets = playheadTargets(d, t, selection);
  if (targets.length === 0) return fail('no clip under playhead');

  const tx = useDocStore.getState().beginTransaction('split', targets.length === 1 ? 'Klip bölündü' : `${targets.length} klip bölündü`);
  let any = false;
  for (const id of targets) {
    tx.update((dd) => {
      const r = applySplitToDraft(dd, id, t);
      if (r.ok) any = true;
    });
  }
  tx.commit();
  assertDocValidDev('splitAtPlayhead');
  return any ? OK : fail('split failed');
}

/**
 * Q/W shortcuts: trim the start (Q) or end (W) of clips under the playhead to
 * the playhead. `timeUs` overrides the live playhead (frozen menu value).
 */
export function trimSelectedToPlayhead(edge: TrimEdge, timeUs?: MicroSec): OpResult {
  const d = doc();
  const t = timeUs ?? useEditorStore.getState().playheadUs;
  const selection = useEditorStore.getState().selection;
  const targets = playheadTargets(d, t, selection);
  if (targets.length === 0) return fail('no clip under playhead');

  const durations = knownAssetDurations();
  const tx = useDocStore.getState().beginTransaction('trim', 'Playhead\'e kırpıldı');
  let any = false;
  for (const id of targets) {
    tx.update((dd) => {
      const r = applyTrimToDraft(dd, id, edge, t, 'normal', durations);
      if (r.ok) any = true;
    });
  }
  tx.commit();
  assertDocValidDev('trimSelectedToPlayhead');
  return any ? OK : fail('trim failed');
}

// ---------------------------------------------------------------------------
// deleteClips (+ ripple)
// ---------------------------------------------------------------------------

/** Clips of `clipIds` that exist in `d` and sit on an unlocked track. */
function deletableClipIds(d: TimelineDoc, clipIds: readonly Uuid[]): Uuid[] {
  return clipIds.filter((id) => {
    const loc = locateClip(d, id);
    return loc !== null && !loc.track.locked;
  });
}

/**
 * Why `clipIds` cannot be deleted, or null.
 *
 * Same contract as trackDeleteBlockReason/detachAudioBlockReason: the context
 * menu greys the item out with EXACTLY the rule deleteClips enforces.
 */
export function deleteBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  return deletableClipIds(d, clipIds).length === 0 ? 'nothing to delete' : null;
}

export function deleteClips(clipIds: readonly Uuid[], opts: { ripple?: boolean } = {}): OpResult {
  const d = doc();
  const deletable = deletableClipIds(d, clipIds);
  if (deletable.length === 0) return fail('nothing to delete');
  const removing = new Set(deletable);
  const ripple = opts.ripple === true;

  const label = `${deletable.length} klip silindi${ripple ? ' (ripple)' : ''}`;
  const durations = knownAssetDurations();
  let report = NO_TRANSITION_CHANGE;
  useDocStore.getState().mutate('delete', label, (dd) => {
    for (const track of dd.tracks) {
      const removed = track.clips.filter((c) => removing.has(c.id));
      if (removed.length === 0) continue;
      const removedSpans = removed.map((c) => ({
        start: c.timelineStartUs,
        end: clipEndUs(c),
        dur: c.timelineDurationUs,
      }));
      track.clips = track.clips.filter((c) => !removing.has(c.id));
      if (ripple) {
        // Shift computed against ORIGINAL positions: a clip moves left by the
        // total duration of removed clips that ended at-or-before its start.
        for (const c of track.clips) {
          let shift = 0;
          for (const span of removedSpans) {
            if (span.end <= c.timelineStartUs) shift += span.dur;
          }
          c.timelineStartUs -= shift;
        }
      }
      report = mergeTransitionReports(
        report,
        reconcileTransitions(track, dd.settings.fps, durations),
      );
    }
  });
  assertDocValidDev('deleteClips');

  const editor = useEditorStore.getState();
  const nextSelection = [...editor.selection].filter((id) => !removing.has(id));
  editor.setSelection(nextSelection);
  return okWith(transitionReconcileNotice(report));
}

// ---------------------------------------------------------------------------
// Transition ops (add / remove / retype / retime)
// ---------------------------------------------------------------------------

/** The two media clips that meet at a cut, plus where they live. */
export interface TransitionCut {
  track: Track;
  trackIndex: number;
  /** Index of the OUTGOING clip in track.clips (the cut is between it and +1). */
  aIndex: number;
  /** Outgoing clip (before the cut). */
  a: MediaClip;
  /** Incoming clip (after the cut). */
  b: MediaClip;
}

/**
 * The cut `(clipId, edge)` points at, or null when there is none: a transition
 * only ever exists between two media clips that TOUCH (rendering-semantics
 * §5.1 — no gap, no overlap, no text/shape clip involved).
 */
export function findTransitionCut(
  d: TimelineDoc,
  clipId: Uuid,
  edge: TransitionEdge,
): TransitionCut | null {
  const loc = locateClip(d, clipId);
  if (!loc) return null;
  const aIndex = edge === 'out' ? loc.clipIndex : loc.clipIndex - 1;
  if (aIndex < 0) return null;
  const a = loc.track.clips[aIndex];
  const b = loc.track.clips[aIndex + 1];
  if (a === undefined || b === undefined) return null;
  if (!isMediaClip(a) || !isMediaClip(b)) return null;
  if (clipEndUs(a) !== b.timelineStartUs) return null;
  return { track: loc.track, trackIndex: loc.trackIndex, aIndex, a, b };
}

/** The transition living on a cut (either side; they are kept deep-equal). */
export function transitionAt(cut: TransitionCut): Transition | undefined {
  return cut.a.transitionOut ?? cut.b.transitionIn;
}

/** Both edges of `clipId` that are real cuts, in `in`-then-`out` order. */
export function transitionEdgesOf(d: TimelineDoc, clipId: Uuid): TransitionEdge[] {
  return (['in', 'out'] as const).filter((edge) => findTransitionCut(d, clipId, edge) !== null);
}

/**
 * Why a transition cannot be ADDED at `(clipId, edge)`, or null when it can.
 *
 * Same contract as the other `*BlockReason` helpers: the context menu greys the
 * item out with EXACTLY the rule the op enforces, so the menu never offers an
 * action that then fails with a bubble.
 */
export function addTransitionBlockReason(
  d: TimelineDoc,
  clipId: Uuid,
  edge: TransitionEdge,
  assetDurations: ReadonlyMap<string, MicroSec> = knownAssetDurations(),
  requestedUs: MicroSec = DEFAULT_TRANSITION_DURATION_US,
): string | null {
  const loc = locateClip(d, clipId);
  if (!loc) return 'clip not found';
  if (loc.track.locked) return 'track is locked';
  const cut = findTransitionCut(d, clipId, edge);
  if (!cut) return 'no adjacent clip at this cut';
  if (transitionAt(cut) !== undefined) return 'a transition is already here';
  if (planTransitionDuration(cut.a, cut.b, requestedUs, d.settings.fps, assetDurations) === null) {
    return 'no room for a transition';
  }
  return null;
}

/** Why a transition cannot be REMOVED at `(clipId, edge)`, or null. */
export function removeTransitionBlockReason(
  d: TimelineDoc,
  clipId: Uuid,
  edge: TransitionEdge,
): string | null {
  const loc = locateClip(d, clipId);
  if (!loc) return 'clip not found';
  if (loc.track.locked) return 'track is locked';
  const cut = findTransitionCut(d, clipId, edge);
  if (!cut || transitionAt(cut) === undefined) return 'no transition at this cut';
  return null;
}

/** Notice code for a plan whose duration came out below the request. */
function planNotice(plan: TransitionPlan): string | undefined {
  if (plan.limitedBy === 'handle') return TRANSITION_SHORTENED_HANDLE;
  if (plan.limitedBy === 'length') return TRANSITION_SHORTENED_LENGTH;
  return undefined;
}

/**
 * Writes a transition onto a cut, on BOTH sides (symmetry invariant, §5.2).
 * Runs inside a draft recipe; the caller owns the history entry.
 */
function writeTransition(cut: TransitionCut, type: TransitionType, durationUs: MicroSec): void {
  cut.a.transitionOut = { type, durationUs };
  cut.b.transitionIn = { type, durationUs };
}

/**
 * Adds a transition on the cut between two ADJACENT clips.
 *
 * `clipAId` is the outgoing clip, `clipBId` the incoming one; they must sit on
 * the same track, in that order, touching. The stored duration is the
 * even-frame snap of the request, shortened when the neighbours or the source
 * handles cannot carry it (see planTransitionDuration for the branch we took);
 * the shortening is reported through `notice`, never silently.
 */
export function addTransition(
  clipAId: Uuid,
  clipBId: Uuid,
  type: TransitionType,
  durationUs: MicroSec = DEFAULT_TRANSITION_DURATION_US,
): OpResult {
  const d0 = doc();
  const cut = findTransitionCut(d0, clipAId, 'out');
  if (!cut) return fail('no adjacent clip at this cut');
  if (cut.b.id !== clipBId) return fail('clips are not adjacent');
  const blocked = addTransitionBlockReason(d0, clipAId, 'out', knownAssetDurations(), durationUs);
  if (blocked !== null) return fail(blocked);

  const durations = knownAssetDurations();
  let result: OpResult = fail('no room for a transition');
  useDocStore.getState().mutate('transition', 'Geçiş eklendi', (dd) => {
    const target = findTransitionCut(dd, clipAId, 'out');
    if (!target) return;
    const plan = planTransitionDuration(target.a, target.b, durationUs, dd.settings.fps, durations);
    if (plan === null) return;
    writeTransition(target, type, plan.durationUs);
    result = okWith(planNotice(plan));
  });
  assertDocValidDev('addTransition');
  return result;
}

/** Edge-addressed wrapper used by the timeline UI (badge + context menu). */
export function addTransitionAtEdge(
  clipId: Uuid,
  edge: TransitionEdge,
  type: TransitionType,
  durationUs: MicroSec = DEFAULT_TRANSITION_DURATION_US,
): OpResult {
  const cut = findTransitionCut(doc(), clipId, edge);
  if (!cut) return fail('no adjacent clip at this cut');
  return addTransition(cut.a.id, cut.b.id, type, durationUs);
}

/** Removes the transition on `(clipId, edge)` from BOTH sides of the cut. */
export function removeTransition(clipId: Uuid, edge: TransitionEdge): OpResult {
  const d0 = doc();
  const blocked = removeTransitionBlockReason(d0, clipId, edge);
  if (blocked !== null) return fail(blocked);
  let result: OpResult = fail('no transition at this cut');
  useDocStore.getState().mutate('transition', 'Geçiş kaldırıldı', (dd) => {
    const cut = findTransitionCut(dd, clipId, edge);
    if (!cut) return;
    delete cut.a.transitionOut;
    delete cut.b.transitionIn;
    result = OK;
  });
  assertDocValidDev('removeTransition');
  return result;
}

/** Changes the transition TYPE on a cut, keeping its duration. */
export function setTransitionType(
  clipId: Uuid,
  edge: TransitionEdge,
  type: TransitionType,
): OpResult {
  const d0 = doc();
  const blocked = removeTransitionBlockReason(d0, clipId, edge);
  if (blocked !== null) return fail(blocked);
  let result: OpResult = fail('no transition at this cut');
  useDocStore.getState().mutate('transition', 'Geçiş türü değiştirildi', (dd) => {
    const cut = findTransitionCut(dd, clipId, edge);
    const existing = cut ? transitionAt(cut) : undefined;
    if (!cut || existing === undefined) return;
    writeTransition(cut, type, existing.durationUs);
    result = OK;
  });
  assertDocValidDev('setTransitionType');
  return result;
}

/**
 * Changes the transition DURATION on a cut. The value is snapped to an even
 * frame count and clamped by the same caps as `addTransition`; a clamp is
 * reported through `notice`.
 */
export function setTransitionDuration(
  clipId: Uuid,
  edge: TransitionEdge,
  durationUs: MicroSec,
): OpResult {
  const d0 = doc();
  const blocked = removeTransitionBlockReason(d0, clipId, edge);
  if (blocked !== null) return fail(blocked);
  const durations = knownAssetDurations();
  let result: OpResult = fail('no room for a transition');
  useDocStore.getState().mutate('transition', 'Geçiş süresi değiştirildi', (dd) => {
    const cut = findTransitionCut(dd, clipId, edge);
    const existing = cut ? transitionAt(cut) : undefined;
    if (!cut || existing === undefined) return;
    const plan = planTransitionDuration(cut.a, cut.b, durationUs, dd.settings.fps, durations);
    if (plan === null) {
      // Cannot happen through the UI (a live transition proves 2 frames fit),
      // but a 0/negative request must not silently delete the transition.
      return;
    }
    writeTransition(cut, existing.type, plan.durationUs);
    result = okWith(planNotice(plan));
  });
  assertDocValidDev('setTransitionDuration');
  return result;
}

// ---------------------------------------------------------------------------
// Clipboard: copy / cut / paste / duplicate
// ---------------------------------------------------------------------------

interface ClipboardEntry {
  clip: Clip;
  trackId: Uuid;
  /** Offset from the earliest copied clip start. */
  offsetUs: MicroSec;
}

let clipboard: ClipboardEntry[] | null = null;

/** Test hook / paranoia: reset module clipboard. */
export function clearClipboardForTests(): void {
  clipboard = null;
}

/** True when there is something to paste (context menu disabled state). */
export function hasClipboardContent(): boolean {
  return clipboard !== null && clipboard.length > 0;
}

function cloneClip(clip: Clip): Clip {
  const copy = JSON.parse(JSON.stringify(clip)) as Clip;
  if (isMediaClip(copy)) {
    // Transitions are cut metadata — they never survive copy/paste.
    delete copy.transitionIn;
    delete copy.transitionOut;
  }
  return copy;
}

/** Why `clipIds` cannot be copied, or null (copyClips finds nothing to copy). */
export function copyBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  return clipIds.some((id) => locateClip(d, id) !== null) ? null : 'nothing to copy';
}

/** Cut = copy THEN delete: blocked when either half is (cutClips' own order). */
export function cutBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  return copyBlockReason(d, clipIds) ?? deleteBlockReason(d, clipIds);
}

export function copyClips(clipIds: readonly Uuid[]): boolean {
  const d = doc();
  const entries: ClipboardEntry[] = [];
  let minStart = Number.MAX_SAFE_INTEGER;
  for (const id of clipIds) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    minStart = Math.min(minStart, loc.clip.timelineStartUs);
    entries.push({ clip: cloneClip(loc.clip), trackId: loc.track.id, offsetUs: 0 });
  }
  if (entries.length === 0) return false;
  for (const e of entries) e.offsetUs = e.clip.timelineStartUs - minStart;
  clipboard = entries;
  return true;
}

export function cutClips(clipIds: readonly Uuid[]): OpResult {
  if (!copyClips(clipIds)) return fail('nothing to cut');
  return deleteClips(clipIds);
}

/**
 * Where a batch insert wants to put one clip. Only the fields the placement
 * rules need — so the check can run on a MENU RENDER without cloning clips.
 */
interface ClipPlacement {
  trackId: Uuid;
  kind: Clip['kind'];
  startUs: MicroSec;
  durationUs: MicroSec;
}

/**
 * Why a batch of placements cannot be inserted into `d`, or null.
 *
 * This is the ONLY definition of "does this paste/duplicate fit": insertBatch
 * runs it before mutating, and pasteBlockReason/duplicateBlockReason (hence the
 * context menu) run the SAME function. A menu item and its op can no longer
 * disagree about whether an action is possible.
 */
function placementBlockReason(d: TimelineDoc, placements: readonly ClipPlacement[]): string | null {
  const perTrack = new Map<Uuid, { start: MicroSec; end: MicroSec }[]>();
  for (const p of placements) {
    const track = d.tracks.find((t) => t.id === p.trackId);
    if (!track) return 'target track no longer exists';
    if (track.locked) return 'target track is locked';
    if (track.type !== trackTypeForClipKind(p.kind)) return 'track type mismatch';
    if (p.startUs < 0) return 'before timeline start';
    if (!fitsInTrack(track, p.startUs, p.durationUs)) return 'overlaps an existing clip';
    const list = perTrack.get(p.trackId) ?? [];
    const end = p.startUs + p.durationUs;
    for (const other of list) {
      if (p.startUs < other.end && other.start < end) return 'pasted clips overlap each other';
    }
    list.push({ start: p.startUs, end });
    perTrack.set(p.trackId, list);
  }
  return null;
}

function toPlacements(batch: readonly { clip: Clip; trackId: Uuid }[]): ClipPlacement[] {
  return batch.map(({ clip, trackId }) => ({
    trackId,
    kind: clip.kind,
    startUs: clip.timelineStartUs,
    durationUs: clip.timelineDurationUs,
  }));
}

/**
 * Inserts a batch of prepared clips (already positioned, fresh ids assumed by
 * the caller) atomically: every clip must fit or the whole paste is rejected.
 */
function insertBatch(
  actionType: string,
  label: string,
  batch: { clip: Clip; trackId: Uuid }[],
): OpResult {
  const d = doc();
  const blocked = placementBlockReason(d, toPlacements(batch));
  if (blocked !== null) return fail(blocked);

  useDocStore.getState().mutate(actionType, label, (dd) => {
    for (const { clip, trackId } of batch) {
      const track = dd.tracks.find((t) => t.id === trackId);
      if (track) insertClipSorted(track, clip);
    }
  });
  assertDocValidDev(actionType);
  useEditorStore.getState().setSelection(batch.map((b) => b.clip.id));
  return OK;
}

/** Where the clipboard would land if pasted at `timeUs` (pure). */
function pastePlacements(d: TimelineDoc, timeUs: MicroSec): ClipPlacement[] | null {
  if (!clipboard || clipboard.length === 0) return null;
  const base = snapUsToFrameGrid(timeUs, d.settings.fps);
  return clipboard.map((e) => ({
    trackId: e.trackId,
    kind: e.clip.kind,
    startUs: base + e.offsetUs,
    durationUs: e.clip.timelineDurationUs,
  }));
}

/**
 * Why the clipboard cannot be pasted at `timeUs`, or null.
 *
 * `timeUs` is a PARAMETER, not a read of the live playhead: the context menu
 * freezes the playhead at open time and must reason about that exact instant
 * (see runTimelineMenuAction). Reads the module clipboard, which is genuinely
 * outside the document.
 */
export function pasteBlockReason(d: TimelineDoc, timeUs: MicroSec): string | null {
  const placements = pastePlacements(d, timeUs);
  if (placements === null) return 'clipboard empty';
  return placementBlockReason(d, placements);
}

/** Ctrl+V: paste the clipboard at the playhead (original tracks, offsets kept). */
export function pasteAtPlayhead(timeUs?: MicroSec): OpResult {
  if (!clipboard || clipboard.length === 0) return fail('clipboard empty');
  const d = doc();
  const at = timeUs ?? useEditorStore.getState().playheadUs;
  const base = snapUsToFrameGrid(at, d.settings.fps);
  const batch = clipboard.map((e) => {
    const clip = cloneClip(e.clip);
    clip.id = uuidv7();
    clip.timelineStartUs = base + e.offsetUs;
    return { clip, trackId: e.trackId };
  });
  return insertBatch('paste', `${batch.length} klip yapıştırıldı`, batch);
}

/** Where duplicates of `clipIds` would land (pure) — null when there is nothing to duplicate. */
function duplicatePlacements(d: TimelineDoc, clipIds: readonly Uuid[]): ClipPlacement[] | null {
  let minStart = Number.MAX_SAFE_INTEGER;
  let maxEnd = 0;
  const sources: { clip: Clip; trackId: Uuid }[] = [];
  for (const id of clipIds) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    minStart = Math.min(minStart, loc.clip.timelineStartUs);
    maxEnd = Math.max(maxEnd, clipEndUs(loc.clip));
    sources.push({ clip: loc.clip, trackId: loc.track.id });
  }
  if (sources.length === 0) return null;
  const span = maxEnd - minStart;
  return sources.map((s) => ({
    trackId: s.trackId,
    kind: s.clip.kind,
    startUs: s.clip.timelineStartUs + span,
    durationUs: s.clip.timelineDurationUs,
  }));
}

/**
 * Why `clipIds` cannot be duplicated, or null.
 *
 * This closes the "menu offers what the op refuses" hole: a clip whose
 * neighbour sits immediately after it has NO room for its duplicate, so the
 * menu greys "Çoğalt" out instead of showing a warning bubble on click.
 */
export function duplicateBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  const placements = duplicatePlacements(d, clipIds);
  if (placements === null) return 'nothing to duplicate';
  return placementBlockReason(d, placements);
}

/** Ctrl+D: duplicate the selection right after its own span, same tracks. */
export function duplicateClips(clipIds: readonly Uuid[]): OpResult {
  const d = doc();
  let minStart = Number.MAX_SAFE_INTEGER;
  let maxEnd = 0;
  const sources: { clip: Clip; trackId: Uuid }[] = [];
  for (const id of clipIds) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    minStart = Math.min(minStart, loc.clip.timelineStartUs);
    maxEnd = Math.max(maxEnd, clipEndUs(loc.clip));
    sources.push({ clip: loc.clip, trackId: loc.track.id });
  }
  if (sources.length === 0) return fail('nothing to duplicate');
  const span = maxEnd - minStart;
  const batch = sources.map((s) => {
    const clip = cloneClip(s.clip);
    clip.id = uuidv7();
    clip.timelineStartUs = s.clip.timelineStartUs + span;
    return { clip, trackId: s.trackId };
  });
  return insertBatch('duplicate', `${batch.length} klip çoğaltıldı`, batch);
}

// ---------------------------------------------------------------------------
// Clip properties (Inspector): audio / transform / opacity
//
// Every setter takes a clip id LIST: the inspector edits the whole selection at
// once and one call must stay ONE history entry. The `apply*ToDraft` halves are
// exported for slider/scrub gestures — the panel runs them inside a docStore
// transaction so a drag coalesces into a single undo step, exactly like the
// timeline's trim/move drags.
//
// Clamping happens HERE, never in the UI: a numeric input, a slider and a
// keyboard arrow must all land on the same value, and the document must stay
// schema-valid whatever the panel sends (rendering-semantics §2 for the
// normalized transform, §8 for linear gain / linear fades).
// ---------------------------------------------------------------------------

/** Linear gain bounds (rendering-semantics §8.1: 0..2, 1 = untouched, 2 = +6.02 dB). */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 2;
/** Normalized position bound: |x|,|y| <= 2 compositions away (a slip cannot lose a clip). */
export const POSITION_LIMIT = 2;
/**
 * scale = 1 means "fit" (rendering-semantics §2.2).
 *
 * The floor is POSITIVE and shared with the preview gizmo
 * (timeline-schema.TRANSFORM_SCALE_MIN): the export compiler rejects
 * `transform.scale <= 0` outright, so an editor that let a user park a clip at
 * 0 was building documents that could never be exported.
 */
export const SCALE_MIN = TRANSFORM_SCALE_MIN;

/**
 * Resolution-independent sanity cap. The EFFECTIVE ceiling is always
 * `maxClipScale(settings)` — see there; this only stops absurd values in
 * compositions small enough that the layer-size bound is loose.
 */
export const SCALE_MAX = 10;

/**
 * Largest scale THIS project may store: the compiler measures the scaled layer
 * box against LayerGeometry.MaxLayerDimension (8192 px), so the real ceiling
 * falls out of the project resolution — ~4.266 at 1080p, ~2.133 at 4K.
 * The inspector's field max AND the clamp both go through here.
 */
export function maxClipScale(settings: Pick<ProjectSettings, 'width' | 'height'>): number {
  return Math.min(SCALE_MAX, maxScaleFor(settings));
}

export const ROTATION_LIMIT = 360;

/** Transform/opacity values are stored rounded so undo patches stay clean. */
export const POSITION_DECIMALS = 4;
export const SCALE_DECIMALS = TRANSFORM_SCALE_DECIMALS;
export const ROTATION_DECIMALS = 2;
export const OPACITY_DECIMALS = 3;

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return roundHalfUp(value * f) / f;
}

function clampFinite(value: number, lo: number, hi: number, decimals: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return roundTo(clamp(value, lo, hi), decimals);
}

/** Default transform (rendering-semantics §2: centered, fit, unrotated). */
export const DEFAULT_TRANSFORM = {
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
} as const;

/** Audio properties live on video/audio clips; image clips carry `audio: null`. */
export function clipHasAudio(clip: Clip): clip is MediaClip {
  return isMediaClip(clip) && clip.audio !== null;
}

/** Everything except an audio clip is drawn, so everything else has a transform. */
export function isVisualClip(clip: Clip): boolean {
  return clip.kind !== 'audio';
}

export interface ClipAudioPatch {
  volume?: number;
  fadeInUs?: MicroSec;
  fadeOutUs?: MicroSec;
  muted?: boolean;
}

/**
 * Fade clamp: a fade can never exceed the clip, and in+out can never overlap
 * (an overlap would make the §8.2 linear ramps contradict each other). Only the
 * field being written is trimmed — the untouched side is never "helpfully"
 * changed behind the user's back.
 */
function clampFadeUs(valueUs: MicroSec, durationUs: MicroSec, otherFadeUs: MicroSec): MicroSec {
  if (typeof valueUs !== 'number' || !Number.isFinite(valueUs)) return 0;
  const room = Math.max(0, durationUs - Math.max(0, otherFadeUs));
  return clamp(roundHalfUp(valueUs), 0, room);
}

/**
 * Applies an audio patch to every selected clip that HAS audio. Clips on locked
 * tracks, image clips and clips whose audio was detached are skipped silently
 * (the inspector only offers the section when at least one clip qualifies).
 */
export function applyClipAudioToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ClipAudioPatch,
): OpResult {
  let touched = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    const clip = loc.clip;
    if (!clipHasAudio(clip) || clip.audio === null) continue;
    const audio = clip.audio;
    if (patch.volume !== undefined) {
      const v = clampFinite(patch.volume, VOLUME_MIN, VOLUME_MAX, 4);
      if (v !== null) audio.volume = v;
    }
    if (patch.muted !== undefined) audio.muted = patch.muted === true;
    if (patch.fadeInUs !== undefined) {
      audio.fadeInUs = clampFadeUs(patch.fadeInUs, clip.timelineDurationUs, audio.fadeOutUs);
    }
    if (patch.fadeOutUs !== undefined) {
      audio.fadeOutUs = clampFadeUs(patch.fadeOutUs, clip.timelineDurationUs, audio.fadeInUs);
    }
    touched++;
  }
  return touched > 0 ? OK : fail('no audio clip in selection');
}

function audioLabel(patch: ClipAudioPatch): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return 'Ses ayarları değiştirildi';
  if (patch.volume !== undefined) return 'Ses seviyesi değiştirildi';
  if (patch.fadeInUs !== undefined) return 'Ses açılması (fade in) değiştirildi';
  if (patch.fadeOutUs !== undefined) return 'Ses kapanması (fade out) değiştirildi';
  return patch.muted === true ? 'Klip sessize alındı' : 'Klip sesi açıldı';
}

export function setClipAudio(clipIds: readonly Uuid[], patch: ClipAudioPatch): OpResult {
  let result: OpResult = fail('no audio clip in selection');
  useDocStore.getState().mutate('clipAudio', audioLabel(patch), (d) => {
    result = applyClipAudioToDraft(d, clipIds, patch);
  });
  assertDocValidDev('setClipAudio');
  return result;
}

export interface ClipTransformPatch {
  x?: number;
  y?: number;
  scale?: number;
  rotationDeg?: number;
}

export function applyClipTransformToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ClipTransformPatch,
): OpResult {
  let touched = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    const clip = loc.clip;
    if (!isVisualClip(clip)) continue;
    const t = clip.transform;
    if (patch.x !== undefined) {
      const v = clampFinite(patch.x, -POSITION_LIMIT, POSITION_LIMIT, POSITION_DECIMALS);
      if (v !== null) t.x = v;
    }
    if (patch.y !== undefined) {
      const v = clampFinite(patch.y, -POSITION_LIMIT, POSITION_LIMIT, POSITION_DECIMALS);
      if (v !== null) t.y = v;
    }
    if (patch.scale !== undefined) {
      // Ceiling is per-project (layer box <= 8192 px), not a constant.
      const v = clampFinite(patch.scale, SCALE_MIN, maxClipScale(d.settings), SCALE_DECIMALS);
      if (v !== null) t.scale = v;
    }
    if (patch.rotationDeg !== undefined) {
      const v = clampFinite(patch.rotationDeg, -ROTATION_LIMIT, ROTATION_LIMIT, ROTATION_DECIMALS);
      if (v !== null) t.rotationDeg = v;
    }
    touched++;
  }
  return touched > 0 ? OK : fail('no visual clip in selection');
}

function transformLabel(patch: ClipTransformPatch): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return 'Dönüşüm değiştirildi';
  if (patch.scale !== undefined) return 'Ölçek değiştirildi';
  if (patch.rotationDeg !== undefined) return 'Döndürme değiştirildi';
  return 'Konum değiştirildi';
}

export function setClipTransform(
  clipIds: readonly Uuid[],
  patch: ClipTransformPatch,
): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipTransform', transformLabel(patch), (d) => {
    result = applyClipTransformToDraft(d, clipIds, patch);
  });
  assertDocValidDev('setClipTransform');
  return result;
}

export function applyClipOpacityToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  opacity: number,
): OpResult {
  const value = clampFinite(opacity, 0, 1, OPACITY_DECIMALS);
  if (value === null) return fail('invalid opacity');
  let touched = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    if (!isVisualClip(loc.clip)) continue;
    loc.clip.opacity = value;
    touched++;
  }
  return touched > 0 ? OK : fail('no visual clip in selection');
}

export function setClipOpacity(clipIds: readonly Uuid[], opacity: number): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipOpacity', 'Opaklık değiştirildi', (d) => {
    result = applyClipOpacityToDraft(d, clipIds, opacity);
  });
  assertDocValidDev('setClipOpacity');
  return result;
}

/** "Sıfırla": transform + opacity back to their defaults, ONE history entry. */
export function resetClipTransform(clipIds: readonly Uuid[]): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipTransform', 'Dönüşüm sıfırlandı', (d) => {
    let touched = 0;
    for (const clipId of clipIds) {
      const loc = locateClip(d, clipId);
      if (!loc || loc.track.locked) continue;
      if (!isVisualClip(loc.clip)) continue;
      loc.clip.transform = { ...DEFAULT_TRANSFORM };
      loc.clip.opacity = 1;
      touched++;
    }
    result = touched > 0 ? OK : fail('no visual clip in selection');
  });
  assertDocValidDev('resetClipTransform');
  return result;
}

// ---------------------------------------------------------------------------
// detachAudio
// ---------------------------------------------------------------------------

/**
 * Where the detached audio would land, or the reason it cannot land anywhere.
 *
 * With no audio track in the document at all, one is created (`null` target).
 * When audio tracks exist but none is both unlocked and free at that range the
 * op REFUSES rather than silently spawning tracks.
 */
function detachAudioTarget(
  d: TimelineDoc,
  source: MediaClip,
): { track: Track | null } | { reason: string } {
  const audioTracks = d.tracks.filter((t) => t.type === 'audio');
  if (audioTracks.length === 0) return { track: null };
  const target = audioTracks.find(
    (t) => !t.locked && fitsInTrack(t, source.timelineStartUs, source.timelineDurationUs),
  );
  if (target) return { track: target };
  return {
    reason: audioTracks.every((t) => t.locked)
      ? 'target track is locked'
      : 'overlaps an existing clip',
  };
}

/**
 * Why `clipId`'s audio cannot be detached, or null when it can.
 *
 * Exported so the timeline context menu greys "Sesi ayır" out with EXACTLY the
 * rule detachAudio enforces (same contract as trackDeleteBlockReason). This
 * covers the FULL refusal set — clip preconditions AND the placement conflict
 * ("no unlocked audio track with room"). It used to stop at the clip
 * preconditions, so the menu happily offered an action the op then rejected
 * with a warning bubble; a menu must never offer what the op refuses.
 */
export function detachAudioBlockReason(d: TimelineDoc, clipId: Uuid): string | null {
  const loc = locateClip(d, clipId);
  if (!loc) return 'clip not found';
  if (loc.track.locked) return 'track is locked';
  const clip = loc.clip;
  if (!isMediaClip(clip) || clip.kind !== 'video') return 'only a video clip has detachable audio';
  if (clip.audio === null) return 'clip has no embedded audio';
  const target = detachAudioTarget(d, clip);
  return 'reason' in target ? target.reason : null;
}

/**
 * Splits a video clip's embedded audio into its own audio clip.
 *
 * The video clip keeps its picture and loses `audio` (plus its volume keyframe
 * track, which follows the sound). The new audio clip is an EXACT audio twin:
 * same assetId / sourceIn / sourceOut / speed / timeline range, so the export
 * compiler renders bit-identical sound (source continuity is what makes the
 * §8.4 seamless-splice rule keep working).
 *
 * Placement: the first UNLOCKED audio track with room at that range. With no
 * audio track in the document at all one is created. When audio tracks exist
 * but none has room the op REFUSES (reason -> warning bubble) instead of
 * silently spawning tracks — the user's remedy is the timeline's "+ Ses" button
 * or moving the blocking clip.
 *
 * One `mutate` = one undo entry for the whole thing.
 */
export function detachAudio(clipId: Uuid): OpResult {
  const d = doc();
  const blocked = detachAudioBlockReason(d, clipId);
  if (blocked !== null) return fail(blocked);
  const source = locateClip(d, clipId)!.clip as MediaClip;
  const audioSettings = source.audio!;
  const startUs = source.timelineStartUs;
  const durationUs = source.timelineDurationUs;

  // Same resolution the block reason used — it already proved a target exists.
  const placement = detachAudioTarget(d, source);
  if ('reason' in placement) return fail(placement.reason);
  const target = placement.track;

  const volumeKeyframes = source.keyframes.volume;
  const audioClip: MediaClip = {
    id: uuidv7(),
    kind: 'audio',
    assetId: source.assetId,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: source.sourceInUs,
    sourceOutUs: source.sourceOutUs,
    speed: { ...source.speed },
    audio: { ...audioSettings },
    transform: { ...DEFAULT_TRANSFORM },
    keyframes:
      volumeKeyframes && volumeKeyframes.length > 0
        ? { volume: JSON.parse(JSON.stringify(volumeKeyframes)) as Keyframe[] }
        : {},
    effects: [],
    opacity: 1,
  };
  const newTrack = target ? null : makeTrack('audio', 'Ses');

  useDocStore.getState().mutate('detachAudio', 'Ses ayrıldı', (dd) => {
    const loc = locateClip(dd, clipId);
    if (!loc || !isMediaClip(loc.clip)) return;
    loc.clip.audio = null;
    delete loc.clip.keyframes.volume;
    if (newTrack !== null) {
      newTrack.clips.push(audioClip);
      dd.tracks.push(newTrack);
      return;
    }
    const t = dd.tracks.find((x) => x.id === target!.id);
    if (t) insertClipSorted(t, audioClip);
  });
  assertDocValidDev('detachAudio');
  return OK;
}

// ---------------------------------------------------------------------------
// Markers / misc queries
// ---------------------------------------------------------------------------

/** M shortcut / ruler menu. `atUs` overrides the live playhead (frozen value). */
export function addMarkerAtPlayhead(atUs?: MicroSec): void {
  const d = doc();
  const raw = atUs ?? useEditorStore.getState().playheadUs;
  const timeUs = snapUsToFrameGrid(raw, d.settings.fps);
  useDocStore.getState().mutate('marker', 'Marker eklendi', (dd) => {
    dd.markers.push({ id: uuidv7(), timeUs });
  });
  assertDocValidDev('addMarkerAtPlayhead');
}

/** All clip starts/ends, sorted unique — ↑/↓ cut-point navigation. */
export function collectCutPoints(d: TimelineDoc): MicroSec[] {
  const set = new Set<MicroSec>([0]);
  for (const track of d.tracks) {
    for (const clip of track.clips) {
      set.add(clip.timelineStartUs);
      set.add(clipEndUs(clip));
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Timeline content end (max clip end), 0 for an empty document. */
export function projectEndUs(d: TimelineDoc): MicroSec {
  let end = 0;
  for (const track of d.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEndUs(clip));
  }
  return end;
}

export function selectAllClips(): void {
  const ids: Uuid[] = [];
  for (const track of doc().tracks) for (const clip of track.clips) ids.push(clip.id);
  useEditorStore.getState().setSelection(ids);
}

// ---------------------------------------------------------------------------
// Overlay clips: text / shape / sticker (M4 wave 2)
//
// Same contract as addClipFromAsset: the op decides NOTHING about style (the
// caller passes a fully-built, schema-shaped style object — defaults live in
// features/text/overlayDefaults.ts) and everything about placement legality:
// frame-grid snap, overlay-track type, locked tracks, overlap refusal, the
// dev-mode invariant assert and the selection update all happen here.
//
// Placement POLICY ("which overlay track, and what if there is none") lives in
// features/text/overlayActions.ts, exactly like features/library/addToTimeline
// does for media assets.
// ---------------------------------------------------------------------------

/** Fallback length of a new overlay clip when the caller does not say. */
export const OVERLAY_CLIP_DEFAULT_DURATION_US = 5_000_000;

/** Track name used when an overlay clip has to create its own lane. */
export const OVERLAY_TRACK_NAME = 'Katman';

type OverlayClipBase = Pick<
  Clip,
  'id' | 'timelineStartUs' | 'timelineDurationUs' | 'transform' | 'keyframes' | 'effects' | 'opacity'
>;

function overlayClipBase(startUs: MicroSec, durationUs: MicroSec): OverlayClipBase {
  return {
    id: uuidv7(),
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    transform: { ...DEFAULT_TRANSFORM },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

/**
 * Shared insert path for every overlay kind. Duration is snapped to the project
 * frame grid and floored at one frame (a sub-frame overlay would be invisible
 * in the export, which is exactly the kind of silent no-op the review gate
 * exists to prevent).
 */
function insertOverlayClip(
  build: (startUs: MicroSec, durationUs: MicroSec) => Clip,
  target: AddClipTarget,
  timelineStartUs: MicroSec,
  requestedDurationUs: MicroSec,
  label: string,
): AddClipResult {
  const d = doc();
  const fps = d.settings.fps;
  const startUs = snapUsToFrameGrid(Math.max(0, Math.round(timelineStartUs)), fps);
  const minDur = minClipDurationUs(fps);
  const durationUs = Math.max(
    minDur,
    snapUsToFrameGrid(Math.max(minDur, Math.round(requestedDurationUs)), fps),
  );
  const clip = build(startUs, durationUs);

  if ('trackId' in target) {
    const track = d.tracks.find((t) => t.id === target.trackId);
    if (!track) return { ok: false, reason: 'track not found' };
    if (track.locked) return { ok: false, reason: 'track is locked' };
    if (track.type !== 'overlay') return { ok: false, reason: 'track type mismatch' };
    if (!fitsInTrack(track, startUs, durationUs)) {
      return { ok: false, reason: 'overlaps an existing clip' };
    }
    useDocStore.getState().mutate('addOverlayClip', label, (dd) => {
      const t = dd.tracks.find((x) => x.id === target.trackId);
      if (t) insertClipSorted(t, clip);
    });
    assertDocValidDev('insertOverlayClip');
    useEditorStore.getState().setSelection([clip.id]);
    return { ok: true, clipId: clip.id, trackId: target.trackId };
  }

  const newTrack = makeTrack('overlay', OVERLAY_TRACK_NAME);
  useDocStore.getState().mutate('addOverlayClip', label, (dd) => {
    newTrack.clips.push(clip);
    // TOP of the stack, not the bottom. tracks[0] is the top layer (schema
    // contract, resolveVisualStack draws the array back-to-front), and an
    // overlay appended like a media track would be drawn BEHIND the footage —
    // the user would add a caption and see nothing, which is indistinguishable
    // from "text does not work".
    dd.tracks.unshift(newTrack);
  });
  assertDocValidDev('insertOverlayClip(newTrack)');
  useEditorStore.getState().setSelection([clip.id]);
  return { ok: true, clipId: clip.id, trackId: newTrack.id };
}

export function addTextClip(
  text: TextClip['text'],
  target: AddClipTarget,
  timelineStartUs: MicroSec,
  durationUs: MicroSec = OVERLAY_CLIP_DEFAULT_DURATION_US,
): AddClipResult {
  return insertOverlayClip(
    (startUs, dur) =>
      ({
        ...overlayClipBase(startUs, dur),
        kind: 'text',
        text: { ...text, stroke: text.stroke ? { ...text.stroke } : undefined, background: text.background ? { ...text.background } : undefined },
      }) as TextClip,
    target,
    timelineStartUs,
    durationUs,
    'Metin eklendi',
  );
}

/**
 * `initialScale` exists because a shape's NATURAL box is the whole frame
 * (features/text/overlayGeometry + backend ShapeGeometry.cs): at `scale = 1` a
 * new rectangle would cover the entire picture. The product default is passed
 * in rather than baked here — the op stays free of product decisions, exactly
 * like it takes the style as data.
 */
export function addShapeClip(
  shape: ShapeClip['shape'],
  target: AddClipTarget,
  timelineStartUs: MicroSec,
  durationUs: MicroSec = OVERLAY_CLIP_DEFAULT_DURATION_US,
  initialScale = 1,
): AddClipResult {
  const scale = clampFinite(initialScale, SCALE_MIN, SCALE_MAX, SCALE_DECIMALS) ?? 1;
  return insertOverlayClip(
    (startUs, dur) => {
      const base = overlayClipBase(startUs, dur);
      return {
        ...base,
        transform: { ...base.transform, scale },
        kind: 'shape',
        shape: { ...shape, stroke: shape.stroke ? { ...shape.stroke } : undefined },
      } as ShapeClip;
    },
    target,
    timelineStartUs,
    durationUs,
    'Şekil eklendi',
  );
}

/**
 * Sticker = a READY image asset placed on an overlay track (schema:
 * StickerClip carries only an assetId — no source range, so its length is a
 * free product decision like an image clip's).
 */
export function addStickerClip(
  assetId: Uuid,
  target: AddClipTarget,
  timelineStartUs: MicroSec,
  durationUs: MicroSec = OVERLAY_CLIP_DEFAULT_DURATION_US,
): AddClipResult {
  const asset = useAssetStore.getState().getAsset(assetId);
  if (!asset) return { ok: false, reason: 'asset not found' };
  if (asset.status !== 'ready') return { ok: false, reason: 'asset is not ready' };
  if (asset.kind !== 'image') return { ok: false, reason: 'only an image asset can be a sticker' };
  return insertOverlayClip(
    (startUs, dur) =>
      ({
        ...overlayClipBase(startUs, dur),
        kind: 'sticker',
        assetId,
      }) as StickerClip,
    target,
    timelineStartUs,
    durationUs,
    `${asset.name} çıkartma olarak eklendi`,
  );
}

// ---------------------------------------------------------------------------
// Overlay clip properties (Inspector): text style / shape style
//
// Same rules as the transform/audio setters above: clamping lives HERE so a
// slider, a typed number and a keyboard arrow cannot disagree, and every write
// keeps the document schema-valid (colors are hex, sizes are positive, weights
// are integers in [1..1000]).
// ---------------------------------------------------------------------------

export const TEXT_SIZE_MIN = 4;
export const TEXT_SIZE_MAX = 2000;
export const TEXT_LINE_HEIGHT_MIN = 0.5;
export const TEXT_LINE_HEIGHT_MAX = 4;
export const TEXT_WEIGHT_MIN = 100;
export const TEXT_WEIGHT_MAX = 1000;
export const TEXT_STROKE_WIDTH_MAX = 200;
export const TEXT_BACKGROUND_PADDING_MAX = 500;
export const SHAPE_RADIUS_MAX = 1000;
export const SHAPE_STROKE_WIDTH_MAX = 500;
/** Guard against pathological documents (and pathological rasters). */
export const TEXT_CONTENT_MAX_LENGTH = 5000;

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A valid hex color, or null when the input is not one (write is skipped). */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed : null;
}

export interface ClipTextPatch {
  content?: string;
  fontId?: string;
  fontSizePx?: number;
  fontWeight?: number;
  italic?: boolean;
  fill?: string;
  align?: TextClip['text']['align'];
  lineHeight?: number;
  /** Stroke/background are optional schema objects: the toggle adds/removes them. */
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidthPx?: number;
  backgroundEnabled?: boolean;
  backgroundColor?: string;
  backgroundPaddingPx?: number;
  backgroundRadiusPx?: number;
}

const DEFAULT_TEXT_STROKE = { color: '#000000', widthPx: 4 };
const DEFAULT_TEXT_BACKGROUND = { color: '#000000', paddingPx: 16, radiusPx: 8 };

export function applyClipTextToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ClipTextPatch,
): OpResult {
  let touched = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    const clip = loc.clip;
    if (clip.kind !== 'text') continue;
    const text = clip.text;

    if (patch.content !== undefined && typeof patch.content === 'string') {
      text.content = patch.content.slice(0, TEXT_CONTENT_MAX_LENGTH);
    }
    if (patch.fontId !== undefined && typeof patch.fontId === 'string' && patch.fontId.length > 0) {
      text.fontId = patch.fontId;
    }
    if (patch.fontSizePx !== undefined) {
      const v = clampFinite(patch.fontSizePx, TEXT_SIZE_MIN, TEXT_SIZE_MAX, 1);
      if (v !== null) text.fontSizePx = v;
    }
    if (patch.fontWeight !== undefined) {
      const v = clampFinite(patch.fontWeight, TEXT_WEIGHT_MIN, TEXT_WEIGHT_MAX, 0);
      if (v !== null) text.fontWeight = Math.round(v);
    }
    if (patch.italic !== undefined) text.italic = patch.italic === true;
    if (patch.fill !== undefined) {
      const color = normalizeHexColor(patch.fill);
      if (color !== null) text.fill = color;
    }
    if (patch.align !== undefined && ['left', 'center', 'right'].includes(patch.align)) {
      text.align = patch.align;
    }
    if (patch.lineHeight !== undefined) {
      const v = clampFinite(patch.lineHeight, TEXT_LINE_HEIGHT_MIN, TEXT_LINE_HEIGHT_MAX, 2);
      if (v !== null) text.lineHeight = v;
    }

    if (patch.strokeEnabled !== undefined) {
      text.stroke = patch.strokeEnabled ? (text.stroke ?? { ...DEFAULT_TEXT_STROKE }) : undefined;
    }
    if (text.stroke) {
      if (patch.strokeColor !== undefined) {
        const color = normalizeHexColor(patch.strokeColor);
        if (color !== null) text.stroke.color = color;
      }
      if (patch.strokeWidthPx !== undefined) {
        const v = clampFinite(patch.strokeWidthPx, 0, TEXT_STROKE_WIDTH_MAX, 1);
        if (v !== null) text.stroke.widthPx = v;
      }
    }

    if (patch.backgroundEnabled !== undefined) {
      text.background = patch.backgroundEnabled
        ? (text.background ?? { ...DEFAULT_TEXT_BACKGROUND })
        : undefined;
    }
    if (text.background) {
      if (patch.backgroundColor !== undefined) {
        const color = normalizeHexColor(patch.backgroundColor);
        if (color !== null) text.background.color = color;
      }
      if (patch.backgroundPaddingPx !== undefined) {
        const v = clampFinite(patch.backgroundPaddingPx, 0, TEXT_BACKGROUND_PADDING_MAX, 1);
        if (v !== null) text.background.paddingPx = v;
      }
      if (patch.backgroundRadiusPx !== undefined) {
        const v = clampFinite(patch.backgroundRadiusPx, 0, TEXT_BACKGROUND_PADDING_MAX, 1);
        if (v !== null) text.background.radiusPx = v;
      }
    }
    touched++;
  }
  return touched > 0 ? OK : fail('no text clip in selection');
}

function textLabel(patch: ClipTextPatch): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return 'Metin biçimi değiştirildi';
  if (patch.content !== undefined) return 'Metin içeriği değiştirildi';
  if (patch.fill !== undefined) return 'Metin rengi değiştirildi';
  if (patch.fontSizePx !== undefined) return 'Metin boyutu değiştirildi';
  if (patch.fontId !== undefined) return 'Yazı tipi değiştirildi';
  if (patch.align !== undefined) return 'Metin hizalaması değiştirildi';
  return 'Metin biçimi değiştirildi';
}

export function setClipText(clipIds: readonly Uuid[], patch: ClipTextPatch): OpResult {
  let result: OpResult = fail('no text clip in selection');
  useDocStore.getState().mutate('clipText', textLabel(patch), (d) => {
    result = applyClipTextToDraft(d, clipIds, patch);
  });
  assertDocValidDev('setClipText');
  return result;
}

export interface ClipShapePatch {
  type?: ShapeClip['shape']['type'];
  fill?: string;
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidthPx?: number;
  radiusPx?: number;
}

const DEFAULT_SHAPE_STROKE = { color: '#ffffff', widthPx: 8 };
const SHAPE_TYPES: readonly ShapeClip['shape']['type'][] = ['rect', 'ellipse', 'line', 'arrow'];

export function applyClipShapeToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ClipShapePatch,
): OpResult {
  let touched = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    const clip = loc.clip;
    if (clip.kind !== 'shape') continue;
    const shape = clip.shape;

    if (patch.type !== undefined && SHAPE_TYPES.includes(patch.type)) shape.type = patch.type;
    if (patch.fill !== undefined) {
      const color = normalizeHexColor(patch.fill);
      if (color !== null) shape.fill = color;
    }
    if (patch.strokeEnabled !== undefined) {
      shape.stroke = patch.strokeEnabled ? (shape.stroke ?? { ...DEFAULT_SHAPE_STROKE }) : undefined;
    }
    if (shape.stroke) {
      if (patch.strokeColor !== undefined) {
        const color = normalizeHexColor(patch.strokeColor);
        if (color !== null) shape.stroke.color = color;
      }
      if (patch.strokeWidthPx !== undefined) {
        const v = clampFinite(patch.strokeWidthPx, 0, SHAPE_STROKE_WIDTH_MAX, 1);
        if (v !== null) shape.stroke.widthPx = v;
      }
    }
    if (patch.radiusPx !== undefined) {
      const v = clampFinite(patch.radiusPx, 0, SHAPE_RADIUS_MAX, 1);
      if (v !== null) shape.radiusPx = v;
    }
    touched++;
  }
  return touched > 0 ? OK : fail('no shape clip in selection');
}

function shapeLabel(patch: ClipShapePatch): string {
  const keys = Object.keys(patch);
  if (keys.length !== 1) return 'Şekil biçimi değiştirildi';
  if (patch.type !== undefined) return 'Şekil türü değiştirildi';
  if (patch.fill !== undefined) return 'Şekil rengi değiştirildi';
  if (patch.radiusPx !== undefined) return 'Köşe yarıçapı değiştirildi';
  return 'Şekil biçimi değiştirildi';
}

export function setClipShape(clipIds: readonly Uuid[], patch: ClipShapePatch): OpResult {
  let result: OpResult = fail('no shape clip in selection');
  useDocStore.getState().mutate('clipShape', shapeLabel(patch), (d) => {
    result = applyClipShapeToDraft(d, clipIds, patch);
  });
  assertDocValidDev('setClipShape');
  return result;
}
