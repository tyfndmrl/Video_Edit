/**
 * Document-wide invariants for the timeline contract. Enforced via zod
 * `superRefine`; the C# export compiler must validate the same rules with the
 * same formulas.
 *
 * Rules:
 * 1. Clips in a track are sorted by timelineStartUs and never overlap
 *    (clip[i].end <= clip[i+1].start).
 * 2. sourceOutUs > sourceInUs; when asset durations are known,
 *    sourceOutUs <= asset.durationUs.
 * 3. timelineDurationUs === roundHalfUp((sourceOutUs - sourceInUs) / speed.rate).
 * 4. Keyframes are sorted by timeUs, unique per timeUs, within
 *    [0, timelineDurationUs].
 * 5. Transitions (rendering-semantics §5): clips stay adjacent; for transition
 *    duration D the export compiler extends A.sourceOut by
 *    roundHalfUp((D/2)*A.speed.rate) and pulls B.sourceIn back by
 *    roundHalfUp((D/2)*B.speed.rate) (source-domain handles, §5.2). The source
 *    media must have that much slack at the cut edge. Per side: the HEAD handle
 *    (B.sourceIn) is always checked, the TAIL handle (A.sourceOut vs. the asset
 *    duration) only when `assetDurations` is provided; a side whose source has
 *    no time axis (`hasSourceTimeAxis` false — a still image) is exempt from
 *    both, exactly like the compiler's `IsStillInput` branch. Independently:
 *    - D must sit exactly on the project fps grid and correspond to an EVEN
 *      frame count >= 2 (§5.2 even-frame snap, so D/2 is a whole frame count).
 *    - D must not exceed half of the shorter neighboring clip's timeline
 *      duration (editor-level upper bound, §5.2).
 *    - The transition edge must have an adjacent media-clip neighbor, and the
 *      transition must be symmetric: A.transitionOut and B.transitionIn on the
 *      same cut must BOTH exist and be deep-equal (type + durationUs).
 *    - The two clips of a transition cut must have an EQUAL `transform`. See
 *      the block comment above `checkTransitionPlacement` for the rule's origin
 *      and for why equality of the transform is exactly equality of the layout.
 * 6. Effect params (rendering-semantics §4): colorAdjust allows exactly
 *    {brightness, contrast, saturation, temperature, tint, exposure}, each a
 *    number in [-1..1]; lut requires assetId (UUID string) + intensity (number
 *    in [0..1]) and nothing else.
 * 7. All *Us fields are non-negative integers (enforced structurally by the
 *    zod schema).
 * 8. Audio fades cannot overlap or outrun the clip:
 *    fadeInUs + fadeOutUs <= timelineDurationUs. This is the SAME rule the
 *    export compiler enforces (ExportCompiler.ValidateMediaClip) — a document
 *    that breaks it is rejected with HTTP 422 at export time, so the editor
 *    must never be able to produce one.
 * 9. A drawn clip's transform.scale is strictly positive (compiler:
 *    ExportCompiler.ValidateGeometry). Audio clips produce no visual layer and
 *    are skipped, exactly like the compiler skips them.
 *
 * Rule 3 has a SECOND half that lives outside `superRefine`: the export
 * compiler additionally requires both clip EDGES (`timelineStartUs` and
 * `timelineStartUs + timelineDurationUs`) to sit exactly on the project fps
 * grid. That gate is exported separately as `exportFrameGridIssues` — see the
 * block comment above it for why the rule is about edges and not about the
 * duration, and why it is not folded into the document-wide refinement.
 */

import {
  clipTimelineDurationUs,
  frameToUs,
  isOnFrameGrid,
  roundHalfUp,
  usToFrame,
  type MicroSec,
  type Rational,
} from './time.js';
import { hasSourceTimeAxis, isMediaClip, type Clip, type Effect, type MediaClip, type ProjectSettings, type TimelineDoc, type Track, type Transform, type Transition } from './schema.js';

// ---------------------------------------------------------------------------
// Transform bounds shared with the export compiler
//
// These live in the schema package because BOTH sides need the same numbers:
// the editor clamps writes against them, the C# compiler validates against its
// own copy. Whenever a value here changes, the backend constant named next to
// it must change in the same commit.
// ---------------------------------------------------------------------------

