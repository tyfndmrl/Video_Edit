/**
 * keyframeOps — every keyframe mutation of the timeline document.
 *
 * Deliberately its OWN module (not an appendix to state/timelineOps): the
 * keyframe editor is a self-contained slice, and keeping its ops here keeps the
 * shared op file free of a whole second vocabulary. It uses the same machinery
 * as every other op, so nothing about undo/autosave/validation is special:
 * - one committed op = one `docStore.mutate` = ONE history entry,
 * - a pointer gesture = one `docStore.beginTransaction` fed by the exported
 *   `apply*ToDraft` halves = ONE history entry for the whole drag,
 * - every committed op is followed by `assertDocValidDev`, which runs the full
 *   `validateTimelineDoc` (structure + document invariants). Invariant 4 is the
 *   one that matters here: per channel, keyframes are STRICTLY sorted by
 *   `timeUs`, unique, and inside [0, timelineDurationUs].
 *
 * TIME UNITS: every `timeUs` argument is CLIP-RELATIVE (schema semantics,
 * rendering-semantics §3.3). Callers convert from the absolute playhead with
 * `keyframeTimeAtPlayhead()` — which also snaps to the project frame grid.
 *
 * VALUE CLAMPING happens here, never in the UI: a slider, a typed number, a
 * gizmo drag and a keyframe must all be able to land on the same value, and the
 * bounds are the ones `state/timelineOps` uses for the static base values
 * (imported through `channelBounds`, not re-declared).
 */
import {
  frameToUs,
  usToFrame,
  snapUsToFrameGrid,
  type Clip,
  type Easing,
  type Keyframe,
  type MicroSec,
  type ProjectSettings,
  type Rational,
  type TimelineDoc,
  type Uuid,
} from '@videoedit/timeline-schema';
import { useDocStore } from '../../state/docStore';
import {
  applyClipAudioToDraft,
  applyClipOpacityToDraft,
  applyClipTransformToDraft,
  assertDocValidDev,
  type ClipTransformPatch,
  type OpResult,
} from '../../state/timelineOps';
import {
  CHANNEL_META,
  REASON_CHANNEL_UNAVAILABLE,
  channelBaseValue,
  channelBlockReason,
  channelIsAvailable,
  channelKeyframes,
  channelValueAt,
  clampChannelValue,
  clampClipTimeUs,
  keyframeIndexAt,
  locateClip,
  type KeyframeChannel,
} from './keyframeModel';

const OK: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });

/** Reason codes (stable English, like every other op family). */
export const REASON_CLIP_NOT_FOUND = 'clip not found';
export const REASON_TRACK_LOCKED = 'track is locked';
export { REASON_CHANNEL_UNAVAILABLE } from './keyframeModel';
export const REASON_NO_KEYFRAME = 'no keyframe at this time';
export const REASON_DUPLICATE = 'a keyframe already exists at this time';
export const REASON_INVALID_VALUE = 'invalid keyframe value';

const doc = (): TimelineDoc => useDocStore.getState().doc;

interface Target {
  clip: Clip;
  fps: Rational;
  settings: Pick<ProjectSettings, 'width' | 'height'>;
}

/**
 * Resolve + gate a clip/channel pair on a DRAFT document.
 *
 * `mode` is the whole point of the split:
 *  - 'create' — a NEW keyframe is about to appear, so every rule applies,
 *    including the combinations the export compiler rejects
 *    (`channelBlockReason`: a transitioned clip, scale-with-rotation).
 *  - 'edit'   — an EXISTING keyframe is moved / re-valued / removed. Those must
 *    stay possible even on a clip that is already in a forbidden combination
 *    (an older project, or a clip that got there before this gate existed);
 *    otherwise the only way out — clearing the channel — would be locked too.
 */
