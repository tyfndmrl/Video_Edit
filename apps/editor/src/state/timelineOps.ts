/**
 * timelineOps — every timeline document mutation goes through here.
 *
 * All ops run through docStore's mutate/transaction API (patch-based undo), and
 * THAT is where the dev-mode document gate runs (docStore.assertDocGateDev:
 * structure + document invariants + source bounds from the assetStore + the
 * export frame-grid rule). Ops do not assert for themselves — a check the op
 * author has to remember is a check the interactive drag paths never got.
 *
 * Time math uses ONLY the shared schema package helpers (roundHalfUp grid,
 * duration formula) so the editor stays bit-identical with the export
 * compiler (docs/rendering-semantics.md §1).
 *
 * Pure `apply*ToDraft` helpers are exported for interactive drags: the
 * pointer code calls them inside a docStore transaction (one undo entry per
 * drag), while the plain op wrappers commit a single `mutate` each. Only the
 * ones a gesture actually drives are exported — a draft helper with no outside
 * caller (split, speed) stays module-private until a gesture needs it.
 *
 * DELIBERATELY ONE MODULE (yazılı tasarım kararı): every mutation shares one
 * private toolbox (locateClip, fitsInTrack, refitToGrid, reconcileTransitions)
 * and one commit discipline. Splitting by feature would either export that
 * toolbox (spreading the invariant knowledge over N files) or duplicate it —
 * both are how a "small" op grows its own slightly-wrong copy of a rule. Dead
 * exports get DELETED instead (this file is pruned per wave); the file stays
 * big and boring on purpose.
 */
import {
  clipTimelineDurationUs,
  floorDurationToFrameSpan,
  frameSpanCount,
  frameSpanUs,
  frameToUs,
  isOnFrameGrid,
  sourceSpanForDuration,
  maxScaleFor,
  maxScaleForFit,
  roundHalfUp,
  sampleKeyframes,
  snapDurationToFrameSpan,
  snapUsToFrameGrid,
  solveSpeedChange,
  usToFrame,
  hasSourceTimeAxis,
  isMediaClip,
  MAX_LAYER_DIMENSION,
  TRANSFORM_SCALE_DECIMALS,
  TRANSFORM_SCALE_MIN,
  type Clip,
  type Effect,
  type Keyframe,
  type KeyframeTracks,
  type MediaClip,
  type MicroSec,
  type ProjectSettings,
  type LayerPose,
  type Rational,
  type ShapeClip,
  type StickerClip,
  type TextClip,
  type TimelineDoc,
  type Track,
  type TrackType,
  type Transform,
  type Transition,
  type TransitionType,
  type Uuid,
} from '@videoedit/timeline-schema';
import { uuidv7 } from '../lib/uuid';
import { useAssetStore, type AssetSummary } from './assetStore';
import { assertDocGateDev, useDocStore } from './docStore';
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

/**
 * assetId -> durationUs for every asset that HAS a source time axis and whose
 * duration is known. This map is the "source bounds" side of the invariant
 * check (`sourceOutUs <= assetDuration`), so anything it reports is a hard cap
 * on trims, speed solves and transition handles.
 *
 * Two exclusions, both load bearing:
 *
 *  - STILL IMAGES are never in the map. A still has no source clock to run out
 *    of: the export compiler opens it with `-loop 1` and skips the source-range
 *    rules (`ExportClipPlan.IsStillInput`), the schema exempts it
 *    (`hasSourceTimeAxis`), and the editor mints image clips with
 *    `sourceOut = IMAGE_DEFAULT_DURATION_US` (4 s) — a length the FILE knows
 *    nothing about. Reporting a duration for it therefore constrains the clip
 *    against a number that has no meaning, and the numbers that show up are
 *    real: ffprobe hands back nothing for a PNG (`png_pipe`) but 0.04 s for a
 *    JPEG (`image2`, one frame at the default 25 fps). The 40 000 µs case made
 *    "add a photo" fail with `sourceOutUs (4000000) exceeds asset duration
 *    (40000)`, and would have survived any null-only guard.
 *  - NON-NUMBERS are dropped rather than trusted. `durationUs` is typed
 *    `number | undefined`, but a JSON `null` off the wire types the same and
 *    compares as `4000000 > null === true`. assetSync now stops that at the
 *    source; this is the second wall, because the store is writable from
 *    several places and one bad write must not invalidate every document.
 */
export function knownAssetDurations(): Map<string, MicroSec> {
  const map = new Map<string, MicroSec>();
  for (const a of useAssetStore.getState().assets.values()) {
    if (a.kind === 'image') continue;
    const durationUs: number | null | undefined = a.durationUs;
    if (typeof durationUs === 'number' && Number.isFinite(durationUs)) {
      map.set(a.id, durationUs);
    }
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
 * Dev-mode invariant assert on the CURRENT document — a compatibility shim.
 *
 * The gate itself moved to the commit point (`docStore.assertDocGateDev`, run
 * by `mutate` and by transaction `commit`), because as a per-call-site line it
 * only ever guarded the paths whose author remembered to write it: the ops
 * below called it, the interactive drags (which write through a transaction,
 * not through an op) did not. Every op in this file therefore no longer calls
 * it — the store runs the same two checks on the document each op commits.
 *
 * The function stays for the few call sites outside this module that assert
 * again after their own gesture (features/timeline, features/keyframes,
 * features/inspector); those are now redundant re-checks of the same gate, not
 * a second implementation of it.
 */
export function assertDocValidDev(context: string): void {
  assertDocGateDev(useDocStore.getState().doc, context);
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
const DEFAULT_TRANSITION_DURATION_US = 1_000_000;

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
 *
 * A side with no source time axis (still image) is exempt, per side: the export
 * compiler opens it with `-loop 1` and skips the same two checks
 * (ExportClipPlan.IsStillInput). This is what makes a photo-to-photo crossfade —
 * a slideshow — possible at all.
 */
function transitionHandleFits(
  durationUs: MicroSec,
  a: MediaClip,
  b: MediaClip,
  assetDurations: ReadonlyMap<string, MicroSec>,
): boolean {
  if (hasSourceTimeAxis(b) && b.sourceInUs < transitionHandleUs(durationUs, b.speed.rate)) {
    return false;
  }
  if (!hasSourceTimeAxis(a)) return true;
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
 *    `availA = assetDurA - A.sourceOut` and `availB = B.sourceIn`, and a side
 *    with no source time axis (still image) contributes NO limit — its file has
 *    no source clock to run out of (see transitionHandleFits).
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
    !hasSourceTimeAxis(a) || assetDurationA === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, assetDurationA - a.sourceOutUs);
  const availB = hasSourceTimeAxis(b) ? b.sourceInUs : Number.POSITIVE_INFINITY;
  const handleCapUs = 2 * Math.min(availA / a.speed.rate, availB / b.speed.rate);

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
interface TransitionReconcileReport {
  shortened: number;
  removed: number;
  /**
   * Which cap forced the (last) shortening. Carried so the bubble can name the
   * real cause — "kaynak payı" and "komşu klip süresi" send the user to two
   * DIFFERENT fixes, and guessing one of them is worse than saying nothing.
   */
  shortenedBy: 'handle' | 'length' | null;
  /**
   * Clips whose transform the pass had to rewrite so their transition chain
   * stays laid out identically (see alignTransitionChainTransforms). Counted
   * separately because it is the only repair that touches a clip the edit was
   * not even about.
   */
  aligned: number;
}

const NO_TRANSITION_CHANGE: TransitionReconcileReport = {
  shortened: 0,
  removed: 0,
  shortenedBy: null,
  aligned: 0,
};

/**
 * Notice code for a report, or undefined when nothing changed.
 *
 * The chain alignment comes LAST on purpose. Losing a transition, or getting a
 * shorter one than you asked for, is the headline of the edit; a neighbour
 * re-laid-out to match it is a consequence of that same edit and only worth the
 * single notice slot when nothing louder happened.
 */
function transitionReconcileNotice(
  report: TransitionReconcileReport,
): string | undefined {
  if (report.removed > 0) return TRANSITION_DROPPED;
  if (report.shortened > 0) {
    return report.shortenedBy === 'handle'
      ? TRANSITION_SHORTENED_HANDLE
      : TRANSITION_SHORTENED_LENGTH;
  }
  return report.aligned > 0 ? TRANSFORM_APPLIED_TO_TRANSITION_CHAIN : undefined;
}

function mergeTransitionReports(
  a: TransitionReconcileReport,
  b: TransitionReconcileReport,
): TransitionReconcileReport {
  return {
    shortened: a.shortened + b.shortened,
    removed: a.removed + b.removed,
    shortenedBy: b.shortenedBy ?? a.shortenedBy,
    aligned: a.aligned + b.aligned,
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
  const report: TransitionReconcileReport = {
    shortened: 0,
    removed: 0,
    shortenedBy: null,
    aligned: 0,
  };
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
    // Both sides present AND disagreeing means two DIFFERENT cuts collapsed
    // into one: ripple-deleting the middle clip of `A -crossfade- B -dissolve- C`
    // leaves A.transitionOut (crossfade) facing C.transitionIn (dissolve) across
    // a brand-new A|C cut. Only one of them can survive (the outgoing side, per
    // the rule above), so the other ceases to exist — and a transition the user
    // built disappearing without a word is exactly the "it changed something I
    // did not ask for" complaint. Count it as a removal so the caller raises
    // the bubble; the cut itself survives, which is why this is not the
    // `plan === null` branch.
    const facing = a.transitionOut !== undefined ? b.transitionIn : undefined;
    if (
      facing !== undefined &&
      (facing.type !== wanted.type || facing.durationUs !== wanted.durationUs)
    ) {
      report.removed++;
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

  report.aligned = alignTransitionChainTransforms(track);
  return report;
}

/**
 * Makes every LIVE transition chain in the track share one transform, copying
 * from the chain's FIRST clip. Returns how many clips had to be rewritten.
 *
 * Why it belongs to reconciliation and not to the individual ops: the ops above
 * do not only BREAK cuts, they also CREATE them. Ripple-deleting B out of
 * `A -xfade- B ... C` leaves A's `transitionOut` facing a brand-new A|C cut, and
 * the loop above adopts it (the outgoing side wins) — so A and C become one
 * xfade stream although nothing ever required their layouts to match. The same
 * shape reaches here through moving, trimming and pasting. Aligning at the end
 * of the pass covers all of them at once, which is the point: the rule cannot be
 * re-broken by an op that forgets to think about it, and `checkTimelineInvariants`
 * (transition placement) is what fails loudly if some path still does.
 *
 * The FIRST clip wins for the same reason it wins for the transition metadata
 * itself: it is the outgoing side of the cut the chain grew from. Any other
 * choice would make the result depend on which end of the chain the edit
 * happened to touch.
 */
function alignTransitionChainTransforms(track: Track): number {
  const cs = track.clips;
  let rewritten = 0;
  let anchor: Clip | null = null;
  for (let i = 0; i + 1 < cs.length; i++) {
    const a = cs[i];
    const b = cs[i + 1];
    const joined =
      isMediaClip(a) &&
      isMediaClip(b) &&
      a.transitionOut !== undefined &&
      b.transitionIn !== undefined &&
      clipEndUs(a) === b.timelineStartUs;
    if (!joined) {
      anchor = null;
      continue;
    }
    // First cut of a chain: `a` is the anchor the whole chain adopts.
    anchor ??= a;
    if (!transformsEqual(anchor.transform, b.transform)) {
      b.transform = { ...anchor.transform };
      rewritten++;
    }
  }
  return rewritten;
}

function transformsEqual(a: Transform, b: Transform): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.scale === b.scale &&
    a.rotationDeg === b.rotationDeg &&
    a.anchorX === b.anchorX &&
    a.anchorY === b.anchorY
  );
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

/**
 * Inserts a freshly built track at its PARTITION position: audio tracks live
 * at the BOTTOM of the stack, video/overlay tracks above them (CapCut's
 * layout). This is an OP POLICY, not a document invariant — a legacy document
 * with a mixed order stays loadable and is never auto-normalized; the user's
 * own reorders are steered by `trackMoveBlockReason` instead.
 *
 * audio -> push (below everything); video/overlay -> spliced in FRONT of the
 * first audio track (bottom of the non-audio section), or pushed when the
 * document has no audio track. Audio tracks are z-order NEUTRAL (the export
 * compiler never reads track.type for stacking; visuals come from clip.kind),
 * so this placement changes no rendered output.
 */
function insertTrackPositioned(d: TimelineDoc, track: Track): void {
  if (track.type === 'audio') {
    d.tracks.push(track);
    return;
  }
  const firstAudio = d.tracks.findIndex((t) => t.type === 'audio');
  if (firstAudio < 0) d.tracks.push(track);
  else d.tracks.splice(firstAudio, 0, track);
}

/** Adds a track at its partition position (see insertTrackPositioned). */
export function addTrack(type: TrackType, name?: string): Uuid {
  const track = makeTrack(type, name);
  useDocStore.getState().mutate('addTrack', 'Track eklendi', (d) => {
    insertTrackPositioned(d, track);
  });
  return track.id;
}

function toggleTrackFlag(trackId: Uuid, flag: 'muted' | 'hidden' | 'locked', label: string): OpResult {
  const exists = doc().tracks.some((t) => t.id === trackId);
  if (!exists) return fail('track not found');
  useDocStore.getState().mutate('trackFlag', label, (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (t) t[flag] = !t[flag];
  });
  return OK;
}

export const toggleTrackMuted = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'muted', 'Track sessize alındı/açıldı');
export const toggleTrackHidden = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'hidden', 'Track gizlendi/gösterildi');
export const toggleTrackLocked = (trackId: Uuid): OpResult =>
  toggleTrackFlag(trackId, 'locked', 'Track kilitlendi/açıldı');

/** Schema bound on a track name (TrackSchema: `z.string().max(200)`). */
export const TRACK_NAME_MAX_LENGTH = 200;

/**
 * Why `trackId` cannot be renamed, or null. Exported for the context menu and
 * the header's double-click path — both grey/skip with EXACTLY the op's rule.
 */
export function trackRenameBlockReason(d: TimelineDoc, trackId: Uuid): string | null {
  const track = d.tracks.find((t) => t.id === trackId);
  if (!track) return 'track not found';
  if (track.locked) return 'track is locked';
  return null;
}

/**
 * Renames a track (inline edit in the track header). The name is trimmed and
 * cut to the schema bound; an EMPTY result clears the custom name entirely, so
 * the header falls back to its derived label ("Video 1") — a deliberate escape
 * hatch, not an error. Locked tracks refuse, same as every other track edit.
 */
export function renameTrack(trackId: Uuid, name: string): OpResult {
  const blocked = trackRenameBlockReason(doc(), trackId);
  if (blocked !== null) return fail(blocked);
  const track = doc().tracks.find((t) => t.id === trackId);
  if (!track) return fail('track not found');
  const trimmed = name.trim().slice(0, TRACK_NAME_MAX_LENGTH);
  const next = trimmed.length === 0 ? undefined : trimmed;
  if (track.name === next) return OK;
  useDocStore.getState().mutate('renameTrack', 'Track yeniden adlandırıldı', (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t) return;
    if (next === undefined) delete t.name;
    else t.name = next;
  });
  return OK;
}

export type TrackMoveDirection = 'up' | 'down';

/**
 * Why `trackId` cannot move one row up/down, or null when it can.
 *
 * Exported for the context menu (same contract as trackDeleteBlockReason).
 * `tracks[0]` is the TOP layer — both in the editor's header column and in the
 * export compiler's render order — so 'up' means index - 1. Only the track
 * BEING MOVED must be unlocked: a lock protects a track's content, and moving
 * a sibling never edits that content (the sibling's clips are untouched).
 */
export function trackMoveBlockReason(
  d: TimelineDoc,
  trackId: Uuid,
  direction: TrackMoveDirection,
): string | null {
  const index = d.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) return 'track not found';
  if (d.tracks[index].locked) return 'track is locked';
  if (direction === 'up' && index === 0) return 'track already at the top';
  if (direction === 'down' && index === d.tracks.length - 1) return 'track already at the bottom';
  // Partition policy (see insertTrackPositioned): an audio track never climbs
  // above a non-audio track. After the neighbour swap the pair reads
  // [upperAfter, lowerAfter]; it violates the partition exactly when the track
  // ending up ON TOP is audio and the one ending up BELOW is not. The
  // CORRECTIVE direction stays free on purpose: in a mixed legacy document,
  // moving the audio down (or the video up) is precisely how the user repairs
  // the layout, so only the violating swap is refused.
  const neighbour = d.tracks[direction === 'up' ? index - 1 : index + 1];
  const upperAfter = direction === 'up' ? d.tracks[index] : neighbour;
  const lowerAfter = direction === 'up' ? neighbour : d.tracks[index];
  if (upperAfter.type === 'audio' && lowerAfter.type !== 'audio') {
    return 'audio tracks stay below video tracks';
  }
  return null;
}

/**
 * Moves a track one row up/down (context-menu reorder).
 *
 * Reordering tracks IS reordering render layers: `tracks[0]` is the top layer
 * for the preview compositor (resolveVisualStack draws the array back-to-front)
 * AND for the export compiler (ExportCompiler iterates `doc.Tracks` in order),
 * so a single splice changes both the same way — that shared contract is what
 * the reorder tests pin (timelineOps.test.ts + the export graph comparison).
 */