/**
 * Upper bound (px) for a single rendered layer box.
 * MIRRORS backend `LayerGeometry.MaxLayerDimension` (8192) — the compiler
 * rejects a clip whose scaled box exceeds it (UnsupportedFeatureException
 * "transform-scale"). The two values MUST stay equal.
 */
export const MAX_LAYER_DIMENSION = 8192;

/** Decimals a transform.scale is stored with (undo patches stay clean). */
export const TRANSFORM_SCALE_DECIMALS = 3;

/**
 * Smallest scale the editor may write. The compiler only requires scale > 0,
 * but 0 is not a usable editing value: a zero-scale clip draws nothing and
 * leaves no gizmo box to drag back, so the floor is a positive one instead.
 * The preview gizmo uses this SAME constant — a control must never propose a
 * value the op would silently clamp.
 */
export const TRANSFORM_SCALE_MIN = 0.01;

/**
 * Largest scale a clip may take in THIS project (rendering-semantics §2.2).
 *
 * The real ceiling is not a constant: the compiler measures the scaled layer
 * box, so max(width, height) * scale <= MAX_LAYER_DIMENSION. At 1080p that is
 * ~4.266, at 4K ~2.133.
 *
 * Floored — never rounded — to the stored precision: the compiler computes
 * roundHalfUp(dimension * scale), so a value rounded UP at the third decimal
 * (e.g. 4.267 at 1920 px -> 8193) would land one pixel past the bound and be
 * rejected at export.
 */
export function maxScaleFor(settings: Pick<ProjectSettings, 'width' | 'height'>): number {
  const longest = Math.max(settings.width, settings.height);
  if (!Number.isFinite(longest) || longest <= 0) return TRANSFORM_SCALE_MIN;
  const factor = 10 ** TRANSFORM_SCALE_DECIMALS;
  const floored = Math.floor((MAX_LAYER_DIMENSION / longest) * factor) / factor;
  // A composition larger than 819200 px would drive the ceiling under the
  // floor; keep max >= min so a UI range control never inverts.
  return Math.max(TRANSFORM_SCALE_MIN, floored);
}

/** Known asset durations (us), keyed by assetId. */
export type AssetDurations = ReadonlyMap<string, MicroSec> | Readonly<Record<string, MicroSec>>;

/** Minimal structural view of zod's RefinementCtx (keeps us decoupled from zod internals). */
export interface InvariantIssueSink {
  addIssue(issue: { code: 'custom'; message: string; path?: (string | number)[] }): void;
}

function lookupDuration(assetDurations: AssetDurations | undefined, assetId: string): MicroSec | undefined {
  if (assetDurations === undefined) return undefined;
  if (assetDurations instanceof Map) return assetDurations.get(assetId);
  return (assetDurations as Readonly<Record<string, MicroSec>>)[assetId];
}

function clipEndUs(clip: Clip): MicroSec {
  return clip.timelineStartUs + clip.timelineDurationUs;
}

/**
 * Source-domain handle for one side of a cut (rendering-semantics §5.2):
 * roundHalfUp((D/2) * speed.rate). Speed converts the timeline-domain half
 * window back into the clip's source domain.
 */
function transitionHandleUs(durationUs: MicroSec, rate: number): MicroSec {
  return roundHalfUp((durationUs / 2) * rate);
}

/**
 * Every transform field, because the compiler's layout depends on every one of
 * them: it feeds `clip.Transform` straight into `LayerGeometry.Compute`.
 *
 * The list is the WHOLE record on purpose (not a hand-picked subset). A field
 * added to `TransformSchema` and forgotten here would silently reopen the hole
 * this rule closes — divergence in the new field would pass the editor's gate
 * and fail in the render worker, which is exactly the failure mode the rule
 * exists to prevent. The assertion below turns that omission into a COMPILE
 * error: `Exclude` is `never` only while the list covers every key.
 */
const PLACEMENT_FIELDS = ['x', 'y', 'scale', 'rotationDeg', 'anchorX', 'anchorY'] as const;

const _placementFieldsCoverTransform: Exclude<
  keyof Transform,
  (typeof PLACEMENT_FIELDS)[number]
> extends never
  ? true
  : ['transform field missing from PLACEMENT_FIELDS', Exclude<keyof Transform, (typeof PLACEMENT_FIELDS)[number]>] = true;
void _placementFieldsCoverTransform;