function target(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  mode: 'create' | 'edit' = 'edit',
): Target | { error: string } {
  const located = locateClip(d, clipId);
  if (located === null) return { error: REASON_CLIP_NOT_FOUND };
  if (located.track.locked) return { error: REASON_TRACK_LOCKED };
  if (mode === 'create') {
    const blocked = channelBlockReason(located.clip, channel);
    if (blocked !== null) return { error: blocked };
  } else if (!channelIsAvailable(located.clip, channel)) {
    return { error: REASON_CHANNEL_UNAVAILABLE };
  }
  return { clip: located.clip, fps: d.settings.fps, settings: d.settings };
}

/**
 * Why a keyframe cannot be ADDED at `(clipId, channel)`, or null.
 *
 * Same contract as `state/timelineOps`' `*BlockReason` helpers: the Inspector's
 * diamond is disabled with EXACTLY the rule the op enforces, so the panel never
 * offers a click that then fails.
 */
export function addKeyframeBlockReason(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
): string | null {
  const t = target(d, clipId, channel, 'create');
  return isError(t) ? t.error : null;
}

function isError(t: Target | { error: string }): t is { error: string } {
  return 'error' in t;
}

/** The mutable keyframe array for a channel, created on demand. */
function trackOf(clip: Clip, channel: KeyframeChannel): Keyframe[] {
  const existing = clip.keyframes[channel];
  if (existing) return existing;
  const created: Keyframe[] = [];
  clip.keyframes[channel] = created;
  return created;
}

/**
 * Drop an emptied channel from the document (absent, not `[]`).
 *
 * When the LAST keyframe of a channel disappears the property falls back to its
 * static base value — and that base is usually stale, so the picture would jump
 * at the exact moment the user "just removed a dot". `carryValue` is therefore
 * written into the base: removing the last keyframe freezes the property at the
 * value it had, which is what the user was looking at.
 */
function normalizeChannel(
  d: TimelineDoc,
  clip: Clip,
  channel: KeyframeChannel,
  carryValue: number | null,
): void {
  const kfs = clip.keyframes[channel];
  if (!kfs || kfs.length > 0) return;
  delete clip.keyframes[channel];
  if (carryValue === null) return;
  writeBaseValue(d, clip, channel, carryValue);
}

/** Write a channel's STATIC value through the existing base-value ops. */
function writeBaseValue(
  d: TimelineDoc,
  clip: Clip,
  channel: KeyframeChannel,
  value: number,
): void {
  switch (channel) {
    case 'x':
    case 'y':
    case 'scale':
    case 'rotationDeg':
      applyClipTransformToDraft(d, [clip.id], { [channel]: value } as ClipTransformPatch);
      return;
    case 'opacity':
      applyClipOpacityToDraft(d, [clip.id], value);
      return;
    case 'volume':
      applyClipAudioToDraft(d, [clip.id], { volume: value });
      return;
  }
}

/** Insert keeping the array strictly sorted by `timeUs` (invariant 4). */
function insertSorted(kfs: Keyframe[], kf: Keyframe): void {
  const i = kfs.findIndex((k) => k.timeUs > kf.timeUs);
  if (i < 0) kfs.push(kf);
  else kfs.splice(i, 0, kf);
}

/**
 * Easing a NEW keyframe inherits: the preceding keyframe's.
 *
 * `Keyframe.easing` describes the segment AFTER the keyframe (§3.3). Inserting
 * K inside an existing A->B segment splits it into A->K and K->B; A keeps its
 * easing for A->K, so K must copy it for K->B or the second half of a curve the
 * user already shaped would silently snap back to linear.
 */