export function moveTrack(trackId: Uuid, direction: TrackMoveDirection): OpResult {
  const d = doc();
  const blocked = trackMoveBlockReason(d, trackId, direction);
  if (blocked !== null) return fail(blocked);
  const label = direction === 'up' ? 'Track yukarı taşındı' : 'Track aşağı taşındı';
  useDocStore.getState().mutate('moveTrack', label, (dd) => {
    const from = dd.tracks.findIndex((t) => t.id === trackId);
    if (from < 0) return;
    const to = direction === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= dd.tracks.length) return;
    const [track] = dd.tracks.splice(from, 1);
    dd.tracks.splice(to, 0, track);
  });
  return OK;
}

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
    if (i < 0) return;
    const [removed] = dd.tracks.splice(i, 1);
    // A deleted clip's link partner lives on ANOTHER track and would be left
    // holding a single-member linkId (invariant rule 10 violation). Breaking
    // the bond is part of the same mutate: one undo restores track AND bonds.
    const removedLinkIds = new Set<string>();
    for (const c of removed.clips) {
      if (isMediaClip(c) && c.linkId !== undefined) removedLinkIds.add(c.linkId);
    }
    if (removedLinkIds.size > 0) {
      for (const t of dd.tracks) {
        for (const c of t.clips) {
          if (isMediaClip(c) && c.linkId !== undefined && removedLinkIds.has(c.linkId)) {
            delete c.linkId;
          }
        }
      }
    }
    // Groups that the deletion shrank below 2 members dissolve (rule 11).
    cleanupShrunkenGroups(dd);
  });

  // Selection may not survive its clips.
  const editor = useEditorStore.getState();
  const next = [...editor.selection].filter((id) => !removedClipIds.has(id));
  if (next.length !== editor.selection.size) editor.setSelection(next);
  return OK;
}

// ---------------------------------------------------------------------------
// addClipFromAsset
// ---------------------------------------------------------------------------

/**
 * A fresh clip for `asset`, placed at the (already grid-snapped) `startUs`.
 *
 * The length is TAIL-SNAPPED: the clip ends on the frame boundary at or before
 * the end of the source, and `sourceOutUs` follows the length exactly. Real
 * assets do not have grid-friendly durations — ffprobe reports 7.307300 s,
 * 12.679333 s — so without this the very first thing a user does (drop a file
 * on the timeline) writes a clip whose END is off the project grid and whose
 * export comes back HTTP 422. One tail snap satisfies all three rules at once:
 *   - both edges on the grid (export gate, `isClipOnFrameGrid`),
 *   - duration formula at rate 1 (`sourceOutUs - sourceInUs == duration`),
 *   - source bound (`sourceOutUs <= asset duration`, since the snap only ever
 *     shortens).
 * The still-image default (4 s) goes through the same path, which is what puts
 * it on the grid in NTSC projects where 4_000_000 us is not a frame boundary.
 */
function buildClipFromAsset(
  asset: AssetSummary,
  startUs: MicroSec,
  fps: Rational,
): MediaClip | null {
  // LUT (.cube) bir MEDYA değildir: klip türü yoktur, timeline'a konamaz — kullanım
  // yeri lut EFEKTİNİN assetId'sidir (Inspector LUT bölümü). Sunucu yarısı aynı reddi
  // 'asset-clip-type' olarak verir (ExportCompiler.IsTypeMismatch, MediaKind.Lut).
  if (asset.kind === 'lut') return null;
  const sourceDurationUs = asset.kind === 'image' ? IMAGE_DEFAULT_DURATION_US : asset.durationUs;
  if (sourceDurationUs === undefined || sourceDurationUs <= 0) return null;
  const durationUs = floorDurationToFrameSpan(startUs, sourceDurationUs, fps);
  // Shorter than one frame at this fps — refuse rather than write a clip the
  // renderer would drop.
  if (durationUs <= 0) return null;
  return {
    id: uuidv7(),
    kind: asset.kind,
    assetId: asset.id,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
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
  if (asset.kind === 'lut') return { ok: false, reason: 'lut is not a clip source' };

  const startUs = snapUsToFrameGrid(Math.max(0, Math.round(timelineStartUs)), d.settings.fps);
  const clip = buildClipFromAsset(asset, startUs, d.settings.fps);
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
    useEditorStore.getState().setSelection([clip.id]);
    return { ok: true, clipId: clip.id, trackId: target.trackId };
  }

  const newTrack = makeTrack(requiredType);
  useDocStore.getState().mutate('addClip', `${asset.name} eklendi`, (dd) => {
    newTrack.clips.push(clip);
    insertTrackPositioned(dd, newTrack);
  });
  useEditorStore.getState().setSelection([clip.id]);
  return { ok: true, clipId: clip.id, trackId: newTrack.id };
}

// ---------------------------------------------------------------------------
// moveClips
// ---------------------------------------------------------------------------

export interface MovePlan {
  ok: true;
  moves: {
    clipId: Uuid;
    fromTrackIndex: number;
    toTrackIndex: number;
    newStartUs: MicroSec;
    /** Re-fitted length at the new start (see `refitToGrid`); usually unchanged. */
    newDurationUs: MicroSec;
    /** Media clips only, and only when the re-fit had to move the source window. */
    newSourceInUs?: MicroSec;
    newSourceOutUs?: MicroSec;
  }[];
}

export type MovePlanResult = MovePlan | { ok: false; reason: string };

/**
 * Re-fit a clip that is about to move to `newStartUs` so BOTH of its edges stay
 * on the project frame grid (the export compiler's gate).
 *
 * Why a move needs a re-fit at all: outside integer fps the grid is not closed
 * under addition, so the microsecond length of "n frames" DEPENDS ON WHERE THE
 * CLIP STARTS. At 30 fps a clip covering frames 1..2 is 33_334 us long; the
 * same two frames starting at frame 0 are 33_333 us. Moving the clip by one
 * frame while keeping the microsecond length therefore pushes its end off the
 * grid — the document then saves fine (PUT 200) and the export refuses it (422).
 *
 * The frame COUNT is what the clip is: it is preserved exactly whenever the
 * source allows. The length follows the grid, and for a media clip the source
 * window follows the length (rule 3 stays exact to the microsecond) — the out
 * point is preferred, the in point is used when the asset has no slack left at
 * the tail.
 *
 * A microsecond of source is not always there to spend: a clip that already
 * covers its whole asset (sourceIn 0, sourceOut = asset duration) cannot grow,
 * and below 1x some durations have NO admissible source span at all (the window
 * is narrower than a microsecond). Rather than dead-end an ordinary drag, those
 * cases fall through to `solveSpeedChange`, which finds the nearest frame count
 * that IS reachable at the new start and re-derives the out point for it —
 * costing at most a frame of length instead of the whole edit. `null` (nothing
 * works at all) still refuses.
 */
function refitToGrid(
  clip: Clip,
  newStartUs: MicroSec,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): { durationUs: MicroSec; sourceInUs?: MicroSec; sourceOutUs?: MicroSec } | null {
  // A clip that is already off the grid (older revision, changed project fps)
  // has no frame span to preserve — leave it exactly as it is rather than
  // "correcting" it to a length the user never chose.
  if (!isOnFrameGrid(clip.timelineStartUs, fps) || !isOnFrameGrid(newStartUs, fps)) {
    return { durationUs: clip.timelineDurationUs };
  }
  const frames = frameSpanCount(clip.timelineStartUs, clip.timelineDurationUs, fps);
  const durationUs = frameSpanUs(newStartUs, frames, fps);
  if (durationUs <= 0) return null;
  if (durationUs === clip.timelineDurationUs) return { durationUs };
  if (!isMediaClip(clip)) return { durationUs };

  // Rule 3 must stay EXACT: find the source span the formula maps onto the new
  // duration, then spend it at the tail if the asset has room, at the head
  // otherwise (a still image has no source clock and is left alone).
  if (!hasSourceTimeAxis(clip)) return { durationUs };
  const assetDurationUs = assetDurations.get(clip.assetId);
  const span = sourceSpanForDuration(durationUs, clip.speed.rate);
  if (span !== null && span >= 1) {
    const outFirst = clip.sourceInUs + span;
    if (assetDurationUs === undefined || outFirst <= assetDurationUs) {
      return { durationUs, sourceInUs: clip.sourceInUs, sourceOutUs: outFirst };
    }
    const inFallback = clip.sourceOutUs - span;
    if (inFallback >= 0) {
      return { durationUs, sourceInUs: inFallback, sourceOutUs: clip.sourceOutUs };
    }
  }

  // Exact span unavailable (see the block comment): settle for the nearest
  // reachable frame count at this start instead of refusing the edit.
  const solved = solveSpeedChange(clip.sourceInUs, clip.sourceOutUs, clip.speed.rate, fps, {
    maxSourceOutUs: assetDurationUs,
    minFrames: 1,
    timelineStartUs: newStartUs,
  });
  if (solved === null) return null;
  return {
    durationUs: solved.durationUs,
    sourceInUs: clip.sourceInUs,
    sourceOutUs: solved.sourceOutUs,
  };
}

/**
 * Where a clip lands when the timeline shifts it by `frameDelta` whole frames.
 * A clip that is already off the grid (legacy document) cannot be walked in
 * frames, so it keeps the raw microsecond delta instead of being "corrected"
 * to somewhere the user never put it.
 */
function shiftedStartUs(
  clip: Clip,
  frameDelta: number,
  deltaUs: MicroSec,
  fps: Rational,
): MicroSec {
  if (!isOnFrameGrid(clip.timelineStartUs, fps)) return clip.timelineStartUs + deltaUs;
  return frameToUs(usToFrame(clip.timelineStartUs, fps) + frameDelta, fps);
}

/**
 * Move `clip` to `newStartUs` in place, keeping its frame span and both edges
 * on the grid (see `refitToGrid`). false = the span does not fit there and the
 * caller must refuse the whole op.
 */
function shiftClipOnGrid(
  clip: Clip,
  newStartUs: MicroSec,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): boolean {
  const refit = refitToGrid(clip, newStartUs, fps, assetDurations);
  if (refit === null) return false;
  clip.timelineStartUs = newStartUs;
  clip.timelineDurationUs = refit.durationUs;
  if (refit.sourceInUs !== undefined && isMediaClip(clip)) {
    clip.sourceInUs = refit.sourceInUs;
    clip.sourceOutUs = refit.sourceOutUs!;
  }
  clampAudioFadesToDuration(clip);
  return true;
}

/**
 * Ripple the clips after `fromIndex` so they follow an edge that moved from
 * `oldEdgeUs` to `newEdgeUs`.
 *
 * The shift is measured in FRAMES, not microseconds, for the same reason the
 * move op works that way: a microsecond shift of a grid-aligned clip lands its
 * end off the grid two times out of three at 30 fps, and the export compiler
 * rejects that document. false = a follower cannot keep its frame span at the
 * new position and the caller must refuse the whole op.
 */
function rippleFollowers(
  track: Track,
  fromIndex: number,
  oldEdgeUs: MicroSec,
  newEdgeUs: MicroSec,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): boolean {
  const deltaUs = newEdgeUs - oldEdgeUs;
  if (deltaUs === 0) return true;
  const frameDelta = usToFrame(newEdgeUs, fps) - usToFrame(oldEdgeUs, fps);
  // Plan first, write second: a follower that cannot be re-fitted must leave the
  // OTHERS untouched (a half-rippled track is a broken document, not a refusal).
  const targets = track.clips.slice(fromIndex).map((c) => ({
    clip: c,
    startUs: shiftedStartUs(c, frameDelta, deltaUs, fps),
  }));
  if (targets.some((t) => refitToGrid(t.clip, t.startUs, fps, assetDurations) === null)) {
    return false;
  }
  for (const t of targets) shiftClipOnGrid(t.clip, t.startUs, fps, assetDurations);
  return true;
}

/**
 * Validates moving `clipIds` by a uniform delta and an optional vertical track
 * shift.
 *
 * Frame-grid policy (same as every other op — docs/rendering-semantics §1):
 * the REFERENCE clip's target start (clipIds[0]; the drag code puts the
 * grabbed anchor first) is snapped to the project fps grid, and the resulting
 * whole-FRAME delta is applied to the whole selection ONCE. Relative offsets
 * are preserved exactly IN FRAMES, which is the unit the export ledger counts
 * in; in microseconds they can differ by one or two, because the grid is not
 * closed under addition (30 fps: frame 1 = 33_333 us, frame 2 = 66_667 us).
 * Preserving the microsecond offsets instead is what used to push the
 * non-anchor clips off the grid and their export to HTTP 422.
 *
 * Overlaps reject the whole move (MVP: no auto-ripple, per design §3.3).
 *
 * The vertical `trackDelta` is SECTION-SCOPED (CapCut behaviour): the stack has
 * two sections — non-audio on top, audio below (`insertTrackPositioned`) — and
 * only the clips in the ANCHOR's section change lanes; clips in the other
 * section slide horizontally in their own lane (delta 0). Without this, a
 * linked AV pair could never be dragged vertically at all: the video half's
 * lane change would push the audio half onto a video track and the type gate
 * below would refuse the whole move. That type gate STAYS — within a section a
 * video clip still cannot land on an overlay track.
 */