/**
 * Rule 5, layout half: the two clips of a transition cut must have an EQUAL
 * transform.
 *
 * WHY IT IS A DOCUMENT INVARIANT AND NOT AN EDITOR-SIDE PREFERENCE
 * ---------------------------------------------------------------
 * `xfade` folds the two clips of a cut into ONE stream and requires both inputs
 * to have the same size, so the export compiler refuses a cut whose two sides
 * are laid out differently (ExportCompiler.cs, the `open.Placement != placement`
 * branch: "geçişli kliplerin yerleşimi aynı olmalıdır"). That check lives in
 * COMPILE, not in `ExportCompiler.Validate`, so the API's 422 pre-gate cannot
 * see it: a divergent document is accepted, queued, and only then fails in the
 * worker. The editor must therefore never produce one, and this invariant is
 * what proves it did not — the dev document gate (docStore.assertDocGateDev)
 * runs on EVERY commit, so a future op that writes a transition or re-joins a
 * cut without aligning the chain fails at the write, not at the render.
 *
 * WHY EQUAL TRANSFORM == EQUAL LAYOUT. For a media clip the compiler's scale
 * box is the PROJECT canvas (fit=contain, §2.2) — `PlacementOf` passes only
 * `plan.Width/Height`, never the source size — so the layout is a pure function
 * of the transform and equal transforms are equal layouts. Raster clips (text /
 * shape / sticker) DO fold in their natural size, but they can never be a side
 * of a transition: the compiler rejects that cut outright ("metin-şekil-çıkartma
 * klibine geçiş yapılamaz") and `isMediaClip` below keeps this check on the same
 * side of that line.
 *
 * Scope note: the compiler's layout also folds in ANIMATED scale/rotation
 * (`PlacementTransform` overrides the static field with the keyframe extreme),
 * which this rule deliberately does not model. It does not have to: a keyframed
 * clip cannot carry a transition at all — the compiler rejects that combination
 * with its own typed error ("transition-keyframes") and the editor refuses to
 * build it (timelineOps.addTransitionBlockReason). Comparing the static
 * transforms is therefore complete for every document that can reach the
 * renderer, and this check stays a pure function of the document.
 *
 * Checked once per CUT (on the outgoing edge only): a cut whose sides disagree
 * is one fact, and reporting it twice would just double every message. A
 * one-sided transition never reaches this check — the symmetry rule above it
 * already reported that, and it is the more basic failure.
 */
function checkTransitionPlacement(
  ctx: InvariantIssueSink,
  trackIndex: number,
  clipIndex: number,
  outgoing: MediaClip,
  incoming: MediaClip,
): void {
  const differing = PLACEMENT_FIELDS.filter(
    (field) => outgoing.transform[field] !== incoming.transform[field],
  );
  if (differing.length === 0) return;
  const detail = differing
    .map((f) => `${f}: ${outgoing.transform[f]} vs ${incoming.transform[f]}`)
    .join(', ');
  ctx.addIssue({
    code: 'custom',
    message:
      'transition placement violated: both clips of a transition cut must have the same '
      + `transform (xfade folds them into one stream), got ${detail}`,
    path: ['tracks', trackIndex, 'clips', clipIndex, 'transform'],
  });
}