function inheritedEasing(kfs: readonly Keyframe[], timeUs: MicroSec): Easing {
  let easing: Easing = { type: 'linear' };
  for (const k of kfs) {
    if (k.timeUs >= timeUs) break;
    easing = k.easing;
  }
  return easing;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Where a dragged keyframe may actually land.
 *
 * Two rules, in this order:
 * 1. It stays STRICTLY between its neighbours and inside [0, duration]. That is
 *    invariant 4 expressed as a corridor: clamping is what keeps a drag from
 *    ever producing an unsorted or duplicated track, so the op can never fail
 *    mid-gesture and leave the drag looking broken.
 * 2. Inside that corridor it prefers a PROJECT FRAME BOUNDARY (§3.4: the
 *    exporter samples per output frame). When the corridor is narrower than one
 *    frame — adjacent keyframes — the corridor wins and the time is off-grid;
 *    refusing to move at all would be worse.
 */
export function clampKeyframeTime(
  kfs: readonly Keyframe[],
  index: number,
  targetUs: MicroSec,
  durationUs: MicroSec,
  fps: Rational,
): MicroSec {
  const prev = index > 0 ? kfs[index - 1] : undefined;
  const next = index + 1 < kfs.length ? kfs[index + 1] : undefined;
  const lo = prev ? prev.timeUs + 1 : 0;
  const hi = next ? next.timeUs - 1 : durationUs;
  if (lo > hi) return kfs[index].timeUs; // no room at all: stay put

  const wanted = clamp(Math.round(targetUs), 0, durationUs);
  const snapped = snapUsToFrameGrid(wanted, fps);
  if (snapped >= lo && snapped <= hi) return snapped;

  // Nearest frame boundary that still fits the corridor.
  let loFrame = usToFrame(lo, fps);
  if (frameToUs(loFrame, fps) < lo) loFrame += 1;
  let hiFrame = usToFrame(hi, fps);
  if (frameToUs(hiFrame, fps) > hi) hiFrame -= 1;
  if (loFrame > hiFrame) return clamp(wanted, lo, hi); // corridor < 1 frame
  return frameToUs(clamp(usToFrame(snapped, fps), loFrame, hiFrame), fps);
}

// ---------------------------------------------------------------------------
// Draft halves (used inside pointer-gesture transactions)
// ---------------------------------------------------------------------------

/**
 * Insert a keyframe at `timeUs`.
 *
 * `value` omitted = "capture what is on screen": the sampled curve value when
 * the channel is already animated (so adding a dot never changes the picture),
 * the STATIC BASE value when the channel is still empty (the first keyframe of
 * a channel continues the value the clip already had).
 */
export function applyAddKeyframeToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  value?: number,
): OpResult {
  const t = target(d, clipId, channel, 'create');
  if (isError(t)) return fail(t.error);
  const { clip } = t;
  const at = clampClipTimeUs(clip, timeUs);
  if (keyframeIndexAt(clip, channel, at) >= 0) return fail(REASON_DUPLICATE);

  const raw = value ?? channelValueAt(clip, channel, at);
  if (raw === null) return fail(REASON_INVALID_VALUE);
  const clamped = clampChannelValue(channel, raw, t.settings);
  if (clamped === null) return fail(REASON_INVALID_VALUE);

  const kfs = trackOf(clip, channel);
  insertSorted(kfs, { timeUs: at, value: clamped, easing: inheritedEasing(kfs, at) });
  return OK;
}

/** Remove the keyframe sitting exactly at `timeUs`. */
export function applyRemoveKeyframeToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): OpResult {
  const t = target(d, clipId, channel);
  if (isError(t)) return fail(t.error);
  const { clip } = t;
  const at = clampClipTimeUs(clip, timeUs);
  const kfs = clip.keyframes[channel];
  if (!kfs) return fail(REASON_NO_KEYFRAME);
  const i = kfs.findIndex((k) => k.timeUs === at);
  if (i < 0) return fail(REASON_NO_KEYFRAME);
  const removed = kfs[i];
  kfs.splice(i, 1);
  normalizeChannel(d, clip, channel, removed.value);
  return OK;
}

export interface KeyframeMoveResult {
  ok: boolean;
  reason?: string;
  /** Where the keyframe actually ended up (unchanged on failure). */
  timeUs: MicroSec;
}