export function planMoveClips(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  deltaUs: MicroSec,
  trackDelta = 0,
  assetDurations: ReadonlyMap<string, MicroSec> = knownAssetDurations(),
): MovePlanResult {
  if (clipIds.length === 0) return { ok: false, reason: 'nothing to move' };
  const fps = d.settings.fps;
  const moves: MovePlan['moves'] = [];
  const moving = new Set(clipIds);

  // Snap the delta once against the reference clip so the anchor's new start
  // sits on the frame grid (a raw pointer delta must never land off-grid).
  // Negative targets are NOT clamped here — they must still reject below.
  const ref = locateClip(d, clipIds[0]);
  if (!ref) return { ok: false, reason: 'clip not found' };
  const sectionOf = (track: Track): 0 | 1 => (track.type === 'audio' ? 1 : 0);
  const anchorSection = sectionOf(ref.track);
  const refTargetUs = Math.round(ref.clip.timelineStartUs + deltaUs);
  const refSnappedUs = refTargetUs < 0 ? refTargetUs : snapUsToFrameGrid(refTargetUs, fps);
  deltaUs = refSnappedUs - ref.clip.timelineStartUs;
  // The delta in FRAMES — the unit the rest of the selection is shifted by.
  // A negative target keeps the raw microsecond delta; it rejects below anyway.
  const frameDelta =
    refTargetUs < 0 ? null : usToFrame(refSnappedUs, fps) - usToFrame(ref.clip.timelineStartUs, fps);

  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc) return { ok: false, reason: 'clip not found' };
    if (loc.track.locked) return { ok: false, reason: 'track is locked' };
    const toTrackIndex =
      loc.trackIndex + (sectionOf(loc.track) === anchorSection ? trackDelta : 0);
    if (toTrackIndex < 0 || toTrackIndex >= d.tracks.length) {
      return { ok: false, reason: 'no track at target position' };
    }
    const toTrack = d.tracks[toTrackIndex];
    if (toTrack.locked) return { ok: false, reason: 'target track is locked' };
    if (toTrack.type !== loc.track.type) return { ok: false, reason: 'track type mismatch' };
    // Off-grid legacy clips (imported/older revision) keep the raw delta: the
    // frame walk is only meaningful for a start that IS a frame boundary.
    const onGrid = frameDelta !== null && isOnFrameGrid(loc.clip.timelineStartUs, fps);
    const newStartUs = onGrid
      ? frameToUs(usToFrame(loc.clip.timelineStartUs, fps) + frameDelta, fps)
      : loc.clip.timelineStartUs + deltaUs;
    if (newStartUs < 0) return { ok: false, reason: 'before timeline start' };
    const refit = onGrid
      ? refitToGrid(loc.clip, newStartUs, fps, assetDurations)
      : { durationUs: loc.clip.timelineDurationUs };
    if (refit === null) return { ok: false, reason: 'clip cannot keep its frame span here' };
    moves.push({
      clipId,
      fromTrackIndex: loc.trackIndex,
      toTrackIndex,
      newStartUs,
      newDurationUs: refit.durationUs,
      newSourceInUs: refit.sourceInUs,
      newSourceOutUs: refit.sourceOutUs,
    });
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
      intervals.push({ start: m.newStartUs, end: m.newStartUs + m.newDurationUs });
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
  // Closure INSIDE the op (not per panel): whoever calls moveClips — drag,
  // menu, shortcut, a future nudge — moves the link partners and group members
  // too. A caller that already expanded gets the identical set back.
  const ids = expandSelectionForOp(d0, clipIds, 'move');
  const durations = knownAssetDurations();
  const plan = planMoveClips(d0, ids, deltaUs, trackDelta, durations);
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

  const label = ids.length === 1 ? 'Klip taşındı' : `${ids.length} klip taşındı`;
  let report = NO_TRANSITION_CHANGE;
  useDocStore.getState().mutate('move', label, (dd) => {
    const moving = new Set(ids);
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
      // The grid re-fit (see refitToGrid): length follows the grid, source
      // window follows the length. Both are usually identity.
      clip.timelineDurationUs = m.newDurationUs;
      if (m.newSourceInUs !== undefined && isMediaClip(clip)) {
        clip.sourceInUs = m.newSourceInUs;
        clip.sourceOutUs = m.newSourceOutUs!;
      }
      clampAudioFadesToDuration(clip);
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
  return okWith(transitionReconcileNotice(report));
}

// ---------------------------------------------------------------------------
// trimClip (normal / ripple / roll)
// ---------------------------------------------------------------------------

export type TrimEdge = 'left' | 'right';
export type TrimMode = 'normal' | 'ripple' | 'roll';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** First frame boundary at or after `us` / last one at or before it. */
function ceilUsToFrameGrid(us: MicroSec, fps: Rational): MicroSec {
  let frame = usToFrame(us, fps);
  while (frameToUs(frame, fps) < us) frame++;
  return frameToUs(frame, fps);
}
function floorUsToFrameGrid(us: MicroSec, fps: Rational): MicroSec {
  let frame = usToFrame(us, fps);
  while (frame > 0 && frameToUs(frame, fps) > us) frame--;
  return frameToUs(frame, fps);
}

// ---------------------------------------------------------------------------
// Grid-first span fitting
//
// Every trim clamps its edge against the SOURCE — `assetDurationUs` on the
// right, `sourceInUs >= 0` on the left. Those bounds are raw container
// microseconds (ffprobe reports 7.307300 s for a real file), never frame
// boundaries, and when the clamp bit, the grid-snapped target the user dragged
// to was thrown away: the length got re-derived from source microseconds and
// the clip's far edge landed OFF the project frame grid. The export compiler
// rejects exactly that (HTTP 422) and the editor said nothing — measured on
// "over-trim, then drag the edge back out" gestures, 1602 of 1604 across the
// four project rates produced such a document.
//
// The order of derivation is therefore inverted here, the same way
// `solveSpeedChange` inverts it for speed edits: pick the LENGTH AS A WHOLE
// FRAME SPAN first (measured from whichever edge stays put), then find the
// source span the duration formula maps exactly onto it. Both export gates
// then hold by construction — the frame grid because the length IS a span
// between two grid edges, and the duration formula because
// `sourceSpanForDuration` decides the span with the compiler's own expression
// instead of `roundHalfUp(duration * rate)`, which only inverts at rate >= 1.
// ---------------------------------------------------------------------------

/** A clip length as a frame span, plus the source span that produces it. */
interface FittedSpan {
  durationUs: MicroSec;
  /** `sourceOutUs - sourceInUs` for that duration — exact, never rounded. */
  sourceSpanUs: number;
}

/**
 * How many frames the fit may walk DOWN from the requested count. Only rates
 * below 1x ever need more than a step or two: there the admissible source
 * window (`rate*(D-0.5) <= span < rate*(D+0.5)`) is narrower than a
 * microsecond, so some frame counts have no source span at all — the same
 * effect `solveSpeedChange` walks around, where a 792 080-case sweep needed at
 * most 22 frames.
 */
const SPAN_FIT_MAX_STEPS = 64;

/**
 * Largest whole-frame span that is no longer than `capUs`, no longer than the
 * user asked for (`wantFrames`), and REACHABLE at `rate`.
 *
 * @param spanUsAt microseconds of `frames` whole frames measured from the edge
 *   that stays put — must be monotone increasing in `frames`.
 * @param maxSourceSpanUs hard ceiling on `sourceOut - sourceIn` (the media tail
 *   on a right trim, `sourceOutUs` itself on a left one).
 */
function fitFrameSpan(
  spanUsAt: (frames: number) => MicroSec,
  wantFrames: number,
  capUs: MicroSec,
  rate: number,
  maxSourceSpanUs: number,
): FittedSpan | null {
  if (maxSourceSpanUs < 1) return null;
  let frames = Math.max(1, wantFrames);
  // The caps the caller clamped against can be off-grid values, so the frame
  // count they name may sit a fraction of a frame above them.
  while (frames > 1 && spanUsAt(frames) > capUs) frames--;
  for (let step = 0; step < SPAN_FIT_MAX_STEPS && frames >= 1; step++, frames--) {
    const durationUs = spanUsAt(frames);
    if (durationUs <= 0 || durationUs > capUs) continue;
    const sourceSpanUs = sourceSpanForDuration(durationUs, rate, maxSourceSpanUs);
    if (sourceSpanUs !== null && sourceSpanUs >= 1) return { durationUs, sourceSpanUs };
  }
  return null;
}

/** Fit measured from a fixed START edge (right trims, ripple left trims). */
function fitSpanFromStart(
  startUs: MicroSec,
  wantDurationUs: MicroSec,
  capUs: MicroSec,
  rate: number,
  maxSourceSpanUs: number,
  fps: Rational,
): FittedSpan | null {
  return fitFrameSpan(
    (frames) => frameSpanUs(startUs, frames, fps),
    frameSpanCount(startUs, Math.max(0, wantDurationUs), fps),
    capUs,
    rate,
    maxSourceSpanUs,
  );
}

/**
 * Fit measured back from a fixed END edge (normal left trims). With the end
 * pinned it is the new START that has to land on a frame boundary, so the span
 * is counted backwards from the end frame.
 */
function fitSpanToEnd(
  endUs: MicroSec,
  wantDurationUs: MicroSec,
  capUs: MicroSec,
  rate: number,
  maxSourceSpanUs: number,
  fps: Rational,
): FittedSpan | null {
  const endFrame = usToFrame(endUs, fps);
  const wantStartUs = Math.max(0, endUs - Math.max(0, wantDurationUs));
  return fitFrameSpan(
    (frames) => (frames > endFrame ? -1 : endUs - frameToUs(endFrame - frames, fps)),
    Math.min(endFrame, endFrame - usToFrame(wantStartUs, fps)),
    capUs,
    rate,
    maxSourceSpanUs,
  );
}

/**
 * Right-edge trim of a media clip toward `targetEndUs` (already clamped by
 * the caller into a feasible window). Mutates the clip so BOTH export gates
 * hold: the new end is a whole-frame span from the clip's start, and
 * timelineDurationUs = round((out-in)/rate) exactly. Returns the actual new end.
 */
function trimMediaRight(
  clip: MediaClip,
  targetEndUs: MicroSec,
  maxEndUs: MicroSec,
  minDurUs: MicroSec,
  assetDurationUs: MicroSec | undefined,
  fps: Rational,
): MicroSec {
  const start = clip.timelineStartUs;
  const rate = clip.speed.rate;

  // Grid first (see the block comment above). `maxSourceSpanUs` keeps the
  // derived out point inside the media even when the timeline cap is looser —
  // clamping the OUT POINT after the fact is what broke the grid before.
  const fitted = fitSpanFromStart(
    start,
    targetEndUs - start,
    maxEndUs - start,
    rate,
    (assetDurationUs ?? Number.MAX_SAFE_INTEGER) - clip.sourceInUs,
    fps,
  );
  if (fitted !== null) {
    clip.sourceOutUs = clip.sourceInUs + fitted.sourceSpanUs;
    clip.timelineDurationUs = fitted.durationUs;
    remapKeyframes(clip, 0, fitted.durationUs);
    clampAudioFadesToDuration(clip);
    return start + fitted.durationUs;
  }

  // No frame count in range has an admissible source span (only reachable
  // below 1x). Fall back to the source-derived length: it still satisfies the
  // duration formula, and refusing the drag outright would be worse.
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
  fps: Rational,
): { newStartUs: MicroSec; durationDeltaUs: MicroSec } {
  const oldStart = clip.timelineStartUs;
  const oldDur = clip.timelineDurationUs;
  const end = oldStart + oldDur;
  const rate = clip.speed.rate;

  // Grid first (see the block comment above the fitters). WHICH edge has to
  // land on a frame boundary depends on the anchor: with the end pinned
  // (normal trim) it is the new START, with the start pinned (ripple trim) it
  // is the new END. The source ceiling is the same either way — `sourceInUs`
  // floors at 0, so the window can never be longer than `sourceOutUs`, and it
  // is exactly that floor that used to hand back an off-grid length.
  const fitted =
    anchor === 'end'
      ? fitSpanToEnd(end, end - targetStartUs, end - minStartUs, rate, clip.sourceOutUs, fps)
      : fitSpanFromStart(
          oldStart,
          end - targetStartUs,
          Number.MAX_SAFE_INTEGER,
          rate,
          clip.sourceOutUs,
          fps,
        );
  if (fitted !== null) {
    clip.sourceInUs = clip.sourceOutUs - fitted.sourceSpanUs;
    clip.timelineDurationUs = fitted.durationUs;
    if (anchor === 'end') clip.timelineStartUs = end - fitted.durationUs;
    remapKeyframes(clip, fitted.durationUs - oldDur, fitted.durationUs);
    clampAudioFadesToDuration(clip);
    return { newStartUs: clip.timelineStartUs, durationDeltaUs: fitted.durationUs - oldDur };
  }

  // No reachable frame count (only possible below 1x) — source-derived
  // fallback, which still satisfies the duration formula.
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
        ? aStart +
          floorDurationToFrameSpan(
            aStart,
            clipTimelineDurationUs(a.sourceInUs, aAssetDur, a.speed.rate),
            fps,
          )
        : Number.MAX_SAFE_INTEGER;
    const bMinStart = bEnd - clipTimelineDurationUs(0, b.sourceOutUs, b.speed.rate);
    // The cut is SHARED — A's end and B's start are the same instant — so the
    // bounds are rounded INWARD onto the grid before the clamp. Both source
    // limits above are raw container microseconds; clamping the cut to one of
    // them puts BOTH clips off the grid, and rounding outward instead would
    // hand back a cut one of the two sides has no source for.
    const lo = ceilUsToFrameGrid(Math.max(aStart + frameSpanUs(aStart, 1, fps), bMinStart), fps);
    const hi = floorUsToFrameGrid(
      Math.min(frameToUs(usToFrame(bEnd, fps) - 1, fps), aMaxEnd),
      fps,
    );
    if (lo > hi) return fail('no room to roll');
    target = clamp(target, lo, hi);

    const newCut = trimMediaRight(a, target, hi, minDur, aAssetDur, fps);
    trimMediaLeft(b, newCut, newCut, minDur, 'end', fps);
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
    // One whole frame AT THIS START. `minDur` is the length of a frame at time
    // zero, and outside integer fps that is a microsecond off the span here —
    // clamping to it would put the end off the grid all by itself.
    const minEnd = start + frameSpanUs(start, 1, fps);
    let maxEnd = Number.MAX_SAFE_INTEGER;
    if (isMediaClip(clip)) {
      const assetDur = assetDurations.get(clip.assetId);
      if (assetDur !== undefined) {
        // The source limit is a raw container duration (ffprobe: 7.307300 s) —
        // NOT a frame boundary. Floor it to a whole frame span from this clip's
        // start; clamping the drag to the unfloored value is what pushed the
        // clip's end off the grid and its export to HTTP 422.
        maxEnd =
          start +
          floorDurationToFrameSpan(
            start,
            clipTimelineDurationUs(clip.sourceInUs, assetDur, clip.speed.rate),
            fps,
          );
      }
    }
    if (effectiveMode === 'normal' && next) maxEnd = Math.min(maxEnd, next.timelineStartUs);
    if (maxEnd < minEnd) return fail('no room to trim');
    target = clamp(target, minEnd, maxEnd);

    const oldEnd = clipEndUs(clip);
    let newEnd: MicroSec;
    if (isMediaClip(clip)) {
      newEnd = trimMediaRight(clip, target, maxEnd, minDur, assetDurations.get(clip.assetId), fps);
    } else {
      // No source to run out of, but the same grid rule: the length is a whole
      // frame span from the start (rate 1 makes the source span its identity).
      const fitted = fitSpanFromStart(
        start,
        target - start,
        maxEnd - start,
        1,
        Number.MAX_SAFE_INTEGER,
        fps,
      );
      const newDur = fitted?.durationUs ?? target - start;
      clip.timelineDurationUs = newDur;
      remapKeyframes(clip, 0, newDur);
      clampAudioFadesToDuration(clip);
      newEnd = start + newDur;
    }
    if (effectiveMode === 'ripple'
      && !rippleFollowers(track, clipIndex + 1, oldEnd, newEnd, fps, assetDurations)) {
      return fail('no room to ripple the following clips');
    }
    return okWith(
      transitionReconcileNotice(reconcileTransitions(track, fps, assetDurations)),
    );
  }

  // edge === 'left'
  const end = clipEndUs(clip);
  // Last frame boundary before the end: a clip has to keep one whole frame,
  // and with the end anchored that minimum is a grid position, not `minDur`.
  const maxStart = frameToUs(Math.max(0, usToFrame(end, fps) - 1), fps);
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
      trimMediaLeft(clip, target, 0, minDur, 'start', fps);
      if (!rippleFollowers(track, clipIndex + 1, end, clipEndUs(clip), fps, assetDurations)) {
        return fail('no room to ripple the following clips');
      }
    } else {
      trimMediaLeft(clip, target, minStart, minDur, 'end', fps);
    }
  } else {
    const oldDur = clip.timelineDurationUs;
    if (effectiveMode === 'ripple') {
      // Start pinned: the END is the edge that has to stay on the grid.
      const fitted = fitSpanFromStart(
        clip.timelineStartUs,
        end - target,
        Number.MAX_SAFE_INTEGER,
        1,
        Number.MAX_SAFE_INTEGER,
        fps,
      );
      const newDur = fitted?.durationUs ?? end - target;
      clip.timelineDurationUs = newDur;
      remapKeyframes(clip, newDur - oldDur, newDur);
      clampAudioFadesToDuration(clip);
      if (!rippleFollowers(track, clipIndex + 1, end, clipEndUs(clip), fps, assetDurations)) {
        return fail('no room to ripple the following clips');
      }
    } else {
      // End pinned: the new START is the edge that has to stay on the grid.
      const fitted = fitSpanToEnd(
        end,
        end - target,
        end - minStart,
        1,
        Number.MAX_SAFE_INTEGER,
        fps,
      );
      const newDur = fitted?.durationUs ?? end - target;
      clip.timelineStartUs = end - newDur;
      clip.timelineDurationUs = newDur;
      remapKeyframes(clip, newDur - oldDur, newDur);
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
 *
 * linkId rule: the SECOND half never inherits the bond. The left half plus the
 * untouched partner are still exactly 2 members (invariant rule 10 holds even
 * when only one side of a pair splits); when BOTH sides split, splitAtPlayhead
 * mints one fresh shared linkId for the two right halves afterwards. groupId
 * DOES stay on the second half — a group only grows, which rule 11 allows.
 * `secondId` reports the freshly minted right half for that re-pairing.
 */
function applySplitToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  timeUs: MicroSec,
  assetDurations: ReadonlyMap<string, MicroSec> = knownAssetDurations(),
): OpResult & { secondId?: Uuid } {
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
    delete b.linkId; // see the header note — the right half is born unlinked
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
  return { ...okWith(transitionReconcileNotice(report)), secondId: second.id };
}

export function splitClipAt(clipId: Uuid, timeUs: MicroSec): OpResult {
  let result: OpResult = fail('unchanged');
  const durations = knownAssetDurations();
  useDocStore.getState().mutate('split', 'Klip bölündü', (d) => {
    result = applySplitToDraft(d, clipId, timeUs, durations);
  });
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
  // Link closure: splitting a clip splits its AV partner too — but only where
  // the cut actually falls inside the partner (applySplitToDraft refuses the
  // rest per clip, which is fine: one-sided splits keep the invariant, see its
  // header note).
  const targets = expandSelectionForOp(d, playheadTargets(d, t, selection), 'link');
  if (targets.length === 0) return fail('no clip under playhead');

  const durations = knownAssetDurations();
  const tx = useDocStore.getState().beginTransaction('split', targets.length === 1 ? 'Klip bölündü' : `${targets.length} klip bölündü`);
  let any = false;
  // linkId of the ORIGINAL pair -> ids of the right halves born from it.
  const rightHalvesByLink = new Map<string, Uuid[]>();
  for (const id of targets) {
    tx.update((dd) => {
      const loc = locateClip(dd, id);
      const linkId = loc !== null && isMediaClip(loc.clip) ? loc.clip.linkId : undefined;
      const r = applySplitToDraft(dd, id, t, durations);
      if (r.ok) {
        any = true;
        if (linkId !== undefined && r.secondId !== undefined) {
          rightHalvesByLink.set(linkId, [...(rightHalvesByLink.get(linkId) ?? []), r.secondId]);
        }
      }
    });
  }
  // BOTH sides of a pair split -> the two right halves form a fresh pair of
  // their own (CapCut behaviour). One-sided splits stay as they are.
  for (const seconds of rightHalvesByLink.values()) {
    if (seconds.length !== 2) continue;
    const freshLinkId = uuidv7();
    tx.update((dd) => {
      for (const id of seconds) {
        const loc = locateClip(dd, id);
        if (loc !== null && isMediaClip(loc.clip)) loc.clip.linkId = freshLinkId;
      }
    });
  }
  tx.commit();
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
 * 'linked clip is on a locked track' when deleting exactly `deletable` would
 * orphan a link pair, else null.
 *
 * The deletable set is the CLOSED selection minus locked/missing clips, so a
 * deletable clip whose partner is not in the set can only mean the partner
 * sits on a locked track. Half-deleting the pair would leave a single-member
 * linkId (invariant rule 10) — the whole delete refuses instead (all or
 * nothing; a silent half-delete is exactly the forbidden quiet repair).
 */
function lockedLinkPartnerBlockReason(d: TimelineDoc, deletable: readonly Uuid[]): string | null {
  const removing = new Set(deletable);
  for (const id of deletable) {
    const loc = locateClip(d, id);
    if (loc === null || !isMediaClip(loc.clip) || loc.clip.linkId === undefined) continue;
    const partner = findLinkPartner(d, loc.clip);
    if (partner !== null && !removing.has(partner.clip.id)) {
      return 'linked clip is on a locked track';
    }
  }
  return null;
}

/**
 * Why `clipIds` cannot be deleted, or null.
 *
 * Same contract as trackDeleteBlockReason/detachAudioBlockReason: the context
 * menu greys the item out with EXACTLY the rule deleteClips enforces —
 * including the link closure and its locked-partner refusal.
 */
export function deleteBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  const deletable = deletableClipIds(d, expandSelectionForOp(d, clipIds, 'link'));
  if (deletable.length === 0) return 'nothing to delete';
  return lockedLinkPartnerBlockReason(d, deletable);
}

export function deleteClips(clipIds: readonly Uuid[], opts: { ripple?: boolean } = {}): OpResult {
  const d = doc();
  // Link closure inside the op: deleting one half of an AV pair deletes the
  // other half too, whoever the caller is (Delete key, menu, cut).
  const deletable = deletableClipIds(d, expandSelectionForOp(d, clipIds, 'link'));
  if (deletable.length === 0) return fail('nothing to delete');
  const lockedPartner = lockedLinkPartnerBlockReason(d, deletable);
  if (lockedPartner !== null) return fail(lockedPartner);
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
    // Same mutate = same undo entry: groups the deletion shrank below 2
    // members dissolve here, not in a follow-up write (rule 11).
    cleanupShrunkenGroups(dd);
  });

  const editor = useEditorStore.getState();
  const nextSelection = [...editor.selection].filter((id) => !removing.has(id));
  editor.setSelection(nextSelection);
  return okWith(transitionReconcileNotice(report));
}