function checkTransitionEdge(
  ctx: InvariantIssueSink,
  trackIndex: number,
  clips: readonly Clip[],
  clipIndex: number,
  edge: 'transitionIn' | 'transitionOut',
  transition: Transition,
  fps: Rational,
  assetDurations: AssetDurations | undefined,
): void {
  const clip = clips[clipIndex] as MediaClip;
  const path = ['tracks', trackIndex, 'clips', clipIndex, edge];
  const neighborIndex = edge === 'transitionIn' ? clipIndex - 1 : clipIndex + 1;
  const neighbor = neighborIndex >= 0 && neighborIndex < clips.length ? clips[neighborIndex] : undefined;

  // Adjacency: a transition lives on a cut between two touching media clips.
  const adjacent =
    neighbor !== undefined &&
    isMediaClip(neighbor) &&
    (edge === 'transitionIn'
      ? clipEndUs(neighbor) === clip.timelineStartUs
      : clipEndUs(clip) === neighbor.timelineStartUs);
  if (!adjacent) {
    ctx.addIssue({
      code: 'custom',
      message: `${edge} requires an adjacent ${edge === 'transitionIn' ? 'preceding' : 'following'} media clip (no gap, no overlap)`,
      path,
    });
    return;
  }

  // Symmetry: the neighbor across the cut must carry a deep-equal transition
  // on its opposite edge (a one-sided transition is a contract violation).
  const counterpart = edge === 'transitionIn' ? neighbor.transitionOut : neighbor.transitionIn;
  if (counterpart === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `transition symmetry violated: ${edge} has no matching ${edge === 'transitionIn' ? 'transitionOut' : 'transitionIn'} on the adjacent clip`,
      path,
    });
  } else if (counterpart.type !== transition.type || counterpart.durationUs !== transition.durationUs) {
    ctx.addIssue({
      code: 'custom',
      message: `transition symmetry violated: both sides of the cut must be deep-equal, got ${transition.type}/${transition.durationUs}us vs ${counterpart.type}/${counterpart.durationUs}us`,
      path,
    });
  }

  // Layout half of the rule — once per cut, from the outgoing side.
  if (edge === 'transitionOut' && counterpart !== undefined) {
    checkTransitionPlacement(ctx, trackIndex, clipIndex, clip, neighbor);
  }

  // D must sit exactly on the project fps grid and be an EVEN frame count >= 2
  // (rendering-semantics §5.2 even-frame snap, so D/2 is a whole frame count).
  const d = transition.durationUs;
  const dFrames = usToFrame(d, fps);
  if (frameToUs(dFrames, fps) !== d) {
    ctx.addIssue({
      code: 'custom',
      message: `transition duration ${d}us is not on the project fps frame grid (nearest frame count ${dFrames} = ${frameToUs(dFrames, fps)}us)`,
      path: [...path, 'durationUs'],
    });
  } else if (dFrames < 2 || dFrames % 2 !== 0) {
    ctx.addIssue({
      code: 'custom',
      message: `transition duration ${d}us must be an even frame count >= 2 on the project fps grid, got ${dFrames} frame(s)`,
      path: [...path, 'durationUs'],
    });
  }

  // D must not exceed half of the shorter neighboring clip.
  const shorter = Math.min(clip.timelineDurationUs, neighbor.timelineDurationUs);
  if (d * 2 > shorter) {
    ctx.addIssue({
      code: 'custom',
      message: `transition duration ${d}us exceeds half of the shorter neighboring clip (${shorter}us)`,
      path: [...path, 'durationUs'],
    });
  }

  // Handle rule (rendering-semantics §5.2, source-domain, speed-aware):
  //   sourceOut + roundHalfUp((D/2)*rateA) <= assetA.durationUs
  //   sourceIn  - roundHalfUp((D/2)*rateB) >= 0
  //
  // The rule is about SOURCE TIME, so it applies per side and only to a side
  // whose source HAS a time axis. A still image is opened with `-loop 1` and
  // yields as many frames as the window asks for, so it always has a handle —
  // the compiler skips these very checks for it (`!next.IsStillInput`, and
  // still clips never enter the source-range ledger). Without this exemption a
  // crossfade between two photographs is impossible in the editor while the
  // renderer accepts it happily.
  const outgoing = edge === 'transitionIn' ? neighbor : clip; // clip A (before the cut)
  const incoming = edge === 'transitionIn' ? clip : neighbor; // clip B (after the cut)
  const outgoingClipIndex = edge === 'transitionIn' ? neighborIndex : clipIndex;
  const incomingClipIndex = edge === 'transitionIn' ? clipIndex : neighborIndex;
  const halfOut = transitionHandleUs(d, outgoing.speed.rate);
  const halfIn = transitionHandleUs(d, incoming.speed.rate);

  // Head handle: bounded by sourceInUs alone, so it needs NO asset duration —
  // and the compiler enforces it unconditionally. Skipping it when durations
  // are unknown would let a document pass this validator and still be rejected
  // with HTTP 422 at export.
  if (hasSourceTimeAxis(incoming) && incoming.sourceInUs < halfIn) {
    ctx.addIssue({
      code: 'custom',
      message: `transition handle missing: incoming clip needs sourceInUs >= ${halfIn}us (roundHalfUp((D/2)*rate)), got ${incoming.sourceInUs}us`,
      path: ['tracks', trackIndex, 'clips', incomingClipIndex, 'sourceInUs'],
    });
  }

  // Tail handle: needs the asset duration, which the caller may not have.
  if (assetDurations === undefined || !hasSourceTimeAxis(outgoing)) return;
  const outgoingAssetDuration = lookupDuration(assetDurations, outgoing.assetId);
  if (outgoingAssetDuration !== undefined && outgoing.sourceOutUs + halfOut > outgoingAssetDuration) {
    ctx.addIssue({
      code: 'custom',
      message: `transition handle missing: outgoing clip needs sourceOutUs + ${halfOut}us (roundHalfUp((D/2)*rate)) <= asset duration ${outgoingAssetDuration}us, got sourceOutUs=${outgoing.sourceOutUs}us`,
      path: ['tracks', trackIndex, 'clips', outgoingClipIndex, 'sourceOutUs'],
    });
  }
}