/** Move the keyframe at `fromTimeUs` to (a legal position near) `toTimeUs`. */
export function applyMoveKeyframeToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  fromTimeUs: MicroSec,
  toTimeUs: MicroSec,
): KeyframeMoveResult {
  const t = target(d, clipId, channel);
  if (isError(t)) return { ok: false, reason: t.error, timeUs: fromTimeUs };
  const { clip } = t;
  const kfs = clip.keyframes[channel];
  if (!kfs) return { ok: false, reason: REASON_NO_KEYFRAME, timeUs: fromTimeUs };
  const i = kfs.findIndex((k) => k.timeUs === fromTimeUs);
  if (i < 0) return { ok: false, reason: REASON_NO_KEYFRAME, timeUs: fromTimeUs };

  const landed = clampKeyframeTime(kfs, i, toTimeUs, clip.timelineDurationUs, t.fps);
  kfs[i].timeUs = landed;
  return { ok: true, timeUs: landed };
}

/**
 * Set the value of a channel AT a time: updates the keyframe there, or creates
 * one when there is none ("auto-keyframe" — an already animated property must
 * stay animated when the user nudges it at a new instant).
 */
export function applyKeyframeValueToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  value: number,
): OpResult {
  const t = target(d, clipId, channel);
  if (isError(t)) return fail(t.error);
  const { clip } = t;
  const clamped = clampChannelValue(channel, value, t.settings);
  if (clamped === null) return fail(REASON_INVALID_VALUE);
  const at = clampClipTimeUs(clip, timeUs);
  const kfs = trackOf(clip, channel);
  const i = kfs.findIndex((k) => k.timeUs === at);
  if (i >= 0) kfs[i].value = clamped;
  else insertSorted(kfs, { timeUs: at, value: clamped, easing: inheritedEasing(kfs, at) });
  return OK;
}

export function applySetEasingToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  easing: Easing,
): OpResult {
  const t = target(d, clipId, channel);
  if (isError(t)) return fail(t.error);
  const kfs = t.clip.keyframes[channel];
  if (!kfs) return fail(REASON_NO_KEYFRAME);
  const i = kfs.findIndex((k) => k.timeUs === timeUs);
  if (i < 0) return fail(REASON_NO_KEYFRAME);
  kfs[i].easing = easing;
  return OK;
}

/**
 * Route a TRANSFORM patch to the right place for an ANIMATED clip.
 *
 * The gizmo and the Inspector produce the same patch shape; where it lands
 * depends on the channel: an animated channel gets a keyframe written at
 * `timeUs` (writing the base instead would change nothing on screen — the
 * sampled curve wins — which is exactly the "it does nothing" defect this
 * replaces), a still-static channel gets its base value as before.
 */
export function applyTransformPatchToDraft(
  d: TimelineDoc,
  clipId: Uuid,
  patch: ClipTransformPatch,
  timeUs: MicroSec,
): OpResult {
  const located = locateClip(d, clipId);
  if (located === null) return fail(REASON_CLIP_NOT_FOUND);
  if (located.track.locked) return fail(REASON_TRACK_LOCKED);
  const clip = located.clip;

  const base: ClipTransformPatch = {};
  let baseKeys = 0;
  let animatedWrites = 0;
  for (const channel of ['x', 'y', 'scale', 'rotationDeg'] as const) {
    const value = patch[channel];
    if (value === undefined) continue;
    if (channelKeyframes(clip, channel).length > 0) {
      applyKeyframeValueToDraft(d, clipId, channel, timeUs, value);
      animatedWrites++;
    } else {
      base[channel] = value;
      baseKeys++;
    }
  }
  if (baseKeys > 0) {
    // The base half can REFUSE (rotation on a scale-animated clip — the export
    // compiler crops that combination). Swallowing it here would turn a refusal
    // into "the gizmo did nothing", which is the defect the guard removes.
    const written = applyClipTransformToDraft(d, [clipId], base);
    if (!written.ok) return written;
  }
  return baseKeys > 0 || animatedWrites > 0 ? OK : fail('empty transform patch');
}