// ---------------------------------------------------------------------------
// Link (AV pair) ops: selection closure + linkClips / unlinkClips (ozellik-2)
// ---------------------------------------------------------------------------

/** Which relations an op's selection closure follows. */
export type SelectionScope = 'move' | 'link';

/**
 * Closes `ids` over the document's link — and, for 'move', group — relations.
 *
 *  - 'link': adds the linkId partner of every given clip (delete/split/link).
 *  - 'move': adds every member of the given clips' groups AND their link
 *    partners. ONE document pass suffices: link partners carry an IDENTICAL
 *    groupId (invariant rule 10), so a group member's partner is always inside
 *    the same group and a given clip's partner never opens a new group —
 *    there is nothing a second round could discover.
 *
 * Order contract: the given ids come first IN THEIR ORDER (the drag code puts
 * the grabbed anchor at index 0 and planMoveClips snaps against clipIds[0]);
 * discovered clips are APPENDED in document order. Unknown ids pass through
 * untouched — whether a stale id blocks the op stays the op's own decision.
 *
 * Group ops land in a later slice, but the helper handles groupId NOW so the
 * move path has one closure rule, not a versioned pair of them.
 */
export function expandSelectionForOp(
  d: TimelineDoc,
  ids: readonly Uuid[],
  scope: SelectionScope,
): Uuid[] {
  const seen = new Set(ids);
  const linkIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const id of ids) {
    const loc = locateClip(d, id);
    if (loc === null) continue;
    if (isMediaClip(loc.clip) && loc.clip.linkId !== undefined) linkIds.add(loc.clip.linkId);
    if (scope === 'move' && loc.clip.groupId !== undefined) groupIds.add(loc.clip.groupId);
  }
  if (linkIds.size === 0 && groupIds.size === 0) return [...ids];
  const out = [...ids];
  for (const track of d.tracks) {
    for (const clip of track.clips) {
      if (seen.has(clip.id)) continue;
      const linked = isMediaClip(clip) && clip.linkId !== undefined && linkIds.has(clip.linkId);
      const grouped = clip.groupId !== undefined && groupIds.has(clip.groupId);
      if (linked || grouped) {
        seen.add(clip.id);
        out.push(clip.id);
      }
    }
  }
  return out;
}

/** The OTHER member of `clip`'s link pair, or null (dangling = validation bug). */
function findLinkPartner(d: TimelineDoc, clip: MediaClip): ClipLocation | null {
  if (clip.linkId === undefined) return null;
  for (let ti = 0; ti < d.tracks.length; ti++) {
    const track = d.tracks[ti];
    for (let ci = 0; ci < track.clips.length; ci++) {
      const c = track.clips[ci];
      if (c.id !== clip.id && isMediaClip(c) && c.linkId === clip.linkId) {
        return { track, trackIndex: ti, clip: c, clipIndex: ci };
      }
    }
  }
  return null;
}

/** Deletes groupId from the members of groups that fell below 2 (rule 11). */
function cleanupShrunkenGroups(dd: TimelineDoc): void {
  const counts = new Map<string, number>();
  for (const track of dd.tracks) {
    for (const clip of track.clips) {
      if (clip.groupId !== undefined) {
        counts.set(clip.groupId, (counts.get(clip.groupId) ?? 0) + 1);
      }
    }
  }
  for (const track of dd.tracks) {
    for (const clip of track.clips) {
      if (clip.groupId !== undefined && (counts.get(clip.groupId) ?? 0) < 2) {
        delete clip.groupId;
      }
    }
  }
}

/**
 * Why `clipIds` cannot be linked into an AV pair, or null.
 *
 * Judged on the CLOSED selection: a selected clip drags its existing partner
 * into the count, so "video already linked elsewhere + some audio" reads as 3
 * clips and fails the pair-shape rule, while selecting an intact pair (or one
 * half of it) closes to exactly that pair and reports 'clip is already
 * linked' — the message that tells the user the remedy is unlink first.
 */
export function linkBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  const ids = expandSelectionForOp(d, clipIds, 'link');
  const locs: ClipLocation[] = [];
  for (const id of ids) {
    const loc = locateClip(d, id);
    if (loc !== null) locs.push(loc);
  }
  if (locs.length !== 2) return 'select a video and an audio clip to link';
  const [a, b] = locs;
  const kinds = [a.clip.kind, b.clip.kind].sort();
  if (
    !isMediaClip(a.clip) ||
    !isMediaClip(b.clip) ||
    kinds[0] !== 'audio' ||
    kinds[1] !== 'video'
  ) {
    return 'select a video and an audio clip to link';
  }
  if (a.clip.linkId !== undefined || b.clip.linkId !== undefined) return 'clip is already linked';
  if (
    a.clip.groupId !== undefined &&
    b.clip.groupId !== undefined &&
    a.clip.groupId !== b.clip.groupId
  ) {
    return 'clips are in different groups';
  }
  if (a.track.locked || b.track.locked) return 'track is locked';
  return null;
}

/**
 * Bonds one video and one audio clip into an AV pair (fresh shared linkId).
 * Invariant rule 10's group-consistency arm is written here, not just checked:
 * when exactly one of the two is grouped, the partner JOINS that group.
 */
export function linkClips(clipIds: readonly Uuid[]): OpResult {
  const d = doc();
  const blocked = linkBlockReason(d, clipIds);
  if (blocked !== null) return fail(blocked);
  // The block reason proved the closed set LOCATES exactly 2 clips — address
  // those two (a stale id in the selection must not shift the pair).
  const ids = expandSelectionForOp(d, clipIds, 'link').filter((id) => locateClip(d, id) !== null);
  const linkId = uuidv7();
  useDocStore.getState().mutate('link', 'Klipler bağlandı', (dd) => {
    const a = locateClip(dd, ids[0])?.clip;
    const b = locateClip(dd, ids[1])?.clip;
    if (a === undefined || b === undefined || !isMediaClip(a) || !isMediaClip(b)) return;
    a.linkId = linkId;
    b.linkId = linkId;
    const groupId = a.groupId ?? b.groupId;
    if (groupId !== undefined) {
      a.groupId = groupId;
      b.groupId = groupId;
    }
  });
  return OK;
}

/** Why `clipIds` cannot be unlinked, or null (same closure as unlinkClips). */
export function unlinkBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  const ids = expandSelectionForOp(d, clipIds, 'link');
  const linked: ClipLocation[] = [];
  for (const id of ids) {
    const loc = locateClip(d, id);
    if (loc !== null && isMediaClip(loc.clip) && loc.clip.linkId !== undefined) linked.push(loc);
  }
  if (linked.length === 0) return 'no linked clip in selection';
  if (linked.some((l) => l.track.locked)) return 'track is locked';
  return null;
}

/**
 * Dissolves every link pair the selection touches. The closure guarantees BOTH
 * members are in the set, so no write can leave a single-member linkId behind.
 * groupId is untouched — ungrouping is its own op (later slice).
 */
export function unlinkClips(clipIds: readonly Uuid[]): OpResult {
  const d = doc();
  const blocked = unlinkBlockReason(d, clipIds);
  if (blocked !== null) return fail(blocked);
  const ids = expandSelectionForOp(d, clipIds, 'link');
  useDocStore.getState().mutate('unlink', 'Bağlantı kaldırıldı', (dd) => {
    for (const id of ids) {
      const loc = locateClip(dd, id);
      if (loc !== null && isMediaClip(loc.clip)) delete loc.clip.linkId;
    }
  });
  return OK;
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

// ---------------------------------------------------------------------------
// Derleyicinin reddettiği BİLEŞİMLER — editör tarafı ön engeller
// ---------------------------------------------------------------------------
/*
 * Aşağıdaki üç kural ffmpeg derleyicisinde TİPLİ HATA'dır (ExportCompiler):
 *   1. geçişli kesimin iki klibinden birinde GÖRSEL keyframe  -> UnsupportedFeature
 *      ("transition-keyframes"): geçişte iki klip TEK xfade akışına katlanır, akışın
 *      yerleşimi kesim boyunca sabit olmak zorundadır.
 *   2. ÖLÇEK keyframe'i + DÖNME (taban açı ya da dönme keyframe'i) -> UnsupportedFeature
 *      ("scale-keyframes-with-rotation"): rotate çıkış tuvalini config anında bir kez
 *      kurar, büyüyen katmanı sessizce KIRPAR.
 *   3. geçişli iki klibin YERLEŞİMİ farklı -> InvalidTimeline: xfade iki girişin aynı
 *      boyutta olmasını şart koşar.
 * Editör bu bileşimleri kurdurursa kullanıcı ancak dışa aktarımda (422) öğrenir —
 * "yönlendir sonra reddet". Bu yüzden her biri BURADA, op'un kendi ret kuralı olarak
 * durur; menü/panel `*BlockReason` üzerinden aynı kuralı okur ve teklif etmez.
 *
 * 3 numaralı kural ENGEL değil YAYILIM ile karşılanır (bkz. propagateTransformToChain).
 */

/**
 * Görsel animasyon kanalları — derleyicideki `ClipAnimation.Any` ile AYNI küme.
 * `volume` bilinçli olarak DIŞARIDA: ses zincirine aittir, katman akışını hiç
 * ilgilendirmez, dolayısıyla geçişli klipte de serbesttir.
 */
const VISUAL_KEYFRAME_CHANNELS = ['x', 'y', 'scale', 'rotationDeg', 'opacity'] as const;

type VisualKeyframeChannel = (typeof VISUAL_KEYFRAME_CHANNELS)[number];

/** Geçişli kesime keyframe'li klip giremez (derleyici: "transition-keyframes"). */
export const REASON_TRANSITION_NEEDS_STATIC_CLIPS = 'a keyframed clip cannot take a transition';
/** Geçişli klipte görsel kanal animasyonlanamaz (aynı kuralın klip tarafı). */
export const REASON_KEYFRAME_NEEDS_NO_TRANSITION = 'the clip has a transition';
/** Ölçek animasyonu + dönme (derleyici: "scale-keyframes-with-rotation"). */
export const REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION =
  'scale keyframes cannot be combined with rotation';
/** Aynı kuralın dönme tarafı: ölçek animasyonluyken dönme yazılamaz. */
export const REASON_ROTATION_NEEDS_STATIC_SCALE =
  'rotation cannot be combined with scale keyframes';

/** Yerleşim, geçişli komşulara da uygulandı (sessiz değil — OpResult.notice). */
export const TRANSFORM_APPLIED_TO_TRANSITION_CHAIN = 'transform applied to transition neighbours';

/**
 * Dönme yazımı, mevcut ölçeği dönmeli ara-tuval tavanının ÜSTÜNDE bıraktı ve
 * op ölçeği tavana indirdi (OpResult.notice). Sessiz kalsaydı belge derleyicinin
 * `transform-scale` kapısına (HTTP 422) takılırdı; reddetseydik dönme alanı
 * "nedensiz" kilitlenirdi — geçişlerdeki "kısalt ve söyle" ürün kararının aynısı.
 */
export const SCALE_CLAMPED_BY_ROTATION = 'scale clamped by rotation canvas';

function channelHasKeyframes(clip: Clip, channel: VisualKeyframeChannel): boolean {
  const kfs = clip.keyframes[channel];
  return kfs !== undefined && kfs.length > 0;
}

/** Katman akışını etkileyen (görsel) bir animasyonu var mı? */
export function clipHasVisualKeyframes(clip: Clip): boolean {
  return VISUAL_KEYFRAME_CHANNELS.some((c) => channelHasKeyframes(clip, c));
}

/** Klibin herhangi bir kenarında geçiş var mı? */
export function clipHasTransition(clip: Clip): boolean {
  return (
    isMediaClip(clip) && (clip.transitionIn !== undefined || clip.transitionOut !== undefined)
  );
}

/**
 * Katman DÖNÜYOR mu? Derleyicinin kuralı `rotationDeg % 360 != 0` (360'ın katları
 * rotate filtresi üretmez) VEYA dönme kanalı animasyonlu.
 */
export function clipRotationIsActive(clip: Clip): boolean {
  return clip.transform.rotationDeg % 360 !== 0 || channelHasKeyframes(clip, 'rotationDeg');
}

export function clipHasScaleKeyframes(clip: Clip): boolean {
  return channelHasKeyframes(clip, 'scale');
}

/**
 * Geçişlerle BİRBİRİNE BAĞLI kliplerin (aynı track, ardışık) indeks aralığı.
 *
 * Geçiş bir EŞDEĞERLİK sınıfı kurar: A—B geçişliyse ikisinin yerleşimi aynı olmak
 * zorundadır; B—C de geçişliyse zincir C'ye kadar uzar. Yerleşim yazarken bu
 * zincirin TAMAMI güncellenir, aksi halde ilk komşuyu düzeltip ikincisini bozardık.
 */
function transitionChainRange(track: Track, index: number): { lo: number; hi: number } {
  const clips = track.clips;
  const joined = (i: number): boolean => {
    const a = clips[i];
    const b = clips[i + 1];
    if (a === undefined || b === undefined) return false;
    if (!isMediaClip(a) || !isMediaClip(b)) return false;
    if (a.transitionOut === undefined || b.transitionIn === undefined) return false;
    // Kopmuş kesimde (araya boşluk girmiş) geçiş metadata'sı bayat olabilir;
    // reconcile onu düşürene kadar zinciri BURADA da kesiyoruz.
    return clipEndUs(a) === b.timelineStartUs;
  };
  let lo = index;
  while (lo > 0 && joined(lo - 1)) lo--;
  let hi = index;
  while (hi < clips.length - 1 && joined(hi)) hi++;
  return { lo, hi };
}

/** `clipId` ile aynı geçiş zincirindeki DİĞER kliplerin id'leri (yoksa boş). */
export function transitionChainSiblings(d: TimelineDoc, clipId: Uuid): Uuid[] {
  const loc = locateClip(d, clipId);
  if (!loc) return [];
  const { lo, hi } = transitionChainRange(loc.track, loc.clipIndex);
  const out: Uuid[] = [];
  for (let i = lo; i <= hi; i++) {
    const c = loc.track.clips[i];
    if (c !== undefined && c.id !== clipId) out.push(c.id);
  }
  return out;
}

/**
 * Yazılan yerleşimi geçiş zincirinin TAMAMINA kopyalar (§5.2 "geçişli kliplerin
 * yerleşimi aynı olmalı").
 *
 * ENGELLEMEK yerine YAYMAK bilinçli bir seçim: derleyicinin kuralı "yerleşim
 * VARSAYILAN olsun" değil "EŞİT olsun"dur. Engelleseydik geçiş eklenen bir sahne
 * bir daha hiç ölçeklenemez/konumlanamazdı (yaygın bir düzenleme tamamen kaybolurdu);
 * yaymak ise kuralı BİREBİR karşılar ve yeteneği korur. Medya kliplerinde yerleşim
 * yalnız transform'dan türer (LayerGeometry fit kutusu proje tuvalidir), dolayısıyla
 * transform'un eşitliği yerleşimin eşitliğini GARANTİ eder. Kopya sessiz değildir:
 * op `TRANSFORM_APPLIED_TO_TRANSITION_CHAIN` bildirimi döner ve panel bunu önceden
 * yazar.
 *
 * DÖNÜŞ DEĞERİ: "kopyalandı" değil, "bir komşu GERÇEKTEN DEĞİŞTİ". Aradaki fark
 * bildirimin doğruluğudur: zincirdeki klipler zaten aynı yerleşimdeyse (geçiş
 * eklemenin olağan hali — iki klip de varsayılan dönüşümde) kullanıcıya
 * "yerleşim komşuya da uygulandı" demek, olmamış bir komşu düzenlemesini haber
 * vermektir. Bildirim ancak komşunun yerleşimi gerçekten kaydığında çıkar.
 */
function propagateTransformToChain(d: TimelineDoc, clipId: Uuid): boolean {
  const loc = locateClip(d, clipId);
  if (!loc) return false;
  const { lo, hi } = transitionChainRange(loc.track, loc.clipIndex);
  if (lo === hi) return false;
  let copied = false;
  for (let i = lo; i <= hi; i++) {
    const other = loc.track.clips[i];
    if (other === undefined || other.id === clipId) continue;
    if (transformsEqual(other.transform, loc.clip.transform)) continue;
    other.transform = { ...loc.clip.transform };
    copied = true;
  }
  return copied;
}

/**
 * Dönme yazılamamasının gerekçesi (ölçek animasyonlu klip), yoksa null.
 *
 * `clipIds` op'a verilen seçimdir; kapı YALNIZ op'un gerçekten yazacağı kliplere
 * bakar (kilitli track / görsel olmayan klip zaten atlanır) — aksi halde seçimdeki
 * bir ses klibi yüzünden geçerli bir düzenleme reddedilirdi.
 */
export function rotationBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    if (!isVisualClip(loc.clip)) continue;
    if (clipHasScaleKeyframes(loc.clip)) return REASON_ROTATION_NEEDS_STATIC_SCALE;
  }
  return null;
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
  // Geçiş + keyframe: derleyici bu bileşimi reddeder (dosya başındaki kural 1).
  // Kesimin İKİ tarafına da bakılır — animasyon hangi tarafta olursa olsun iki
  // klip tek xfade akışına katlanır.
  if (clipHasVisualKeyframes(cut.a) || clipHasVisualKeyframes(cut.b)) {
    return REASON_TRANSITION_NEEDS_STATIC_CLIPS;
  }
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
 * One op, two things worth reporting, ONE `notice` slot: `primary` wins.
 *
 * Adding a transition can both shorten the requested duration AND re-lay-out
 * the neighbour, so the two have to be ranked. The shortening is legible
 * without any bubble — the transition editor opens on that very cut with the
 * effective duration in its "Süre (sn)" field — while a neighbouring clip's
 * scale changing leaves no other trace on screen. The invisible one is
 * therefore the primary.
 */