// ---------- Effect params (rendering-semantics §4, document-level check) ----------

const COLOR_ADJUST_KEYS = new Set(['brightness', 'contrast', 'saturation', 'temperature', 'tint', 'exposure']);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function checkEffect(ctx: InvariantIssueSink, effect: Effect, path: (string | number)[]): void {
  const params = effect.params;
  if (effect.type === 'colorAdjust') {
    for (const [key, value] of Object.entries(params)) {
      if (!COLOR_ADJUST_KEYS.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `unrecognized colorAdjust param '${key}' (allowed: brightness, contrast, saturation, temperature, tint, exposure)`,
          path: [...path, 'params', key],
        });
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
        ctx.addIssue({
          code: 'custom',
          message: `colorAdjust param '${key}' must be a number in [-1, 1], got ${String(value)}`,
          path: [...path, 'params', key],
        });
      }
    }
    return;
  }
  // effect.type === 'lut'
  const assetId = params['assetId'];
  if (typeof assetId !== 'string' || !UUID_RE.test(assetId)) {
    ctx.addIssue({
      code: 'custom',
      message: `lut param 'assetId' must be a UUID string, got ${String(assetId)}`,
      path: [...path, 'params', 'assetId'],
    });
  }
  const intensity = params['intensity'];
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    ctx.addIssue({
      code: 'custom',
      message: `lut param 'intensity' must be a number in [0, 1], got ${String(intensity)}`,
      path: [...path, 'params', 'intensity'],
    });
  }
  for (const key of Object.keys(params)) {
    if (key !== 'assetId' && key !== 'intensity') {
      ctx.addIssue({
        code: 'custom',
        message: `unrecognized lut param '${key}' (allowed: assetId, intensity)`,
        path: [...path, 'params', key],
      });
    }
  }
}