// ---------------------------------------------------------------------------
// Committed ops (one history entry each)
// ---------------------------------------------------------------------------

const label = (channel: KeyframeChannel, verb: string): string =>
  `${CHANNEL_META[channel].label} keyframe ${verb}`;

function run(
  actionType: string,
  historyLabel: string,
  recipe: (d: TimelineDoc) => OpResult,
): OpResult {
  let result: OpResult = fail(REASON_CLIP_NOT_FOUND);
  useDocStore.getState().mutate(actionType, historyLabel, (d) => {
    result = recipe(d);
  });
  assertDocValidDev(actionType);
  return result;
}

export function addKeyframe(
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  value?: number,
): OpResult {
  return run('keyframeAdd', label(channel, 'eklendi'), (d) =>
    applyAddKeyframeToDraft(d, clipId, channel, timeUs, value),
  );
}

export function removeKeyframe(
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): OpResult {
  return run('keyframeRemove', label(channel, 'kaldırıldı'), (d) =>
    applyRemoveKeyframeToDraft(d, clipId, channel, timeUs),
  );
}

/**
 * The Inspector's diamond button: a keyframe exactly at `timeUs` is removed,
 * otherwise one is added there capturing the current value. One toggle = one
 * history entry either way.
 */
export function toggleKeyframe(
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): OpResult {
  const located = locateClip(doc(), clipId);
  if (located === null) return fail(REASON_CLIP_NOT_FOUND);
  const at = clampClipTimeUs(located.clip, timeUs);
  return keyframeIndexAt(located.clip, channel, at) >= 0
    ? removeKeyframe(clipId, channel, at)
    : addKeyframe(clipId, channel, at);
}

export function moveKeyframe(
  clipId: Uuid,
  channel: KeyframeChannel,
  fromTimeUs: MicroSec,
  toTimeUs: MicroSec,
): OpResult {
  return run('keyframeMove', label(channel, 'taşındı'), (d) => {
    const moved = applyMoveKeyframeToDraft(d, clipId, channel, fromTimeUs, toTimeUs);
    return moved.ok ? OK : fail(moved.reason ?? REASON_NO_KEYFRAME);
  });
}

export function setKeyframeValue(
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  value: number,
): OpResult {
  return run('keyframeValue', label(channel, 'değeri değiştirildi'), (d) =>
    applyKeyframeValueToDraft(d, clipId, channel, timeUs, value),
  );
}

export function setKeyframeEasing(
  clipId: Uuid,
  channel: KeyframeChannel,
  timeUs: MicroSec,
  easing: Easing,
): OpResult {
  return run('keyframeEasing', label(channel, 'geçişi değiştirildi'), (d) =>
    applySetEasingToDraft(d, clipId, channel, timeUs, easing),
  );
}

/**
 * Drop every keyframe of a channel; the property becomes static again at the
 * value it has at `atTimeUs` (the playhead), so clearing an animation freezes
 * the picture instead of snapping it back to a stale base.
 */
export function clearChannel(
  clipId: Uuid,
  channel: KeyframeChannel,
  atTimeUs?: MicroSec,
): OpResult {
  return run('keyframeClear', `${CHANNEL_META[channel].label} animasyonu temizlendi`, (d) => {
    const t = target(d, clipId, channel);
    if (isError(t)) return fail(t.error);
    const { clip } = t;
    const kfs = clip.keyframes[channel];
    if (!kfs || kfs.length === 0) return fail(REASON_NO_KEYFRAME);
    const carry =
      atTimeUs === undefined
        ? kfs[0].value
        : (channelValueAt(clip, channel, clampClipTimeUs(clip, atTimeUs)) ??
          channelBaseValue(clip, channel));
    kfs.length = 0;
    normalizeChannel(d, clip, channel, carry);
    return OK;
  });
}