function preferNotice(primary: string | undefined, fallback: string | undefined): string | undefined {
  return primary ?? fallback;
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
    // ADDING a transition is a layout write too — this is the ONLY moment the
    // two clips become one xfade stream, and until it happened they were free
    // to be laid out differently. Propagating only from the transform ops
    // (setClipTransform / resetClipTransform) covered the order "transition
    // first, then scale" and MISSED the reverse one: split -> scale A -> add
    // transition left A at scale 2 next to B at scale 1, the editor stayed
    // silent, the document saved, and the render worker failed the job with
    // "geçişli kliplerin yerleşimi aynı olmalıdır". The chain is aligned from
    // the OUTGOING clip, the same side that wins everywhere else on a cut.
    const chained = propagateTransformToChain(dd, clipAId);
    result = okWith(
      preferNotice(chained ? TRANSFORM_APPLIED_TO_TRANSITION_CHAIN : undefined, planNotice(plan)),
    );
  });
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
  return result;
}

// ---------------------------------------------------------------------------
// Clipboard: copy / cut / paste / duplicate
// ---------------------------------------------------------------------------

interface ClipboardEntry {
  /** The copied clip, with its ORIGINAL timelineStartUs — paste re-derives the
   *  batch's internal offsets from these starts IN FRAMES (see planPasteAt). */
  clip: Clip;
  trackId: Uuid;
}

let clipboard: ClipboardEntry[] | null = null;

/** Test hook / paranoia: reset module clipboard. */
export function clearClipboardForTests(): void {
  clipboard = null;
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
  for (const id of clipIds) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    entries.push({ clip: cloneClip(loc.clip), trackId: loc.track.id });
  }
  if (entries.length === 0) return false;
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
  useEditorStore.getState().setSelection(batch.map((b) => b.clip.id));
  return OK;
}

/**
 * One landing spot a paste/duplicate wants to fill: the SOURCE clip (not yet
 * cloned), the destination track, and the grid re-fit at the new start. The
 * refit fields mirror MovePlan's — the length follows the grid and the source
 * window follows the length (see refitToGrid); both are usually identity.
 */
interface RelocatedClip {
  clip: Clip;
  trackId: Uuid;
  startUs: MicroSec;
  durationUs: MicroSec;
  newSourceInUs?: MicroSec;
  newSourceOutUs?: MicroSec;
}

type BatchPlanResult = { ok: true; items: RelocatedClip[] } | { ok: false; reason: string };

/**
 * Re-position a batch of source clips by a uniform whole-FRAME delta — the
 * moveClips discipline (planMoveClips/rippleFollowers), reused for paste and
 * duplicate.
 *
 * Placing copies at "start + raw microsecond offset" is what this replaces:
 * outside integer-fps-friendly lengths the grid is not closed under addition,
 * so a duplicate of a 140-frame clip at 30 fps put at `end = start + duration`
 * landed its OWN end 1 us off the grid — the document saved fine (PUT 200) and
 * the export refused it (HTTP 422), i.e. an ordinary Ctrl+D/Ctrl+V produced an
 * unexportable project. Walking in FRAMES (usToFrame difference -> frameToUs,
 * via shiftedStartUs) keeps every copy's start on the grid, and refitToGrid
 * preserves the frame COUNT while deriving the microsecond length from the
 * grid at the new start. An off-grid legacy clip keeps the raw microsecond
 * delta instead — exactly the move op's rule for it.
 */
function planRelocatedBatch(
  sources: readonly { clip: Clip; trackId: Uuid }[],
  frameDelta: number,
  deltaUs: MicroSec,
  fps: Rational,
  assetDurations: ReadonlyMap<string, MicroSec>,
): BatchPlanResult {
  const items: RelocatedClip[] = [];
  for (const s of sources) {
    const startUs = shiftedStartUs(s.clip, frameDelta, deltaUs, fps);
    const refit = refitToGrid(s.clip, startUs, fps, assetDurations);
    if (refit === null) return { ok: false, reason: 'clip cannot keep its frame span here' };
    items.push({
      clip: s.clip,
      trackId: s.trackId,
      startUs,
      durationUs: refit.durationUs,
      newSourceInUs: refit.sourceInUs,
      newSourceOutUs: refit.sourceOutUs,
    });
  }
  return { ok: true, items };
}

/** The placement rows (track/overlap rules) a planned batch asks for. */
function relocatedPlacements(items: readonly RelocatedClip[]): ClipPlacement[] {
  return items.map((p) => ({
    trackId: p.trackId,
    kind: p.clip.kind,
    startUs: p.startUs,
    durationUs: p.durationUs,
  }));
}

/**
 * Clone a planned source into an insert-ready clip: fresh id, refit applied,
 * fades re-clamped. The re-fit's +-1 us length wobble can also push a keyframe
 * sitting EXACTLY on the old end past the new one (invariant rule 4), so a
 * SHRINK re-runs the right-trim keyframe rule (shift 0, out-of-range dropped).
 */
function materializeRelocatedClip(p: RelocatedClip): Clip {
  const clip = cloneClip(p.clip);
  clip.id = uuidv7();
  clip.timelineStartUs = p.startUs;
  clip.timelineDurationUs = p.durationUs;
  if (p.newSourceInUs !== undefined && isMediaClip(clip)) {
    clip.sourceInUs = p.newSourceInUs;
    clip.sourceOutUs = p.newSourceOutUs!;
  }
  if (p.durationUs < p.clip.timelineDurationUs) remapKeyframes(clip, 0, p.durationUs);
  clampAudioFadesToDuration(clip);
  return clip;
}

/**
 * Where the clipboard would land if pasted at `timeUs`, grid re-fit included
 * (pure). The batch keeps its internal offsets IN FRAMES from the earliest
 * copied clip; that clip lands exactly on the (snapped) paste point. SINGLE
 * plan for Ctrl+V: pasteBlockReason greys the menu with it and pasteAtPlayhead
 * commits it, so the menu and the op can never disagree.
 */
function planPasteAt(d: TimelineDoc, timeUs: MicroSec): BatchPlanResult {
  if (!clipboard || clipboard.length === 0) return { ok: false, reason: 'clipboard empty' };
  const fps = d.settings.fps;
  const baseUs = snapUsToFrameGrid(timeUs, fps);
  let minStartUs = Number.MAX_SAFE_INTEGER;
  for (const e of clipboard) minStartUs = Math.min(minStartUs, e.clip.timelineStartUs);
  return planRelocatedBatch(
    clipboard.map((e) => ({ clip: e.clip, trackId: e.trackId })),
    usToFrame(baseUs, fps) - usToFrame(minStartUs, fps),
    baseUs - minStartUs,
    fps,
    knownAssetDurations(),
  );
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
  const plan = planPasteAt(d, timeUs);
  if (!plan.ok) return plan.reason;
  return placementBlockReason(d, relocatedPlacements(plan.items));
}

/**
 * Re-mints the shared ids of a freshly CLONED batch (paste/duplicate) so the
 * copies bond with each other, never with the originals:
 *
 *  - a linkId/groupId seen >= 2 times in the batch maps to ONE fresh uuid —
 *    a copied pair (or group) stays a pair among the copies;
 *  - a value seen once is DELETED — half a pair was copied, and a copy that
 *    still pointed at the original's bond would be a dangling linkId (rule 10)
 *    or an uninvited group member.
 *
 * Runs on the materialized clones, batch-wide, so `cloneClip` itself keeps the
 * ORIGINAL ids — the clipboard must carry them for exactly this remap to see
 * which copies belong together.
 */
function remintLinkAndGroupIds(clips: readonly Clip[]): void {
  const linkCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const clip of clips) {
    if (isMediaClip(clip) && clip.linkId !== undefined) {
      linkCounts.set(clip.linkId, (linkCounts.get(clip.linkId) ?? 0) + 1);
    }
    if (clip.groupId !== undefined) {
      groupCounts.set(clip.groupId, (groupCounts.get(clip.groupId) ?? 0) + 1);
    }
  }
  const remap = (map: Map<string, string>, old: string): string => {
    const hit = map.get(old);
    if (hit !== undefined) return hit;
    const fresh = uuidv7();
    map.set(old, fresh);
    return fresh;
  };
  const linkMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const clip of clips) {
    if (isMediaClip(clip) && clip.linkId !== undefined) {
      if ((linkCounts.get(clip.linkId) ?? 0) >= 2) clip.linkId = remap(linkMap, clip.linkId);
      else delete clip.linkId;
    }
    if (clip.groupId !== undefined) {
      if ((groupCounts.get(clip.groupId) ?? 0) >= 2) clip.groupId = remap(groupMap, clip.groupId);
      else delete clip.groupId;
    }
  }
}

/** Ctrl+V: paste the clipboard at the playhead (original tracks, frame offsets kept). */
export function pasteAtPlayhead(timeUs?: MicroSec): OpResult {
  const d = doc();
  const at = timeUs ?? useEditorStore.getState().playheadUs;
  const plan = planPasteAt(d, at);
  if (!plan.ok) return fail(plan.reason);
  const batch = plan.items.map((p) => ({ clip: materializeRelocatedClip(p), trackId: p.trackId }));
  remintLinkAndGroupIds(batch.map((b) => b.clip));
  return insertBatch('paste', `${batch.length} klip yapıştırıldı`, batch);
}

/**
 * Where duplicates of `clipIds` would land — right after the selection's whole
 * span, same tracks, the span measured IN FRAMES (pure). Shared by
 * duplicateBlockReason and duplicateClips for the same reason as planPasteAt.
 */
function planDuplicate(d: TimelineDoc, clipIds: readonly Uuid[]): BatchPlanResult {
  let minStartUs = Number.MAX_SAFE_INTEGER;
  let maxEndUs = 0;
  const sources: { clip: Clip; trackId: Uuid }[] = [];
  for (const id of clipIds) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    minStartUs = Math.min(minStartUs, loc.clip.timelineStartUs);
    maxEndUs = Math.max(maxEndUs, clipEndUs(loc.clip));
    sources.push({ clip: loc.clip, trackId: loc.track.id });
  }
  if (sources.length === 0) return { ok: false, reason: 'nothing to duplicate' };
  const fps = d.settings.fps;
  return planRelocatedBatch(
    sources,
    usToFrame(maxEndUs, fps) - usToFrame(minStartUs, fps),
    maxEndUs - minStartUs,
    fps,
    knownAssetDurations(),
  );
}

/**
 * Why `clipIds` cannot be duplicated, or null.
 *
 * This closes the "menu offers what the op refuses" hole: a clip whose
 * neighbour sits immediately after it has NO room for its duplicate, so the
 * menu greys "Çoğalt" out instead of showing a warning bubble on click.
 */
export function duplicateBlockReason(d: TimelineDoc, clipIds: readonly Uuid[]): string | null {
  const plan = planDuplicate(d, clipIds);
  if (!plan.ok) return plan.reason;
  return placementBlockReason(d, relocatedPlacements(plan.items));
}