function checkClip(
  ctx: InvariantIssueSink,
  trackIndex: number,
  clips: readonly Clip[],
  clipIndex: number,
  assetDurations: AssetDurations | undefined,
): void {
  const clip = clips[clipIndex];
  const path = ['tracks', trackIndex, 'clips', clipIndex];

  // 8. Audio fades must fit inside the clip and never overlap each other.
  // Duration-shrinking ops (trim, split, roll) have to re-clamp the fades they
  // did not touch, or the document silently becomes unexportable.
  if (isMediaClip(clip) && clip.audio !== null) {
    const { fadeInUs, fadeOutUs } = clip.audio;
    if (fadeInUs + fadeOutUs > clip.timelineDurationUs) {
      ctx.addIssue({
        code: 'custom',
        message: `audio fades (${fadeInUs}+${fadeOutUs}us) exceed the clip duration (${clip.timelineDurationUs}us)`,
        path: [...path, 'audio'],
      });
    }
  }

  // 9. A drawn clip must have a positive scale (the compiler rejects <= 0).
  // The MAX_LAYER_DIMENSION ceiling is deliberately NOT a document invariant:
  // changing the project resolution can legitimately push existing clips past
  // it, and failing every later op would be worse than the compiler's
  // actionable 422. maxScaleFor() clamps that side at write time instead.
  if (clip.kind !== 'audio' && !(clip.transform.scale > 0)) {
    ctx.addIssue({
      code: 'custom',
      message: `transform.scale must be greater than 0 (a zero/negative scale draws nothing and the export compiler rejects it), got ${clip.transform.scale}`,
      path: [...path, 'transform', 'scale'],
    });
  }

  // 1. Ordering + no overlap with the previous clip.
  if (clipIndex > 0) {
    const prev = clips[clipIndex - 1];
    if (clip.timelineStartUs < prev.timelineStartUs) {
      ctx.addIssue({
        code: 'custom',
        message: 'clips must be sorted by timelineStartUs',
        path: [...path, 'timelineStartUs'],
      });
    } else if (clipEndUs(prev) > clip.timelineStartUs) {
      ctx.addIssue({
        code: 'custom',
        message: `clips must not overlap: previous clip ends at ${clipEndUs(prev)}us, this clip starts at ${clip.timelineStartUs}us`,
        path: [...path, 'timelineStartUs'],
      });
    }
  }

  // 2 + 3. Source range and the speed/duration formula (media clips only).
  if (isMediaClip(clip)) {
    if (clip.sourceOutUs <= clip.sourceInUs) {
      ctx.addIssue({
        code: 'custom',
        message: `sourceOutUs (${clip.sourceOutUs}) must be greater than sourceInUs (${clip.sourceInUs})`,
        path: [...path, 'sourceOutUs'],
      });
    } else {
      const expected = clipTimelineDurationUs(clip.sourceInUs, clip.sourceOutUs, clip.speed.rate);
      if (clip.timelineDurationUs !== expected) {
        ctx.addIssue({
          code: 'custom',
          message: `timelineDurationUs must equal round((sourceOutUs - sourceInUs) / speed.rate) = ${expected}, got ${clip.timelineDurationUs}`,
          path: [...path, 'timelineDurationUs'],
        });
      }
    }
    const assetDuration = lookupDuration(assetDurations, clip.assetId);
    if (assetDuration !== undefined && clip.sourceOutUs > assetDuration) {
      ctx.addIssue({
        code: 'custom',
        message: `sourceOutUs (${clip.sourceOutUs}) exceeds asset duration (${assetDuration})`,
        path: [...path, 'sourceOutUs'],
      });
    }
  }

  // 6. Effect params (document-level, schema output unchanged).
  for (let ei = 0; ei < clip.effects.length; ei++) {
    checkEffect(ctx, clip.effects[ei], [...path, 'effects', ei]);
  }

  // 4. Keyframe tracks: sorted, unique timeUs, within [0, timelineDurationUs].
  for (const [prop, kfs] of Object.entries(clip.keyframes)) {
    if (!kfs) continue;
    for (let ki = 0; ki < kfs.length; ki++) {
      const kf = kfs[ki];
      const kfPath = [...path, 'keyframes', prop, ki, 'timeUs'];
      if (kf.timeUs < 0 || kf.timeUs > clip.timelineDurationUs) {
        ctx.addIssue({
          code: 'custom',
          message: `keyframe timeUs ${kf.timeUs} is outside [0, ${clip.timelineDurationUs}]`,
          path: kfPath,
        });
      }
      if (ki > 0 && kf.timeUs <= kfs[ki - 1].timeUs) {
        ctx.addIssue({
          code: 'custom',
          message: 'keyframes must be strictly sorted by timeUs (no duplicates)',
          path: kfPath,
        });
      }
    }
  }
}

function checkTrack(
  ctx: InvariantIssueSink,
  track: Track,
  trackIndex: number,
  fps: Rational,
  assetDurations: AssetDurations | undefined,
): void {
  const clips = track.clips;
  for (let ci = 0; ci < clips.length; ci++) {
    checkClip(ctx, trackIndex, clips, ci, assetDurations);
  }
  // 5. Transitions (validated after ordering so adjacency is meaningful).
  for (let ci = 0; ci < clips.length; ci++) {
    const clip = clips[ci];
    if (!isMediaClip(clip)) continue;
    if (clip.transitionIn) {
      checkTransitionEdge(ctx, trackIndex, clips, ci, 'transitionIn', clip.transitionIn, fps, assetDurations);
    }
    if (clip.transitionOut) {
      checkTransitionEdge(ctx, trackIndex, clips, ci, 'transitionOut', clip.transitionOut, fps, assetDurations);
    }
  }
}

/**
 * Run all document-wide invariant checks, reporting failures through `ctx`.
 * Designed to be called from `TimelineDocSchema.superRefine`.
 */
export function checkTimelineInvariants(
  doc: TimelineDoc,
  ctx: InvariantIssueSink,
  assetDurations?: AssetDurations,
): void {
  doc.tracks.forEach((track, ti) => checkTrack(ctx, track, ti, doc.settings.fps, assetDurations));
}

