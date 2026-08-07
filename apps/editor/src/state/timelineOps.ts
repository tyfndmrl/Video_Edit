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
  roundHalfUp,
  sampleKeyframes,
  snapUsToFrameGrid,
  validateTimelineDoc,
  isMediaClip,
  type Clip,
  type Keyframe,
  type KeyframeTracks,
  type MediaClip,
  type MicroSec,
  type Rational,
  type TimelineDoc,
  type Track,
  type TrackType,
  type Uuid,
} from '@videoedit/timeline-schema';
import { uuidv7 } from '../lib/uuid';
import { useAssetStore, type AssetSummary } from './assetStore';
import { useDocStore } from './docStore';
import { useEditorStore } from './editorStore';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export type OpResult = { ok: true } | { ok: false; reason: string };
const OK: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });

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

/**
 * Transitions are metadata on a cut between two ADJACENT media clips and must
 * be symmetric (invariants rule 5). Any op that moves/trims/splits/deletes can
 * break adjacency or the D<=min/2 bound — after such ops we strip transition
 * metadata that no longer satisfies the contract (MVP: no auto-repair).
 */
function reconcileTransitions(track: Track): void {
  const cs = track.clips;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!isMediaClip(c)) continue;
    if (c.transitionIn) {
      const p = i > 0 ? cs[i - 1] : undefined;
      const ok =
        p !== undefined &&
        isMediaClip(p) &&
        clipEndUs(p) === c.timelineStartUs &&
        p.transitionOut !== undefined &&
        p.transitionOut.type === c.transitionIn.type &&
        p.transitionOut.durationUs === c.transitionIn.durationUs &&
        c.transitionIn.durationUs * 2 <= Math.min(c.timelineDurationUs, p.timelineDurationUs);
      if (!ok) delete c.transitionIn;
    }
    if (c.transitionOut) {
      const n = i + 1 < cs.length ? cs[i + 1] : undefined;
      const ok =
        n !== undefined &&
        isMediaClip(n) &&
        clipEndUs(c) === n.timelineStartUs &&
        n.transitionIn !== undefined &&
        n.transitionIn.type === c.transitionOut.type &&
        n.transitionIn.durationUs === c.transitionOut.durationUs &&
        c.transitionOut.durationUs * 2 <= Math.min(c.timelineDurationUs, n.timelineDurationUs);
      if (!ok) delete c.transitionOut;
    }
  }
  // Removing one side can orphan the counterpart; a second pass settles it.
  for (const c of cs) {
    if (!isMediaClip(c)) continue;
    const i = cs.indexOf(c);
    if (c.transitionIn) {
      const p = i > 0 ? cs[i - 1] : undefined;
      if (!(p && isMediaClip(p) && p.transitionOut)) delete c.transitionIn;
    }
    if (c.transitionOut) {
      const n = i + 1 < cs.length ? cs[i + 1] : undefined;
      if (!(n && isMediaClip(n) && n.transitionIn)) delete c.transitionOut;
    }
  }
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
    for (const ti of touched) reconcileTransitions(dd.tracks[ti]);
  });
  assertDocValidDev('moveClips');
  return OK;
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
    if (b.timelineStartUs < clipEndUs(a)) return fail('roll rounding failed');
    reconcileTransitions(track);
    return OK;
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
      newEnd = target;
    }
    if (effectiveMode === 'ripple') {
      const delta = newEnd - oldEnd;
      for (let i = clipIndex + 1; i < track.clips.length; i++) {
        track.clips[i].timelineStartUs += delta;
      }
    }
    reconcileTransitions(track);
    return OK;
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
      for (let i = clipIndex + 1; i < track.clips.length; i++) {
        track.clips[i].timelineStartUs += newDur - oldDur;
      }
    } else {
      clip.timelineStartUs = target;
      clip.timelineDurationUs = end - target;
      remapKeyframes(clip, clip.timelineDurationUs - oldDur, clip.timelineDurationUs);
    }
  }
  reconcileTransitions(track);
  return OK;
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
export function applySplitToDraft(d: TimelineDoc, clipId: Uuid, timeUs: MicroSec): OpResult {
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
  reconcileTransitions(track);

  // UX nicety: keep the selection covering both halves.
  const selection = useEditorStore.getState().selection;
  if (selection.has(clipId)) useEditorStore.getState().addToSelection(second.id);
  return OK;
}