/** Ctrl+D: duplicate the selection right after its own span, same tracks. */
export function duplicateClips(clipIds: readonly Uuid[]): OpResult {
  const d = doc();
  const plan = planDuplicate(d, clipIds);
  if (!plan.ok) return fail(plan.reason);
  const batch = plan.items.map((p) => ({ clip: materializeRelocatedClip(p), trackId: p.trackId }));
  remintLinkAndGroupIds(batch.map((b) => b.clip));
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
/**
 * Stored precision of a gain value. Named — not an inline 4 — because the
 * KEYFRAME path rounds with the same number (`keyframeModel.channelBounds`):
 * a base value and a keyframe on the same property must be reachable at the
 * same values, and two copies of a magic number are how that quietly stops
 * being true.
 */
export const VOLUME_DECIMALS = 4;
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
 *
 * MEDIA / IMAGE / STICKER / SHAPE only. A TEXT layer is not fit to the canvas
 * (§7: its box is its own bbox), so its ceiling comes from `maxClipScaleFor`.
 */
export function maxClipScale(settings: Pick<ProjectSettings, 'width' | 'height'>): number {
  return Math.min(SCALE_MAX, maxScaleFor(settings));
}

/** An unrotated, centered pose — the default when the caller has no clip. */
const CENTERED_POSE: LayerPose = { rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 };

/**
 * Scale ceiling for a layer whose drawn box is `boxWidthPx x boxHeightPx` at
 * `scale = 1` — the general form of `maxClipScale` (which is this with the box
 * = the canvas and no rotation).
 *
 * `pose` is the clip's rotation + anchor: the compiler's ceiling gate measures
 * the INTERMEDIATE canvas, and rotation opens it up to the box's diagonal
 * (an off-center anchor pads it further) — see `maxScaleForFit` in the schema
 * package, which carries the compiler's exact ledger formula. A rotated clip
 * therefore gets a LOWER ceiling here, which is exactly what stops the editor
 * from writing a document `EnsureLayerCeiling` rejects with HTTP 422.
 */
export function maxScaleForBoxPx(
  settings: Pick<ProjectSettings, 'width' | 'height'>,
  boxWidthPx: number,
  boxHeightPx: number,
  pose: LayerPose = CENTERED_POSE,
): number {
  const canvasCeiling = Math.min(
    SCALE_MAX,
    maxScaleForFit(settings.width, settings.height, pose),
  );
  // ONE known axis is enough to bound the layer (the font-independent text
  // lower bound reports width 0 — glyph advances need the font file); only a
  // box with NO usable axis falls back to the canvas ceiling.
  const w = Number.isFinite(boxWidthPx) && boxWidthPx > 0 ? boxWidthPx : 0;
  const h = Number.isFinite(boxHeightPx) && boxHeightPx > 0 ? boxHeightPx : 0;
  if (w === 0 && h === 0) return Math.max(SCALE_MIN, canvasCeiling);
  return Math.max(SCALE_MIN, Math.min(canvasCeiling, maxScaleForFit(w, h, pose)));
}

/**
 * FONT-INDEPENDENT LOWER BOUND of a text clip's §7 bbox, in project px.
 *
 * MIRRORS `ExportCompiler.TextBoxLowerBound` (C#) — same two components, same
 * reasoning: `layoutText` unions the content box, the ink+stroke box and the
 * background box and then rounds OUTWARD, so every component is a lower bound.
 * - height >= contentHeight = fontSizePx * lineHeight * lineCount (the CSS
 *   line-height model; NOT font dependent),
 * - a background grows the box by `paddingPx` on every side.
 * There is NO font-independent lower bound for the WIDTH (glyph advances are a
 * property of the font file), so only the background padding counts there.
 *
 * Used where a REAL measurement is not available: the op layer must not reach
 * up into features/text (Canvas2D), and a bound that can only UNDER-estimate
 * can only ever clamp a value the compiler would certainly reject anyway. The
 * inspector passes the measured bbox instead — see `maxScaleForBoxPx` callers.
 */
export function textBoxLowerBoundPx(text: TextClip['text']): { widthPx: number; heightPx: number } {
  const fontSizePx = Number.isFinite(text.fontSizePx) ? Math.max(0, text.fontSizePx) : 0;
  const lineHeight = Number.isFinite(text.lineHeight) ? Math.max(0, text.lineHeight) : 0;
  const lineCount = splitTextLines(text.content).length;
  const padding = text.background && Number.isFinite(text.background.paddingPx)
    ? Math.max(0, text.background.paddingPx)
    : 0;
  return {
    widthPx: 2 * padding,
    heightPx: fontSizePx * lineHeight * lineCount + 2 * padding,
  };
}

/**
 * Line split of a text content — the ONE rule shared with the export
 * (TextLayoutEngine.SplitLines / features/text/textLayout.splitLines): CRLF and
 * CR normalize to LF, empty content is ONE line (the box keeps its height).
 * Duplicated here rather than imported because `state/` must not depend on
 * `features/` (the browser measurer lives there and drags the DOM in).
 */
function splitTextLines(content: string): string[] {
  if (typeof content !== 'string' || content.length === 0) return [''];
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Scale ceiling for ONE clip.
 *
 * A text layer is drawn at `bbox * scale`, NOT fit to the composition (§7), so
 * its ceiling is `8192 / max(bboxW, bboxH)` and has nothing to do with the
 * canvas: at fontSizePx 2000 a single line is already ~2400 px tall, i.e. the
 * layer tops out around scale 3.4 in ANY project. Deriving the field max from
 * the canvas (as this used to) let the user write scale 4.266, the API queued
 * it and the worker died on it (measured in review).
 *
 * `measuredBoxPx` is the REAL bbox when the caller can measure one (the
 * inspector can — features/text/overlayRaster); without it the font-independent
 * lower bound is used, which can only ever be MORE permissive, never less.
 */
export function maxClipScaleFor(
  clip: Clip,
  settings: Pick<ProjectSettings, 'width' | 'height'>,
  measuredBoxPx?: { widthPx: number; heightPx: number } | null,
): number {
  // ROTATION lowers every ceiling below: the compiler's gate measures the
  // intermediate canvas, and a rotated layer opens one as large as its box's
  // diagonal (rendering-semantics §2.5; ExportCompiler.EnsureLayerCeiling).
  const pose: LayerPose = clip.transform;
  if (clip.kind !== 'text') {
    // Media/image/sticker are fit=contain and a shape's natural box IS the
    // frame (ShapeGeometry.cs) — for all of them the canvas ceiling is exact.
    return Math.max(
      SCALE_MIN,
      Math.min(SCALE_MAX, maxScaleForFit(settings.width, settings.height, pose)),
    );
  }
  const box = measuredBoxPx ?? textBoxLowerBoundPx(clip.text);
  return maxScaleForBoxPx(settings, box.widthPx, box.heightPx, pose);
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
function clipHasAudio(clip: Clip): clip is MediaClip {
  return isMediaClip(clip) && clip.audio !== null;
}

/** Everything except an audio clip is drawn, so everything else has a transform. */
function isVisualClip(clip: Clip): boolean {
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
      const v = clampFinite(patch.volume, VOLUME_MIN, VOLUME_MAX, VOLUME_DECIMALS);
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
  // Dönme + ölçek animasyonu bileşimi (dosya başındaki kural 2). Kapı yazmadan
  // ÖNCE ve TÜM patch için kapanır: yarısı yazılmış bir dönüşüm, kullanıcının
  // "bir kısmı tuttu" diye okuyacağı sessiz bir yarım sonuç olurdu.
  if (patch.rotationDeg !== undefined) {
    const blocked = rotationBlockReason(d, clipIds);
    if (blocked !== null) return fail(blocked);
  }
  let touched = 0;
  let chained = false;
  let scaleClamped = false;
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
    // Dönme ÖNCE yazılır: ölçek tavanı dönmeye bağlıdır (ara tuval köşegeni,
    // maxClipScaleFor) ve iki alan aynı patch'te geldiğinde ölçek YENİ dönmeye
    // göre kelepçelenmelidir — eski sıra, dönen klibe eski (yüksek) tavandan
    // ölçek yazıp belgeyi derleyicinin `transform-scale` kapısına düşürüyordu.
    if (patch.rotationDeg !== undefined) {
      const v = clampFinite(patch.rotationDeg, -ROTATION_LIMIT, ROTATION_LIMIT, ROTATION_DECIMALS);
      if (v !== null) t.rotationDeg = v;
    }
    if (patch.scale !== undefined) {
      // Ceiling is per-CLIP, not a constant and not merely per-project: a text
      // layer is drawn at `bbox * scale`, so a 2000 px font tops out around 3.4
      // even in a project where a video clip may go to 4.266 (see
      // maxClipScaleFor). Rotation lowers it again
      // (intermediate-canvas diagonal).
      const v = clampFinite(patch.scale, SCALE_MIN, maxClipScaleFor(clip, d.settings), SCALE_DECIMALS);
      if (v !== null) t.scale = v;
    }
    // Dönme, MEVCUT ölçeği yeni (daha düşük) tavanın üstünde bırakmış olabilir:
    // ölçek tavana iner ve bunu bildiririz (SCALE_CLAMPED_BY_ROTATION) — sessiz
    // bırakmak, 422'yi dışa aktarımda öğrenmek demekti.
    if (patch.rotationDeg !== undefined) {
      const ceiling = maxClipScaleFor(clip, d.settings);
      if (t.scale > ceiling) {
        t.scale = ceiling;
        scaleClamped = true;
      }
    }
    touched++;
    // Geçiş zinciri: yerleşim EŞİT olmak zorunda (dosya başındaki kural 3).
    if (propagateTransformToChain(d, clipId)) chained = true;
  }
  if (touched === 0) return fail('no visual clip in selection');
  // Ölçek kelepçesi manşettir: kullanıcının istemediği İKİ düzeltmeden daha
  // görünmez olanı odur (zincir kopyası panelde zaten önceden ilan edilir).
  if (scaleClamped) return okWith(SCALE_CLAMPED_BY_ROTATION);
  return chained ? okWith(TRANSFORM_APPLIED_TO_TRANSITION_CHAIN) : OK;
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
  return result;
}

/** "Sıfırla": transform + opacity back to their defaults, ONE history entry. */
export function resetClipTransform(clipIds: readonly Uuid[]): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipTransform', 'Dönüşüm sıfırlandı', (d) => {
    let touched = 0;
    let chained = false;
    for (const clipId of clipIds) {
      const loc = locateClip(d, clipId);
      if (!loc || loc.track.locked) continue;
      if (!isVisualClip(loc.clip)) continue;
      loc.clip.transform = { ...DEFAULT_TRANSFORM };
      loc.clip.opacity = 1;
      touched++;
      // "Sıfırla" da bir yerleşim yazımıdır: zincirin geri kalanı sıfırlanmazsa
      // geçişin iki tarafı ayrışırdı (bkz. propagateTransformToChain).
      if (propagateTransformToChain(d, clipId)) chained = true;
    }
    result =
      touched === 0
        ? fail('no visual clip in selection')
        : chained
          ? okWith(TRANSFORM_APPLIED_TO_TRANSITION_CHAIN)
          : OK;
  });
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
 *
 * The SOURCE must actually carry an audio stream. `buildClipFromAsset` births
 * `audio` non-null on EVERY video clip (the mixer settings exist regardless),
 * so `clip.audio` alone cannot tell a silent video apart — the asset's probe
 * fact (`AssetSummary.hasAudio`, worker ffprobe) can. Without this branch the
 * menu offered "Sesi ayır" on a silent video and the detached audio clip made
 * the export refuse the document with 422 `asset-clip-type` (measured:
 * ExportCompiler `IsTypeMismatch`, "bu videonun ses akışı yok"). Only an
 * EXPLICIT `hasAudio === false` blocks: the API reports the fact only on
 * READY rows, and refusing on "unknown" would contradict the export gate,
 * which also asks the question only where the answer is certain.
 */
export function detachAudioBlockReason(d: TimelineDoc, clipId: Uuid): string | null {
  const loc = locateClip(d, clipId);
  if (!loc) return 'clip not found';
  if (loc.track.locked) return 'track is locked';
  const clip = loc.clip;
  if (!isMediaClip(clip) || clip.kind !== 'video') return 'only a video clip has detachable audio';
  if (clip.audio === null) return 'clip has no embedded audio';
  // A video that already has a link partner cannot detach: the op writes a
  // FRESH linkId to the source, which would overwrite the existing bond and
  // strand the old partner as a single-member linkId (invariant rule 10). The
  // remedy the message names — unlink first — makes the detach legal again.
  if (clip.linkId !== undefined) return 'clip is already linked';
  if (useAssetStore.getState().getAsset(clip.assetId)?.hasAudio === false) {
    return 'source has no audio stream';
  }
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
  // The detached audio is BORN LINKED to its video (ozellik-2): one fresh
  // linkId on both halves, written inside the same mutate (one undo entry).
  // The block reason above guarantees the source carried no previous bond.
  const pairLinkId = uuidv7();
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
    linkId: pairLinkId,
    // Rule 10's group arm: link partners carry an identical groupId.
    ...(source.groupId !== undefined ? { groupId: source.groupId } : {}),
  };
  const newTrack = target ? null : makeTrack('audio', 'Ses');

  useDocStore.getState().mutate('detachAudio', 'Ses ayrıldı', (dd) => {
    const loc = locateClip(dd, clipId);
    if (!loc || !isMediaClip(loc.clip)) return;
    loc.clip.audio = null;
    loc.clip.linkId = pairLinkId;
    delete loc.clip.keyframes.volume;
    if (newTrack !== null) {
      newTrack.clips.push(audioClip);
      dd.tracks.push(newTrack);
      return;
    }
    const t = dd.tracks.find((x) => x.id === target!.id);
    if (t) insertClipSorted(t, audioClip);
  });
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
const OVERLAY_CLIP_DEFAULT_DURATION_US = 5_000_000;

/** Track name used when an overlay clip has to create its own lane. */
const OVERLAY_TRACK_NAME = 'Katman';

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
 * Shared insert path for every overlay kind. The clip is laid out EDGE TO EDGE
 * on the project frame grid — start snapped, length a whole-frame span from
 * that start — and floored at one frame (a sub-frame overlay would be invisible
 * in the export, which is exactly the kind of silent no-op the review gate
 * exists to prevent). Snapping the DURATION instead would put the end off the
 * grid at 30 fps whenever the start sits on a 1/3-microsecond frame.
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
  const durationUs = snapDurationToFrameSpan(
    startUs,
    Math.max(minDur, Math.round(requestedDurationUs)),
    fps,
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
    // from "text does not work". Deliberately NOT insertTrackPositioned (that
    // would land the lane at the bottom of the non-audio section, i.e. behind
    // the footage again); index 0 precedes every audio row, so the partition
    // policy holds here by construction.
    dd.tracks.unshift(newTrack);
  });
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
/**
 * Absolute sanity cap. The EFFECTIVE ceiling is `maxTextSizeFor(clip)`: a font
 * size is only meaningful together with the line count, the background padding
 * and the clip's scale, because those four together decide whether the layer
 * fits in MAX_LAYER_DIMENSION. Bounding the field with this constant alone let
 * a user type 2000 px on a scale-4 clip; the document saved (PUT 200), the API
 * queued the export (202) and the worker died on it (measured in review).
 */
export const TEXT_SIZE_MAX = 2000;
/** Precision a font size is stored with (the inspector field shows integers). */
const TEXT_SIZE_DECIMALS = 1;
export const TEXT_LINE_HEIGHT_MIN = 0.5;
export const TEXT_LINE_HEIGHT_MAX = 4;
const TEXT_WEIGHT_MIN = 100;
const TEXT_WEIGHT_MAX = 1000;
export const TEXT_STROKE_WIDTH_MAX = 200;
export const TEXT_BACKGROUND_PADDING_MAX = 500;
export const SHAPE_RADIUS_MAX = 1000;
export const SHAPE_STROKE_WIDTH_MAX = 500;
/** Guard against pathological documents (and pathological rasters). */
const TEXT_CONTENT_MAX_LENGTH = 5000;

/**
 * Largest font size THIS text clip may take without pushing its layer past
 * MAX_LAYER_DIMENSION — the font-size counterpart of `maxClipScaleFor`.
 *
 * Solved from the same font-independent lower bound the compiler uses:
 *   bboxHeight >= fontSizePx * lineHeight * lineCount + 2 * padding
 * and the layer has to satisfy BOTH server ceilings —
 *   bbox              <= 8192   (the PNG itself; the raster factor bottoms out
 *                                at 1, so the bbox can never be shrunk away)
 *   bbox * scale      <= 8192   (the composited layer)
 * which collapses to `8192 / max(1, scale)`.
 *
 * With a `measuredBoxPx` the same equation is solved against the REAL box
 * instead of the bound (see the comment on `perFontPx`), which is what the
 * inspector passes — the bound alone cannot see a wide single line.
 *
 * Never below TEXT_SIZE_MIN: a UI range control must not invert. When the
 * content alone is already too tall, the floor is what the user gets and the
 * export still refuses — with a message that names the real reason.
 */
export function maxTextSizeFor(
  clip: TextClip,
  measuredBoxPx?: { widthPx: number; heightPx: number } | null,
): number {
  const text = clip.text;
  const lineHeight = Number.isFinite(text.lineHeight) ? Math.max(0, text.lineHeight) : 0;
  const lineCount = splitTextLines(text.content).length;
  const perPx = lineHeight * lineCount;
  if (!(perPx > 0)) return TEXT_SIZE_MAX;

  const scale = Number.isFinite(clip.transform.scale) ? Math.max(1, clip.transform.scale) : 1;
  const padding = text.background && Number.isFinite(text.background.paddingPx)
    ? Math.max(0, text.background.paddingPx)
    : 0;

  // How many box pixels ONE font pixel costs. Without a measurement that is the
  // height bound (lineHeight * lines). With one it is the measured box itself,
  // read as PROPORTIONAL to the current font size — which is what a glyph box
  // is: advances and ink scale with the em, only the background padding does
  // not, so it is taken out first and added back as a constant. Treating the
  // measured box as a fixed offset instead would badly under-count a WIDE line
  // (the widest text grows fastest with the font size).
  let perFontPx = perPx;
  if (measuredBoxPx && Number.isFinite(text.fontSizePx) && text.fontSizePx > 0) {
    const longest = Math.max(measuredBoxPx.widthPx, measuredBoxPx.heightPx);
    // Never BELOW the font-independent bound: the measured box always contains
    // the content box, so a smaller ratio would mean the measurement is wrong.
    perFontPx = Math.max(perPx, (longest - 2 * padding) / text.fontSizePx);
  }

  // A ROTATED text layer opens an intermediate canvas as large as its box's
  // diagonal (plus the anchor pad) — same ledger as the scale ceiling
  // (rendering-semantics §2.5). The exact inverse depends on the box's aspect
  // (which the font size itself changes), so the budget is shrunk by the WORST
  // CASE factor instead: hypot(w, h) <= sqrt(2) * max(w, h), and an off-center
  // anchor pads each axis by up to 2 * max(a, 1-a). Conservative only for
  // rotated text (never lets through a size the compiler would reject).
  const rotating = clip.transform.rotationDeg % 360 !== 0;
  const mx = Math.max(clip.transform.anchorX, 1 - clip.transform.anchorX);
  const my = Math.max(clip.transform.anchorY, 1 - clip.transform.anchorY);
  const needsPad = rotating && (mx !== 0.5 || my !== 0.5);
  const rotationFactor = rotating ? Math.SQRT2 * (needsPad ? 2 * Math.max(mx, my) : 1) : 1;

  // WHOLE pixels, floored. The inspector's size field shows integers, so a
  // fractional ceiling (743.9) would be clamped to itself and then ROUNDED UP
  // by the field to 744 — a value one tenth of a pixel past the ceiling the
  // same panel just advertised. Measured in the browser, not reasoned about.
  const budgetPx = MAX_LAYER_DIMENSION / (scale * rotationFactor) - 2 * padding;
  return Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX, Math.floor(budgetPx / perFontPx)));
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A valid hex color, or null when the input is not one (write is skipped). */
function normalizeHexColor(value: unknown): string | null {
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
      // Ceiling is derived, not constant — see maxTextSizeFor. Computed AFTER
      // `content` was written above so a patch that changes both lands on the
      // ceiling of the text the user will actually see.
      const v = clampFinite(
        patch.fontSizePx, TEXT_SIZE_MIN, maxTextSizeFor(clip), TEXT_SIZE_DECIMALS);
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
  return result;
}

// ---------------------------------------------------------------------------
// Clip speed (M5) — rendering-semantics §1.3 + design 04 §2.4
//
// Speed is the ONE clip property that changes the timeline layout, so it is
// the one op that cannot be a per-clip patch: the new duration is SOLVED
// (`solveSpeedChange` — a whole frame count on the project grid, with
// `sourceOutUs` re-derived so `roundHalfUp((out-in)/rate)` reproduces it
// exactly, because the compiler gates the clip on both rules) and everything
// that hangs off the duration has to move with it —
//   - the clips AFTER it (reject on collision, or ripple),
//   - keyframe times (clip-relative TIMELINE time, so they rescale),
//   - audio fades (invariant 8: in+out <= duration),
//   - transitions on both edges (the source handle is `(D/2)*rate`, so a
//     faster clip needs MORE source slack for the same transition).
//
// Everything is PLANNED first and only then written: a half-applied speed
// change (duration moved, neighbour not) is a document the validator rejects,
// and `mutate` would already have committed it to history.
// ---------------------------------------------------------------------------