// ---------------------------------------------------------------------------
// Export frame-grid gate (rendering-semantics §1.4) — the compiler's rule,
// verbatim, on this side of the boundary
//
// `ExportCompiler.Validate` rejects, per clip:
//
//     var endUs = planned.TimelineStartUs + planned.TimelineDurationUs;
//     if (SnapUs(planned.TimelineStartUs, ...) != planned.TimelineStartUs
//         || SnapUs(endUs, ...) != endUs)
//         throw new InvalidTimelineException("... edges are not on the project frame grid ...")
//
// because the export segment ledger is kept in whole frames — and it is kept as
// a pair of EDGES (`trim=start_frame:end_frame`, ExportCompiler line ~421), not
// as a length. That distinction is the whole rule: outside integer fps the grid
// is not closed under addition (30 fps: frame 1 = 33_333 us, frame 2 = 66_667
// us, and 33_333 + 33_333 = 66_666 is NOT a grid value), so requiring the
// DURATION to be a grid value contradicts requiring the START to be one for any
// chain of adjacent clips — the shape every split, and every transition (§5),
// produces. Gating the edges instead is satisfiable everywhere and is exactly
// what the frame ledger needs.
//
// It is still not part of `checkTimelineInvariants`: a document can arrive from
// an older revision (or from a project whose fps was changed after the fact)
// with clips off the grid, and failing every later edit would be worse than one
// actionable message. `assertDocValidDev` (editor, dev only) and the export
// dialog run it explicitly, so the mismatch surfaces as data — or as a Turkish
// warning before submit — instead of as an HTTP 422 from the render worker.
// ---------------------------------------------------------------------------

/** One clip the export compiler would reject for frame-grid misalignment. */
export interface FrameGridIssue {
  trackIndex: number;
  clipIndex: number;
  clipId: string;
  /** Which EDGE is off the grid (a clip can fail on both). */
  field: 'timelineStartUs' | 'timelineEndUs';
  valueUs: MicroSec;
  /** Nearest grid value — what the compiler's `SnapUs` would have produced. */
  snappedUs: MicroSec;
}

/**
 * Every clip in `doc` the export compiler's frame-grid gate would reject.
 * An empty array means the document clears that gate.
 */
export function exportFrameGridIssues(doc: TimelineDoc): FrameGridIssue[] {
  const fps = doc.settings.fps;
  const issues: FrameGridIssue[] = [];
  doc.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      const fields = [
        ['timelineStartUs', clip.timelineStartUs],
        ['timelineEndUs', clip.timelineStartUs + clip.timelineDurationUs],
      ] as const;
      for (const [field, valueUs] of fields) {
        if (isOnFrameGrid(valueUs, fps)) continue;
        issues.push({
          trackIndex,
          clipIndex,
          clipId: clip.id,
          field,
          valueUs,
          snappedUs: frameToUs(usToFrame(valueUs, fps), fps),
        });
      }
    });
  });
  return issues;
}

/**
 * One-line Turkish summary of a frame-grid violation, for the export dialog.
 * Empty string when there is nothing to report.
 */
export function frameGridIssueSummary(issues: readonly FrameGridIssue[]): string {
  if (issues.length === 0) return '';
  const first = issues[0];
  const edge = first.field === 'timelineStartUs' ? 'başlangıcı' : 'bitişi';
  const handle = first.field === 'timelineStartUs' ? 'sol' : 'sağ';
  const more = issues.length > 1 ? ` (+${issues.length - 1} klip daha)` : '';
  // The advice has to be one that ACTUALLY fixes it. "Move the clip one frame"
  // (what this used to say) moves BOTH edges by the same microseconds, so an
  // off-grid edge stays off-grid — the grid is not closed under addition
  // outside integer fps. Re-dragging the offending EDGE is: every trim path
  // re-fits the length onto a whole frame span of the project grid.
  return (
    `Bir klibin ${edge} proje kare ızgarasına oturmuyor ` +
    `(${first.valueUs}µs, en yakın kare ${first.snappedUs}µs)${more}. ` +
    `Bu belge dışa aktarımda reddedilir; klibin ${handle} kenarını bir kare içeri çekip ` +
    'bırakın (klibi kaydırmak iki kenarı birden ötelediği için sorunu çözmez).'
  );
}