export function splitClipAt(clipId: Uuid, timeUs: MicroSec): OpResult {
  let result: OpResult = fail('unchanged');
  useDocStore.getState().mutate('split', 'Klip bölündü', (d) => {
    result = applySplitToDraft(d, clipId, timeUs);
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
 * C shortcut: split the selected clips under the playhead, or — when nothing
 * is selected — every clip under the playhead (unlocked tracks). One undo entry.
 */
export function splitAtPlayhead(): OpResult {
  const d = doc();
  const t = useEditorStore.getState().playheadUs;
  const selection = useEditorStore.getState().selection;
  const under = clipsAtTime(d, snapUsToFrameGrid(t, d.settings.fps));
  const targets = selection.size > 0 ? under.filter((id) => selection.has(id)) : under;
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

/** Q/W shortcuts: trim the start (Q) or end (W) of clips under the playhead to the playhead. */
export function trimSelectedToPlayhead(edge: TrimEdge): OpResult {
  const d = doc();
  const t = useEditorStore.getState().playheadUs;
  const selection = useEditorStore.getState().selection;
  const under = clipsAtTime(d, snapUsToFrameGrid(t, d.settings.fps));
  const targets = selection.size > 0 ? under.filter((id) => selection.has(id)) : under;
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

export function deleteClips(clipIds: readonly Uuid[], opts: { ripple?: boolean } = {}): OpResult {
  const d = doc();
  const deletable = clipIds.filter((id) => {
    const loc = locateClip(d, id);
    return loc !== null && !loc.track.locked;
  });
  if (deletable.length === 0) return fail('nothing to delete');
  const removing = new Set(deletable);
  const ripple = opts.ripple === true;

  const label = `${deletable.length} klip silindi${ripple ? ' (ripple)' : ''}`;
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
      reconcileTransitions(track);
    }
  });
  assertDocValidDev('deleteClips');

  const editor = useEditorStore.getState();
  const nextSelection = [...editor.selection].filter((id) => !removing.has(id));
  editor.setSelection(nextSelection);
  return OK;
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

function cloneClip(clip: Clip): Clip {
  const copy = JSON.parse(JSON.stringify(clip)) as Clip;
  if (isMediaClip(copy)) {
    // Transitions are cut metadata — they never survive copy/paste.
    delete copy.transitionIn;
    delete copy.transitionOut;
  }
  return copy;
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
 * Inserts a batch of prepared clips (already positioned, fresh ids assumed by
 * the caller) atomically: every clip must fit or the whole paste is rejected.
 */
function insertBatch(
  actionType: string,
  label: string,
  batch: { clip: Clip; trackId: Uuid }[],
): OpResult {
  const d = doc();
  const perTrack = new Map<Uuid, { start: MicroSec; end: MicroSec }[]>();
  for (const { clip, trackId } of batch) {
    const track = d.tracks.find((t) => t.id === trackId);
    if (!track) return fail('target track no longer exists');
    if (track.locked) return fail('target track is locked');
    if (track.type !== trackTypeForClipKind(clip.kind)) return fail('track type mismatch');
    if (clip.timelineStartUs < 0) return fail('before timeline start');
    if (!fitsInTrack(track, clip.timelineStartUs, clip.timelineDurationUs)) {
      return fail('overlaps an existing clip');
    }
    const list = perTrack.get(trackId) ?? [];
    for (const other of list) {
      if (clip.timelineStartUs < other.end && other.start < clipEndUs(clip)) {
        return fail('pasted clips overlap each other');
      }
    }
    list.push({ start: clip.timelineStartUs, end: clipEndUs(clip) });
    perTrack.set(trackId, list);
  }

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

/** Ctrl+V: paste the clipboard at the playhead (original tracks, offsets kept). */
export function pasteAtPlayhead(): OpResult {
  if (!clipboard || clipboard.length === 0) return fail('clipboard empty');
  const d = doc();
  const base = snapUsToFrameGrid(useEditorStore.getState().playheadUs, d.settings.fps);
  const batch = clipboard.map((e) => {
    const clip = cloneClip(e.clip);
    clip.id = uuidv7();
    clip.timelineStartUs = base + e.offsetUs;
    return { clip, trackId: e.trackId };
  });
  return insertBatch('paste', `${batch.length} klip yapıştırıldı`, batch);
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
// Markers / misc queries
// ---------------------------------------------------------------------------

export function addMarkerAtPlayhead(): void {
  const d = doc();
  const timeUs = snapUsToFrameGrid(useEditorStore.getState().playheadUs, d.settings.fps);
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