/** Schema bounds for `speed.rate` (MediaClipSchema: 0.1 .. 10). */
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10;
/** Preset buttons offered by the inspector (0.25x .. 4x). */
export const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;
/** Rates are stored rounded so undo patches (and the duration) stay stable. */
export const SPEED_DECIMALS = 3;

/** Notice code: the new duration forced two keyframes onto the same instant. */
export const SPEED_KEYFRAMES_MERGED = 'keyframes merged by speed change';

/**
 * Notice code: the frame-grid solve landed MORE than half a frame away from the
 * duration the rate asks for.
 *
 * Half a frame is the unavoidable cost of putting the duration on the grid and
 * nobody can see it. Anything beyond that means `solveSpeedChange` had to walk
 * past frame counts that are unreachable at this rate (below 1x the admissible
 * source window is narrower than one microsecond, so some lengths simply do not
 * exist) — the clip is then visibly longer or shorter than "source / rate", and
 * a correction the user did not ask for has to be VISIBLE.
 */
export const SPEED_DURATION_SNAPPED = 'speed duration snapped to the frame grid';

/**
 * Speed applies to clips with real temporal media only.
 *
 * Images are excluded ON PURPOSE even though the duration formula would work:
 * an image has no time axis, so "2x" would silently mean "half as long on the
 * timeline" — that is a DURATION edit and the user has trimming for it.
 */
export function clipSupportsSpeed(clip: Clip): clip is MediaClip {
  return clip.kind === 'video' || clip.kind === 'audio';
}

/** Clamp + round a requested rate into the schema range (null = not a number). */
function normalizeSpeedRate(rate: number): number | null {
  return clampFinite(rate, SPEED_MIN, SPEED_MAX, SPEED_DECIMALS);
}

/**
 * Keyframe times are clip-relative TIMELINE time (schema KeyframeSchema), so a
 * clip that becomes half as long has to carry its animation into the new
 * length: `t' = roundHalfUp(t * newDur / oldDur)`, clamped to [0, newDur].
 *
 * Rounding can collapse two neighbouring keyframes onto one instant, which
 * invariant 4 forbids (strictly sorted, unique). The FIRST one wins — mapped
 * times are non-decreasing, so first-wins keeps the array strictly sorted and
 * preserves the value the segment STARTS from. The caller turns a collapse
 * into a user-visible notice; silently dropping animation is exactly the
 * "it did something I did not ask for" complaint.
 */
function rescaleKeyframes(clip: Clip, oldDurationUs: MicroSec, newDurationUs: MicroSec): boolean {
  if (oldDurationUs <= 0 || oldDurationUs === newDurationUs) return false;
  let merged = false;
  const tracks = clip.keyframes;
  for (const key of Object.keys(tracks) as (keyof KeyframeTracks)[]) {
    const kfs = tracks[key];
    if (!kfs || kfs.length === 0) continue;
    const mapped: Keyframe[] = [];
    let lastTime = -1;
    for (const kf of kfs) {
      const t = clamp(roundHalfUp((kf.timeUs * newDurationUs) / oldDurationUs), 0, newDurationUs);
      if (t === lastTime) {
        merged = true;
        continue;
      }
      lastTime = t;
      mapped.push({ ...kf, timeUs: t });
    }
    if (mapped.length > 0) tracks[key] = mapped;
    else delete tracks[key];
  }
  return merged;
}

interface SpeedClipPlan {
  clipId: Uuid;
  startUs: MicroSec;
  durationUs: MicroSec;
  /** true = this clip's rate changes (the others only ripple-shift). */
  target: boolean;
  /**
   * Re-derived source range. On a TARGET it comes from `solveSpeedChange` (the
   * duration is solved onto the frame grid first and the source follows it, so
   * invariant 3 stays exact); on a rippled follower it comes from
   * `refitToGrid`, which does the same job for the microsecond or two the new
   * position costs. Absent when the source range does not change.
   */
  sourceInUs?: MicroSec;
  sourceOutUs?: MicroSec;
}

interface SpeedTrackPlan {
  trackIndex: number;
  clips: SpeedClipPlan[];
}

export interface SpeedPlan {
  tracks: SpeedTrackPlan[];
  /** How many clips actually get the new rate. */
  targetCount: number;
}

export type SpeedPlanResult = SpeedPlan | { reason: string };

/**
 * Lays out every affected track at the new rate WITHOUT touching the document.
 *
 * `ripple` decides what happens to the clips after a target: shift them by the
 * duration delta (gaps preserved, adjacency — hence transitions — preserved),
 * or leave them and refuse when the longer clip would collide. Refusing is the
 * default because moving clips the user did not select is a bigger surprise
 * than "did not fit".
 *
 * The new duration comes from `solveSpeedChange`, NOT from the duration formula
 * alone: the compiler gates the clip on the formula AND on the project frame
 * grid, and the formula on its own lands off the grid for most rates (30 fps,
 * 3 s at 0.7x -> 4_285_714 us, grid neighbour 4_300_000 us). The solver picks
 * the frame count first and hands back the `sourceOutUs` that makes the formula
 * exact for it; `assetDurations` caps that re-derivation so a snap UP can never
 * ask for source the asset does not have.
 */
export function planClipSpeed(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  rate: number,
  ripple: boolean,
  assetDurations?: ReadonlyMap<string, MicroSec>,
): SpeedPlanResult {
  const normalized = normalizeSpeedRate(rate);
  if (normalized === null) return { reason: 'invalid speed' };
  const ids = new Set(clipIds);
  const fps = d.settings.fps;
  const minDurationUs = minClipDurationUs(fps);
  const tracks: SpeedTrackPlan[] = [];
  let targetCount = 0;
  let sawSupported = false;

  for (let ti = 0; ti < d.tracks.length; ti++) {
    const track = d.tracks[ti];
    if (!track.clips.some((c) => ids.has(c.id))) continue;
    if (track.locked) return { reason: 'track is locked' };

    const plans: SpeedClipPlan[] = [];
    // The ripple is carried in FRAMES: shifting a follower by a microsecond
    // delta lands its end off the grid (the grid is not closed under addition),
    // which the export compiler rejects. `shiftUs` is only the fallback for a
    // clip that is already off the grid.
    let shiftUs = 0;
    let shiftFrames = 0;
    for (const clip of track.clips) {
      const target = ids.has(clip.id) && clipSupportsSpeed(clip);
      if (target) sawSupported = true;
      const startUs = shiftedStartUs(clip, shiftFrames, shiftUs, fps);
      const refit = refitToGrid(clip, startUs, fps, assetDurations ?? new Map());
      if (refit === null) return { reason: 'clip cannot keep its frame span here' };
      let durationUs = refit.durationUs;
      let sourceInUs: MicroSec | undefined = refit.sourceInUs;
      let sourceOutUs: MicroSec | undefined = refit.sourceOutUs;
      if (target) {
        const media = clip as MediaClip;
        // The one-frame floor is judged on the IDEAL duration, before the grid
        // solve. Judging it after would let the solver's minimum silently
        // STRETCH a sub-frame result up to a full frame — at 10x that is a
        // tenth of a second of source the user never trimmed in.
        const idealUs = clipTimelineDurationUs(media.sourceInUs, media.sourceOutUs, normalized);
        if (idealUs < minDurationUs) return { reason: 'speed leaves less than one frame' };
        const solved = solveSpeedChange(media.sourceInUs, media.sourceOutUs, normalized, fps, {
          maxSourceOutUs: assetDurations?.get(media.assetId),
          minFrames: 1,
          // The grid rule is about the clip's EDGES, so the solve has to know
          // where this clip starts: at 30 fps a clip on frame 1 may be 33_334 us
          // long and may NOT be 33_333 us long.
          timelineStartUs: startUs,
        });
        if (solved === null) return { reason: 'speed leaves less than one frame' };
        durationUs = solved.durationUs;
        sourceInUs = media.sourceInUs;
        sourceOutUs = solved.sourceOutUs;
        if (durationUs < minDurationUs) return { reason: 'speed leaves less than one frame' };
        if (ripple) {
          // Cumulative, measured between the OLD and NEW end EDGE (both grid
          // values), so followers walk whole frames — see rippleFollowers.
          const oldEndUs = clip.timelineStartUs + clip.timelineDurationUs;
          shiftUs = startUs + durationUs - oldEndUs;
          shiftFrames = usToFrame(startUs + durationUs, fps) - usToFrame(oldEndUs, fps);
        }
        targetCount++;
      }
      if (startUs < 0) return { reason: 'before timeline start' };
      plans.push({ clipId: clip.id, startUs, durationUs, target, sourceInUs, sourceOutUs });
    }

    // Layout check — run for BOTH modes. Ripple cannot overlap by
    // construction, so here it is a guard; non-ripple needs it as the rule.
    for (let i = 0; i + 1 < plans.length; i++) {
      if (plans[i].startUs + plans[i].durationUs > plans[i + 1].startUs) {
        return { reason: 'speed change overlaps the next clip' };
      }
    }
    tracks.push({ trackIndex: ti, clips: plans });
  }

  if (!sawSupported) return { reason: 'no video/audio clip in selection' };
  return { tracks, targetCount };
}

/** Free timeline space after `clip` on its track; null when nothing follows. */
export function gapAfterClip(track: Track, clip: Clip): number | null {
  const endUs = clip.timelineStartUs + clip.timelineDurationUs;
  let nearest: number | null = null;
  for (const other of track.clips) {
    if (other.id === clip.id) continue;
    if (other.timelineStartUs < endUs) continue;
    if (nearest === null || other.timelineStartUs < nearest) nearest = other.timelineStartUs;
  }
  return nearest === null ? null : Math.max(0, nearest - endUs);
}

/** The stored 3-decimal rate grid, as integer steps per 1x. */
const RATE_GRID = 10 ** SPEED_DECIMALS;

/**
 * Walk caps for `minSpeedRateWithoutRipple`, measured, not guessed: a sweep of
 * grid-critical geometries (frames 0..8, clips 1..6 frames, gaps 0..4, stored
 * rates 0.5..2, tight and unbounded assets) over seven project frame rates
 * (24/25/30/60 and the 1001-based NTSC rationals) needed at most 36 steps up
 * (29.97, one-frame clip whose asset is exactly as long) and stayed under the
 * down cap everywhere a bound is meaningful. Hitting a cap does not lie: the
 * up cap returns null (no promise), the down cap returns the last rate that
 * the planner ACCEPTED — merely not the absolute slowest one.
 */
const MIN_RATE_WALK_UP_MAX = 64;
const MIN_RATE_WALK_DOWN_MAX = 250;

/**
 * The slowest 3-decimal rate `setClipSpeed(clipIds, rate)` ACCEPTS without
 * ripple, or null when there is no bound to advertise (nothing follows any
 * selected clip — or nothing nearby is accepted at all, in which case a number
 * would be a lie). This is what the Inspector's "kaydırmadan en yavaş Nx
 * olabilir" note shows, so it has exactly one correctness criterion: typing
 * the advertised rate must succeed.
 *
 * The ideal duration formula alone — `(out-in) / (duration+gap)`, then ceil to
 * the rate grid — does NOT satisfy that criterion, and shipping it did produce
 * a refused advertisement (backlog, measured at 30 fps: one-frame clip on
 * frame 0, follower on frame 2 -> the formula says 0.5x, `solveSpeedChange`
 * finds no integer source span for 2 frames at 0.5 and lands on 3, the op
 * refuses). Below 1x the admissible source window per frame count is narrower
 * than a microsecond, so acceptance is decided by the frame ledger, not by the
 * formula.
 *
 * Derivation: the formula's value is kept only as the ANCHOR, and every
 * candidate is judged by `planClipSpeed` ITSELF — the exact planner the op
 * commits, including the frame-grid solve, the one-frame floor, the asset
 * duration cap and the whole-track layout check. No arithmetic is restated
 * here, so this cannot drift from the op. From the anchor:
 *  - one step DOWN is probed first when the anchor is refused: `ceil` on an
 *    exact boundary rate can overshoot by float dust (0.75 -> 0.751) and the
 *    only acceptable rate then sits just below;
 *  - otherwise the walk goes UP to the nearest accepted rate (the backlog
 *    case: 0.5 refused, 0.501 accepted);
 *  - finally the walk slides DOWN while the next lower rate is still accepted,
 *    because grid slack usually admits a slightly slower rate than the ideal
 *    formula claims (half a frame of room is up to a few grid steps of rate).
 * The result is the bottom edge of the CONTIGUOUS accepted band around the
 * anchor. Acceptance has holes and lower islands (a much slower rate can be
 * "accepted" by snapping the duration visibly shorter); those are deliberately
 * not advertised — the note promises growth into the room, not a lucky snap.
 *
 * `assetDurations` must be the same map the op will use (knownAssetDurations
 * at the call site) or the advertised rate may be judged against different
 * source bounds than the click.
 */
export function minSpeedRateWithoutRipple(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  assetDurations?: ReadonlyMap<string, MicroSec>,
): number | null {
  const ids = new Set(clipIds);
  let anchor: number | null = null;
  for (const track of d.tracks) {
    for (const clip of track.clips) {
      if (!ids.has(clip.id)) continue;
      if (!clipSupportsSpeed(clip)) continue;
      const gap = gapAfterClip(track, clip);
      if (gap === null) continue;
      const room = clip.timelineDurationUs + gap;
      if (room <= 0) continue;
      // The strictest selected clip anchors the search (one write hits all).
      const rate = (clip.sourceOutUs - clip.sourceInUs) / room;
      if (anchor === null || rate > anchor) anchor = rate;
    }
  }
  if (anchor === null) return null;

  const minUnits = Math.round(SPEED_MIN * RATE_GRID);
  const maxUnits = Math.round(SPEED_MAX * RATE_GRID);
  const accepts = (units: number): boolean =>
    !('reason' in planClipSpeed(d, clipIds, units / RATE_GRID, false, assetDurations));

  let units = Math.min(maxUnits, Math.max(minUnits, Math.ceil(anchor * RATE_GRID)));
  if (!accepts(units)) {
    if (units - 1 >= minUnits && accepts(units - 1)) {
      units -= 1;
    } else {
      let walked = 0;
      do {
        units += 1;
        walked += 1;
        if (units > maxUnits || walked > MIN_RATE_WALK_UP_MAX) return null;
      } while (!accepts(units));
    }
  }
  for (let walked = 0; walked < MIN_RATE_WALK_DOWN_MAX; walked++) {
    if (units - 1 < minUnits || !accepts(units - 1)) break;
    units -= 1;
  }
  return units / RATE_GRID;
}

/**
 * Writes a planned speed change into a DRAFT document (inside mutate).
 *
 * Order matters: duration first, then everything derived from it — keyframes
 * (rescaled), fades (re-clamped), and finally the track's transitions
 * (reconciled against the new durations AND the new `(D/2)*rate` handles).
 */
function applyClipSpeedToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  rate: number,
  opts: { ripple?: boolean } = {},
): OpResult {
  const assetDurations = knownAssetDurations();
  const plan = planClipSpeed(d, clipIds, rate, opts.ripple === true, assetDurations);
  if ('reason' in plan) return fail(plan.reason);
  const normalized = normalizeSpeedRate(rate);
  if (normalized === null) return fail('invalid speed');

  let report = NO_TRANSITION_CHANGE;
  let merged = false;
  let snapped = false;
  const fps = d.settings.fps;

  for (const trackPlan of plan.tracks) {
    const track = d.tracks[trackPlan.trackIndex];
    const byId = new Map(track.clips.map((c) => [c.id, c] as const));
    for (const entry of trackPlan.clips) {
      const clip = byId.get(entry.clipId);
      if (!clip) continue;
      const oldDurationUs = clip.timelineDurationUs;
      clip.timelineStartUs = entry.startUs;
      if (!entry.target) {
        // Rippled follower: the grid re-fit may have changed its length by a
        // microsecond, and the source window has to follow (invariant 3).
        clip.timelineDurationUs = entry.durationUs;
        if (entry.sourceInUs !== undefined && isMediaClip(clip)) {
          clip.sourceInUs = entry.sourceInUs;
          clip.sourceOutUs = entry.sourceOutUs!;
        }
        clampAudioFadesToDuration(clip);
        continue;
      }
      const media = clip as MediaClip;
      // Measured BEFORE the write, in FRAMES rather than microseconds: the
      // question is "did the solver have to skip the NEAREST frame count?",
      // and a microsecond threshold answers it wrongly at the boundary (one
      // frame is 33_333.33 us at 30 fps, so a legitimate half-frame snap can
      // measure 16_667 against a 16_666.5 limit). See SPEED_DURATION_SNAPPED.
      const idealUs = clipTimelineDurationUs(media.sourceInUs, media.sourceOutUs, normalized);
      if (
        frameSpanCount(entry.startUs, entry.durationUs, fps) !==
        frameSpanCount(entry.startUs, idealUs, fps)
      ) {
        snapped = true;
      }
      media.speed = { rate: normalized };
      // Source range BEFORE duration is irrelevant to the write order, but both
      // must land: the pair (sourceOutUs, timelineDurationUs) is what satisfies
      // invariant 3, and writing only one of them is exactly the half-applied
      // state this op is built to avoid.
      if (entry.sourceOutUs !== undefined) media.sourceOutUs = entry.sourceOutUs;
      clip.timelineDurationUs = entry.durationUs;
      if (rescaleKeyframes(clip, oldDurationUs, entry.durationUs)) merged = true;
      clampAudioFadesToDuration(clip);
    }
    report = mergeTransitionReports(report, reconcileTransitions(track, fps, assetDurations));
  }

  // Loudest first: a transition repair changed something the user did not
  // touch, a merged keyframe lost animation, and the grid snap only changed
  // the length. Each of the three is reported only when nothing louder did.
  return okWith(
    transitionReconcileNotice(report) ??
      (merged ? SPEED_KEYFRAMES_MERGED : snapped ? SPEED_DURATION_SNAPPED : undefined),
  );
}

/** Inspector speed field / preset buttons. ONE history entry per call. */
export function setClipSpeed(
  clipIds: readonly Uuid[],
  rate: number,
  opts: { ripple?: boolean } = {},
): OpResult {
  let result: OpResult = fail('no video/audio clip in selection');
  useDocStore.getState().mutate('clipSpeed', 'Klip hızı değiştirildi', (d) => {
    result = applyClipSpeedToDraft(d, clipIds, rate, opts);
  });
  return result;
}

// ---------------------------------------------------------------------------
// colorAdjust effect (M5) — rendering-semantics §4.1
//
// ONE colorAdjust effect per clip, by contract: the preview is a single
// uber-shader pass (compositor/shaders.ts) and `colorAdjustOf` reads the FIRST
// enabled one, so a second effect would be in the document, in the export, and
// invisible on screen. Writes therefore normalize the clip to a single effect.
//
// Params are the six §4.1 keys, each in [-1..1] with 0 = identity — exactly
// what invariant rule 6 allows; anything else makes the document unexportable.
// ---------------------------------------------------------------------------

export const COLOR_ADJUST_MIN = -1;
export const COLOR_ADJUST_MAX = 1;
/** Stored precision (undo patches stay clean; well under the ±1/255 §4.1 note). */
const COLOR_ADJUST_DECIMALS = 3;

/** The six §4.1 params, in the order the panel shows them. */
export const COLOR_ADJUST_KEYS = [
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'exposure',
] as const;

export type ColorAdjustKey = (typeof COLOR_ADJUST_KEYS)[number];
export type ColorAdjustPatch = Partial<Record<ColorAdjustKey, number>>;

/** Notice code: the clip carried more than one colorAdjust; the extras went. */
export const COLOR_ADJUST_DEDUPED = 'duplicate colorAdjust effects merged';

/** All six params at 0 — the identity the shader and the compiler agree on. */
function identityColorAdjustParams(): Record<ColorAdjustKey, number> {
  return { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, exposure: 0 };
}

/** Audio clips draw nothing, so colour has nowhere to land. */
function clipSupportsColorAdjust(clip: Clip): boolean {
  return isVisualClip(clip);
}

/** The clip's single colorAdjust effect, or null. Extras are NOT returned. */
export function colorAdjustEffectOf(clip: Clip): Effect | null {
  return clip.effects.find((e) => e.type === 'colorAdjust') ?? null;
}

/**
 * Guarantees the invariant shape on a DRAFT clip: exactly one colorAdjust
 * effect, params = the six keys and nothing else. Returns the effect plus
 * whether duplicates had to be dropped.
 */
function ensureColorAdjustEffect(
  clip: Clip,
  create: boolean,
): { effect: Effect | null; deduped: boolean } {
  const found = clip.effects.filter((e) => e.type === 'colorAdjust');
  let deduped = false;
  if (found.length > 1) {
    // Keep the first (the one the preview shader was already showing).
    const keep = found[0];
    clip.effects = clip.effects.filter((e) => e.type !== 'colorAdjust' || e === keep);
    deduped = true;
  }
  let effect = clip.effects.find((e) => e.type === 'colorAdjust') ?? null;
  if (effect === null) {
    if (!create) return { effect: null, deduped };
    effect = { id: uuidv7(), type: 'colorAdjust', enabled: true, params: identityColorAdjustParams() };
    clip.effects.push(effect);
    return { effect, deduped };
  }
  // Normalize params: fill missing keys with 0, drop anything invariant rule 6
  // would reject (a foreign key makes the WHOLE document unexportable).
  const params = identityColorAdjustParams();
  for (const key of COLOR_ADJUST_KEYS) {
    const v = effect.params[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      params[key] = roundTo(clamp(v, COLOR_ADJUST_MIN, COLOR_ADJUST_MAX), COLOR_ADJUST_DECIMALS);
    }
  }
  effect.params = params;
  return { effect, deduped };
}

export function applyClipColorAdjustToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ColorAdjustPatch,
): OpResult {
  let touched = 0;
  let deduped = false;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    if (!clipSupportsColorAdjust(loc.clip)) continue;
    const ensured = ensureColorAdjustEffect(loc.clip, true);
    if (ensured.deduped) deduped = true;
    const effect = ensured.effect;
    if (effect === null) continue;
    for (const key of COLOR_ADJUST_KEYS) {
      const raw = patch[key];
      if (raw === undefined) continue;
      const v = clampFinite(raw, COLOR_ADJUST_MIN, COLOR_ADJUST_MAX, COLOR_ADJUST_DECIMALS);
      if (v !== null) effect.params[key] = v;
    }
    // Touching a slider on a disabled effect turns it back on: the user is
    // asking to SEE the change, and an edit with no visible result reads as
    // a broken control.
    effect.enabled = true;
    touched++;
  }
  if (touched === 0) return fail('no visual clip in selection');
  return okWith(deduped ? COLOR_ADJUST_DEDUPED : undefined);
}

const COLOR_ADJUST_LABELS: Record<ColorAdjustKey, string> = {
  brightness: 'Parlaklık değiştirildi',
  contrast: 'Kontrast değiştirildi',
  saturation: 'Doygunluk değiştirildi',
  temperature: 'Renk sıcaklığı değiştirildi',
  tint: 'Renk tonu değiştirildi',
  exposure: 'Pozlama değiştirildi',
};

function colorAdjustLabel(patch: ColorAdjustPatch): string {
  const keys = Object.keys(patch) as ColorAdjustKey[];
  if (keys.length !== 1) return 'Renk düzeltme değiştirildi';
  return COLOR_ADJUST_LABELS[keys[0]] ?? 'Renk düzeltme değiştirildi';
}

export function setClipColorAdjust(
  clipIds: readonly Uuid[],
  patch: ColorAdjustPatch,
): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipColor', colorAdjustLabel(patch), (d) => {
    result = applyClipColorAdjustToDraft(d, clipIds, patch);
  });
  return result;
}

/**
 * Effect on/off. Turning it ON with no effect yet creates the identity one, so
 * the toggle is never a dead control; turning it OFF keeps the params (the
 * user is comparing, not discarding — that is what "Sıfırla" is for).
 */
export function setClipColorAdjustEnabled(
  clipIds: readonly Uuid[],
  enabled: boolean,
): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore
    .getState()
    .mutate('clipColor', enabled ? 'Renk düzeltme açıldı' : 'Renk düzeltme kapatıldı', (d) => {
      let touched = 0;
      for (const clipId of clipIds) {
        const loc = locateClip(d, clipId);
        if (!loc || loc.track.locked) continue;
        if (!clipSupportsColorAdjust(loc.clip)) continue;
        const { effect } = ensureColorAdjustEffect(loc.clip, enabled);
        if (effect !== null) effect.enabled = enabled;
        touched++;
      }
      result = touched > 0 ? OK : fail('no visual clip in selection');
    });
  return result;
}

/**
 * "Sıfırla": REMOVES the colorAdjust effect instead of zeroing it.
 *
 * An all-zero effect is identity for the shader and produces no ffmpeg filter
 * (§4.1), but it is still an enabled effect in the document — and the export
 * compiler's feature gate reads `effects.Any(e => e.Enabled)`. Removing it
 * leaves the clip exactly as it was before the user ever touched colour.
 */
export function resetClipColorAdjust(clipIds: readonly Uuid[]): OpResult {
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipColor', 'Renk düzeltme sıfırlandı', (d) => {
    let touched = 0;
    for (const clipId of clipIds) {
      const loc = locateClip(d, clipId);
      if (!loc || loc.track.locked) continue;
      if (!clipSupportsColorAdjust(loc.clip)) continue;
      loc.clip.effects = loc.clip.effects.filter((e) => e.type !== 'colorAdjust');
      touched++;
    }
    result = touched > 0 ? OK : fail('no visual clip in selection');
  });
  return result;
}

// ---------------------------------------------------------------------------
// lut effect (rendering-semantics §4.2) — .cube 3D LUT + intensity
//
// colorAdjust ile AYNI teklik sözleşmesi: klip başına EN FAZLA BİR lut efekti.
// Önizleme çözücüsü (player/core/resolve.lutOf) İLK etkin lut'u okur ve shader
// tek 3D doku örnekler; ikinci bir efekt dokümanda ve export'ta var olur ama
// ekranda görünmezdi. Yazımlar bu yüzden klibi tek efekte normalize eder.
//
// Params şeması invariant kural 6'nın lut dalıdır: TAM OLARAK { assetId: Uuid,
// intensity: 0..1 } — yabancı anahtar belgeyi export edilemez yapar.
// ---------------------------------------------------------------------------

export const LUT_INTENSITY_MIN = 0;
export const LUT_INTENSITY_MAX = 1;
/** Kayıt hassasiyeti (colorAdjust ile aynı gerekçe: temiz undo patch'leri). */
const LUT_INTENSITY_DECIMALS = 3;
/** Yeni uygulanan LUT'un varsayılan yoğunluğu (tam etki — §4.2 split/blend'siz yol). */
export const LUT_DEFAULT_INTENSITY = 1;

/** Bildirim kodu: klip birden fazla lut taşıyordu; fazlalıklar atıldı. */
export const LUT_DEDUPED = 'duplicate lut effects merged';

/** Ses klibi çizilmez — LUT'un ineceği piksel yok (colorAdjust ile aynı kural). */
function clipSupportsLut(clip: Clip): boolean {
  return isVisualClip(clip);
}

/** Klibin tek lut efekti, ya da null. Fazlalıklar DÖNDÜRÜLMEZ. */
export function lutEffectOf(clip: Clip): Effect | null {
  return clip.effects.find((e) => e.type === 'lut') ?? null;
}

/**
 * DRAFT klipte invariant şekli garanti eder: en fazla bir lut efekti, params
 * yalnız {assetId, intensity}. Efekt yoksa null döner (LUT, colorAdjust'tan
 * farklı olarak "kimlik" değeriyle YARATILAMAZ — bir assetId şarttır; yaratma
 * yalnız applyClipLutToDraft'ın assetId'li yolundadır).
 */
function normalizeLutEffect(clip: Clip): { effect: Effect | null; deduped: boolean } {
  const found = clip.effects.filter((e) => e.type === 'lut');
  let deduped = false;
  if (found.length > 1) {
    const keep = found[0];
    clip.effects = clip.effects.filter((e) => e.type !== 'lut' || e === keep);
    deduped = true;
  }
  const effect = clip.effects.find((e) => e.type === 'lut') ?? null;
  if (effect !== null) {
    const assetId = effect.params.assetId;
    const intensity = effect.params.intensity;
    effect.params = {
      assetId: typeof assetId === 'string' ? assetId : '',
      intensity:
        typeof intensity === 'number' && Number.isFinite(intensity)
          ? roundTo(
              Math.min(LUT_INTENSITY_MAX, Math.max(LUT_INTENSITY_MIN, intensity)),
              LUT_INTENSITY_DECIMALS,
            )
          : LUT_DEFAULT_INTENSITY,
    };
  }
  return { effect, deduped };
}

export interface ClipLutPatch {
  /** Verilirse efekt bu .cube varlığına (yeniden) bağlanır; efekt yoksa yaratılır. */
  assetId?: Uuid;
  /** Verilirse yoğunluk yazılır (0..1'e kelepçelenir). */
  intensity?: number;
}

/**
 * Saf draft yazımı — panelin canlı slider'ı (liveEdit) ve tekil op aynı yolu
 * kullanır. `assetId` içermeyen bir patch, lut'u OLMAYAN klipleri atlar:
 * yoğunluk tek başına bir efekt yaratamaz (neye uygulanacağı belirsiz olurdu).
 */
export function applyClipLutToDraft(
  d: TimelineDoc,
  clipIds: readonly Uuid[],
  patch: ClipLutPatch,
): OpResult {
  let touched = 0;
  let deduped = false;
  for (const clipId of clipIds) {
    const loc = locateClip(d, clipId);
    if (!loc || loc.track.locked) continue;
    if (!clipSupportsLut(loc.clip)) continue;
    const normalized = normalizeLutEffect(loc.clip);
    if (normalized.deduped) deduped = true;
    let effect = normalized.effect;
    if (effect === null) {
      if (patch.assetId === undefined) continue; // yoğunluk yalnız var olan LUT'a yazılır
      effect = {
        id: uuidv7(),
        type: 'lut',
        enabled: true,
        params: { assetId: patch.assetId, intensity: LUT_DEFAULT_INTENSITY },
      };
      loc.clip.effects.push(effect);
    } else if (patch.assetId !== undefined) {
      effect.params.assetId = patch.assetId;
    }
    if (patch.intensity !== undefined) {
      const v = clampFinite(
        patch.intensity, LUT_INTENSITY_MIN, LUT_INTENSITY_MAX, LUT_INTENSITY_DECIMALS);
      if (v !== null) effect.params.intensity = v;
    }
    // Kapalı efekte dokunmak onu geri açar (colorAdjust ile aynı gerekçe:
    // görünür sonucu olmayan denetim bozuk denetim gibi okunur).
    effect.enabled = true;
    touched++;
  }
  if (touched === 0) {
    return fail(
      patch.assetId === undefined ? 'no clip with a lut in selection' : 'no visual clip in selection');
  }
  return okWith(deduped ? LUT_DEDUPED : undefined);
}

/**
 * LUT seç/uygula. `assetId` kitaplıktaki READY bir .cube (kind 'lut') olmalı —
 * panel listeyi zaten filtreler ama op ikinci kez sorar: yanlış türde bir id
 * yazılsaydı belge ancak export'ta ('lut-asset-type') reddedilirdi.
 */
export function setClipLut(clipIds: readonly Uuid[], assetId: Uuid): OpResult {
  const asset = useAssetStore.getState().getAsset(assetId);
  if (!asset || asset.kind !== 'lut' || asset.status !== 'ready') {
    return fail('not a ready lut asset');
  }
  let result: OpResult = fail('no visual clip in selection');
  useDocStore.getState().mutate('clipLut', 'LUT uygulandı', (d) => {
    result = applyClipLutToDraft(d, clipIds, { assetId });
  });
  return result;
}

/** Yoğunluk yazımı (0..1) — yalnız lut'u OLAN kliplere. */
export function setClipLutIntensity(clipIds: readonly Uuid[], intensity: number): OpResult {
  let result: OpResult = fail('no clip with a lut in selection');
  useDocStore.getState().mutate('clipLut', 'LUT yoğunluğu değiştirildi', (d) => {
    result = applyClipLutToDraft(d, clipIds, { intensity });
  });
  return result;
}

/**
 * Efekt aç/kapa. colorAdjust'tan farkı: kapalıyken AÇMAK efekt YARATMAZ —
 * LUT'un kimlik değeri yoktur (bir .cube seçilmiş olmalı); efekti olmayan
 * klipler atlanır. Params korunur: kullanıcı karşılaştırıyor, silmiyor.
 */
export function setClipLutEnabled(clipIds: readonly Uuid[], enabled: boolean): OpResult {
  let result: OpResult = fail('no clip with a lut in selection');
  useDocStore
    .getState()
    .mutate('clipLut', enabled ? 'LUT açıldı' : 'LUT kapatıldı', (d) => {
      let touched = 0;
      for (const clipId of clipIds) {
        const loc = locateClip(d, clipId);
        if (!loc || loc.track.locked) continue;
        if (!clipSupportsLut(loc.clip)) continue;
        const { effect } = normalizeLutEffect(loc.clip);
        if (effect === null) continue;
        effect.enabled = enabled;
        touched++;
      }
      result = touched > 0 ? OK : fail('no clip with a lut in selection');
    });
  return result;
}

/**
 * "Yok" seçimi / sıfırla: lut efektini KALDIRIR (yoğunluğu 0'a çekmek değil).
 * Sıfır yoğunluklu etkin bir lut compiler'da zaten üretilmez ama dokümanda
 * efekt olarak durur ve export'un özellik kapıları onu sorgular — kaldırmak
 * klibi kullanıcı LUT'a hiç dokunmamış hale döndürür (resetClipColorAdjust
 * ile aynı gerekçe).
 */
export function removeClipLut(clipIds: readonly Uuid[]): OpResult {
  let result: OpResult = fail('no clip with a lut in selection');
  useDocStore.getState().mutate('clipLut', 'LUT kaldırıldı', (d) => {
    let touched = 0;
    for (const clipId of clipIds) {
      const loc = locateClip(d, clipId);
      if (!loc || loc.track.locked) continue;
      if (!clipSupportsLut(loc.clip)) continue;
      if (loc.clip.effects.some((e) => e.type === 'lut')) {
        loc.clip.effects = loc.clip.effects.filter((e) => e.type !== 'lut');
        touched++;
      }
    }
    result = touched > 0 ? OK : fail('no clip with a lut in selection');
  });
  return result;
}
