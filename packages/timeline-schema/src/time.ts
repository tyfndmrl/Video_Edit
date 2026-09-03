/**
 * Shared time math for the timeline contract.
 *
 * All times are integer microseconds (`MicroSec`). Float seconds are forbidden.
 *
 * Rounding contract (the C# export compiler MUST implement the exact same rules;
 * see test-vectors/time-vectors.json for cross-language verification):
 * - us <-> frame conversions use half-up rounding (`roundHalfUp(x) = floor(x + 0.5)`,
 *   rendering-semantics §1.2; C#: `(long)Math.Floor(x + 0.5)` — banker's rounding forbidden).
 * - `timelineDurationUs = roundHalfUp((sourceOutUs - sourceInUs) / speedRate)`.
 * - Timecode frame count uses `floor` and is displayed non-drop as HH:MM:SS:FF.
 *
 * The duration formula and the project frame grid are two SEPARATE export gates
 * that a duration-changing edit has to satisfy together; `solveSpeedChange`
 * below is the single place that solves for both (see its block comment).
 */

/** Integer microseconds. JS numbers are exact up to 2^53 (~285 years in us). */
export type MicroSec = number;

/** Exact frame rate, e.g. { num: 24000, den: 1001 } for 23.976 fps. */
export interface Rational {
  num: number;
  den: number;
}

export const US_PER_SECOND = 1_000_000;

/**
 * Normative half-up rounding (rendering-semantics §1.2): round(x) = floor(x + 0.5).
 * Matches JS Math.round for non-negative x AND for negatives at the midpoint
 * (roundHalfUp(-0.5) === 0). C# equivalent: (long)Math.Floor(x + 0.5) —
 * C# Math.Round (banker's rounding) is forbidden by the contract.
 */
export const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

/** Integer discipline: every public function rejects non-integer time/frame inputs. */
function assertInt(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${String(value)}`);
  }
}

function assertRational(fps: Rational): void {
  assertInt('fps.num', fps.num);
  assertInt('fps.den', fps.den);
  if (fps.num <= 0 || fps.den <= 0) {
    throw new RangeError(`fps must be positive, got ${fps.num}/${fps.den}`);
  }
}

/** Timeline time (us) -> frame index on the given fps grid. Half-up rounding. */
export function usToFrame(timeUs: MicroSec, fps: Rational): number {
  assertInt('timeUs', timeUs);
  assertRational(fps);
  return roundHalfUp((timeUs * fps.num) / (fps.den * US_PER_SECOND));
}

/** Frame index -> timeline time (us) on the given fps grid. Half-up rounding. */
export function frameToUs(frameIndex: number, fps: Rational): MicroSec {
  assertInt('frameIndex', frameIndex);
  assertRational(fps);
  return roundHalfUp((frameIndex * fps.den * US_PER_SECOND) / fps.num);
}

/**
 * Duration a media clip occupies on the timeline after speed is applied.
 * Contract formula: round((sourceOutUs - sourceInUs) / rate).
 * The C# export compiler must use the identical formula.
 */
export function clipTimelineDurationUs(
  sourceInUs: MicroSec,
  sourceOutUs: MicroSec,
  rate: number,
): MicroSec {
  assertInt('sourceInUs', sourceInUs);
  assertInt('sourceOutUs', sourceOutUs);
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`rate must be a finite positive number, got ${String(rate)}`);
  }
  return roundHalfUp((sourceOutUs - sourceInUs) / rate);
}

/** Snap an arbitrary time to the nearest frame boundary of the PROJECT fps grid. */
export function snapUsToFrameGrid(timeUs: MicroSec, fps: Rational): MicroSec {
  return frameToUs(usToFrame(timeUs, fps), fps);
}

/** True when `timeUs` is exactly a frame boundary of the project fps grid. */
export function isOnFrameGrid(timeUs: MicroSec, fps: Rational): boolean {
  return snapUsToFrameGrid(timeUs, fps) === timeUs;
}

// ---------------------------------------------------------------------------
// Frame SPANS — durations measured between two grid EDGES
//
// The frame grid is not closed under addition outside integer-fps projects: at
// 30 fps frame 1 is 33_333 us and frame 2 is 66_667 us, so two clips of "one
// grid frame" (33_333 us) placed back to back end at 66_666 us — a time that is
// NOT on the grid. A duration is therefore NOT a grid quantity; only the two
// EDGES of a clip are (`timelineStartUs` and `timelineStartUs + duration`),
// which is exactly what the export compiler's segment ledger keeps
// (`trim=start_frame:end_frame`, ExportCompiler.CompileInternal).
//
// Every op that decides a duration must therefore pick a whole number of frames
// RELATIVE TO ITS OWN START and measure the microseconds between the two grid
// edges — that is what these helpers do. Snapping a duration on its own
// (`snapUsToFrameGrid(durationUs)`) is the bug they replace.
// ---------------------------------------------------------------------------

/**
 * Microseconds spanned by `frames` whole project frames starting at `startUs`.
 * `startUs` is expected to be on the grid (ops snap it first); the span is
 * measured edge-to-edge, so `startUs + frameSpanUs(...)` is always on the grid.
 */
export function frameSpanUs(startUs: MicroSec, frames: number, fps: Rational): MicroSec {
  assertInt('startUs', startUs);
  assertInt('frames', frames);
  assertRational(fps);
  return frameToUs(usToFrame(startUs, fps) + frames, fps) - startUs;
}

/** Whole frames between `startUs` and `startUs + durationUs` on the project grid. */
export function frameSpanCount(startUs: MicroSec, durationUs: MicroSec, fps: Rational): number {
  assertInt('startUs', startUs);
  assertInt('durationUs', durationUs);
  assertRational(fps);
  return usToFrame(startUs + durationUs, fps) - usToFrame(startUs, fps);
}

/**
 * Nearest whole-frame span at `startUs` (never below `minFrames`, default 1).
 * Use for durations the user asks for in the abstract (a new overlay clip, a
 * default length); use `floorDurationToFrameSpan` when the duration is capped
 * by real source material.
 */
export function snapDurationToFrameSpan(
  startUs: MicroSec,
  requestedDurationUs: MicroSec,
  fps: Rational,
  minFrames = 1,
): MicroSec {
  const frames = Math.max(minFrames, frameSpanCount(startUs, Math.max(0, requestedDurationUs), fps));
  return frameSpanUs(startUs, frames, fps);
}

/**
 * Largest whole-frame span at `startUs` that does NOT exceed `maxDurationUs`
 * (tail snap). Returns 0 when not even one frame fits — the caller must refuse
 * rather than write a sub-frame clip.
 *
 * This is the rule for anything bounded by source material: a clip may end
 * BEFORE the media runs out, never after (`sourceOutUs <= asset.durationUs`).
 */
export function floorDurationToFrameSpan(
  startUs: MicroSec,
  maxDurationUs: MicroSec,
  fps: Rational,
): MicroSec {
  if (maxDurationUs <= 0) return 0;
  let frames = frameSpanCount(startUs, maxDurationUs, fps);
  // usToFrame rounds HALF-UP, so the frame it names can sit past maxDurationUs.
  while (frames > 0 && frameSpanUs(startUs, frames, fps) > maxDurationUs) frames--;
  return frames > 0 ? frameSpanUs(startUs, frames, fps) : 0;
}

/**
 * The export compiler's frame-grid gate for ONE clip, verbatim: both EDGES on
 * the project grid (`ExportCompiler.Validate`). The duration itself is
 * deliberately not tested — see the block comment above.
 */
export function isClipOnFrameGrid(
  startUs: MicroSec,
  durationUs: MicroSec,
  fps: Rational,
): boolean {
  return isOnFrameGrid(startUs, fps) && isOnFrameGrid(startUs + durationUs, fps);
}

// ---------------------------------------------------------------------------
// Speed change solver (rendering-semantics §1.3 + §1.4)
//
// A speed edit has to satisfy TWO rules that the export compiler enforces
// INDEPENDENTLY on the same clip, and that a naive implementation cannot
// satisfy at the same time:
//
//   (i)  duration formula  — ExportCompiler.ValidateMediaClip:
//        `timelineDurationUs == roundHalfUp((sourceOutUs - sourceInUs) / rate)`
//        (identical to `clipTimelineDurationUs` above, invariants.ts rule 3);
//   (ii) frame grid        — ExportCompiler.Validate:
//        `SnapUs(start) == start && SnapUs(start + duration) == start + duration`,
//        because the export segment ledger is kept in WHOLE FRAMES
//        (`trim=start_frame:end_frame`). The duration is the DIFFERENCE of two
//        grid edges, which outside integer fps is itself off the grid — hence
//        `opts.timelineStartUs` below.
//
// Applying (i) alone is what produced the shipped defect: at 30 fps a 3 s clip
// at rate 0.7 yields 4_285_714 us, which is NOT a grid value (the nearest frame
// boundary is 4_300_000) — the document validates in the editor and is then
// rejected by the compiler with a hard "not aligned to the project frame grid".
//
// The fix cannot be "snap the duration afterwards" either: that breaks (i).
// The duration is the DEPENDENT value here, so the solve runs the other way
// round — pick a whole frame count for the timeline duration first, then
// re-derive `sourceOutUs` so that (i) holds EXACTLY for that duration.
//
// The re-derivation is not the one-liner it looks like. `sourceOut = sourceIn +
// roundHalfUp(D * rate)` only round-trips while `rate >= 1`; for rate < 1 the
// source span shrinks by 1/rate and the half-up rounding no longer inverts (at
// rate 0.1 a one-microsecond source error becomes a ten-microsecond duration
// error). Rule (i) inverted gives the exact admissible window
//
//        rate * (D - 0.5)  <=  sourceOut - sourceIn  <  rate * (D + 0.5)
//
// whose WIDTH is `rate`. For rate < 1 that window can hold no integer at all,
// i.e. some frame counts are simply not reachable at that rate — so the solver
// walks outward from the ideal frame count until it finds one that is. Both
// rules then hold by construction, not by luck.
// ---------------------------------------------------------------------------

/** A speed change that satisfies BOTH the duration formula and the frame grid. */
export interface SpeedChangeSolution {
  /** Timeline duration: a whole-frame span from `opts.timelineStartUs`. */
  durationUs: MicroSec;
  /** `durationUs` expressed as a whole frame count on the project grid. */
  durationFrames: number;
  /** Re-derived source out point; `sourceInUs` is never moved. */
  sourceOutUs: MicroSec;
}

/**
 * How far the solver may walk from the ideal frame count before giving up.
 *
 * Empirically bounded, not guessed: a sweep over every 3-decimal rate in
 * [0.1, 10], eight project fps values (24/25/30/50/60/15/120 and the 1001-based
 * NTSC rationals) and source spans from 1 us to one hour — 792 080 cases —
 * needed at most 22 frames (worst case 60000/1001 fps at rate 0.199). 256 keeps
 * an order of magnitude of head-room; beyond it the solver reports failure
 * instead of silently writing a document the compiler would reject.
 */
const SPEED_SOLVE_MAX_FRAME_OFFSET = 256;

/**
 * Source span (`sourceOutUs - sourceInUs`) that satisfies the duration formula
 * EXACTLY for `durationUs` at `rate`, closest to the ideal `durationUs * rate`,
 * or `null` when the admissible window holds no usable integer (below 1x the
 * window is narrower than a microsecond, so some durations are unreachable).
 *
 * The window is scanned rather than computed with a closed form on purpose:
 * the acceptance test is `clipTimelineDurationUs` itself, so the answer is
 * decided by the SAME floating-point expression the compiler evaluates
 * (`(long)Math.Floor((out - in) / rate + 0.5)`), never by an algebraic
 * paraphrase of it that could disagree in the last bit.
 *
 * Exported because every op that RE-FITS a clip onto the grid needs it: moving
 * a clip changes what "one frame" is worth in microseconds (the grid is not
 * closed under addition), so the duration changes by a microsecond or two and
 * the source range has to follow it or rule 3 breaks.
 */
export function sourceSpanForDuration(
  durationUs: MicroSec,
  rate: number,
  maxSpanUs: number = Number.MAX_SAFE_INTEGER,
): number | null {
  const centre = durationUs * rate;
  const lo = Math.max(1, Math.floor(rate * (durationUs - 0.5)) - 1);
  const hi = Math.min(maxSpanUs, Math.ceil(rate * (durationUs + 0.5)) + 1);
  let best: number | null = null;
  for (let span = lo; span <= hi; span++) {
    if (clipTimelineDurationUs(0, span, rate) !== durationUs) continue;
    if (best === null || Math.abs(span - centre) < Math.abs(best - centre)) best = span;
  }
  return best;
}

/**
 * Solve a speed change for one media clip.
 *
 * Returns the timeline duration (always a whole number of project frames) and
 * the re-derived `sourceOutUs` that keeps
 * `timelineDurationUs === roundHalfUp((sourceOutUs - sourceInUs) / rate)` exact.
 * `sourceInUs` is deliberately NOT moved: the in point is where the user
 * trimmed, and a speed change must not slide the clip's first frame.
 *
 * There is deliberately NO "maximum duration" input either. Capping the solve
 * by the free space in front of the next clip looks attractive (the snap UP can
 * add half a frame and overrun a neighbour the requested rate just fitted
 * behind), but the next admissible frame count BELOW such a cap can be a whole
 * frame away — on a short clip that is a double-digit percentage of its length,
 * applied silently. Refusing the edit is the honest outcome, and the caller's
 * layout check owns that decision.
 *
 * @param maxSourceOutUs Hard ceiling for the re-derived out point (the asset
 *   duration, when it is known). Snapping the duration UP can ask for a few
 *   more microseconds of source than the clip currently uses; without the
 *   ceiling that would read past the end of the media and come back as an
 *   HTTP 422 (`sourceOutUs exceeds asset duration`). With it the solver simply
 *   settles on a shorter frame count.
 * @param minFrames Shortest admissible result in frames (default 1 — a clip
 *   shorter than one frame cannot be rendered).
 * @param timelineStartUs Where the clip sits on the timeline (default 0). The
 *   grid rule is about the clip's two EDGES, so the admissible durations are
 *   the spans measured FROM THIS START (`frameSpanUs`) — at 30 fps a clip
 *   starting on frame 1 may be 33_334 us long (frame 1 -> frame 2) and may NOT
 *   be 33_333 us long, the exact opposite of a clip starting at 0.
 * @returns `null` when no frame count in range satisfies both rules, or when
 *   the ceiling leaves no room at all; callers must treat that as a refusal
 *   and leave the document untouched.
 */
export function solveSpeedChange(
  sourceInUs: MicroSec,
  sourceOutUs: MicroSec,
  rate: number,
  fps: Rational,
  opts: { maxSourceOutUs?: MicroSec; minFrames?: number; timelineStartUs?: MicroSec } = {},
): SpeedChangeSolution | null {
  assertInt('sourceInUs', sourceInUs);
  assertInt('sourceOutUs', sourceOutUs);
  assertRational(fps);
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`rate must be a finite positive number, got ${String(rate)}`);
  }
  if (sourceOutUs <= sourceInUs) return null;

  const minFrames = Math.max(1, opts.minFrames ?? 1);
  const startUs = opts.timelineStartUs ?? 0;
  assertInt('timelineStartUs', startUs);
  const maxSpanUs =
    opts.maxSourceOutUs === undefined
      ? Number.MAX_SAFE_INTEGER
      : opts.maxSourceOutUs - sourceInUs;
  if (maxSpanUs < 1) return null;

  const idealDurationUs = clipTimelineDurationUs(sourceInUs, sourceOutUs, rate);
  const ideal = Math.max(minFrames, frameSpanCount(startUs, idealDurationUs, fps));
  // Nearest-first: when the ideal duration sits above its own frame boundary
  // the next frame up is the closer neighbour, and vice versa. Ties (offset 0)
  // are trivially the closest.
  const upFirst = idealDurationUs >= frameSpanUs(startUs, ideal, fps);

  for (let offset = 0; offset <= SPEED_SOLVE_MAX_FRAME_OFFSET; offset++) {
    const candidates =
      offset === 0 ? [ideal] : upFirst ? [ideal + offset, ideal - offset] : [ideal - offset, ideal + offset];
    for (const frames of candidates) {
      if (frames < minFrames) continue;
      const durationUs = frameSpanUs(startUs, frames, fps);
      if (durationUs <= 0) continue;
      const span = sourceSpanForDuration(durationUs, rate, maxSpanUs);
      if (span === null) continue;
      return { durationUs, durationFrames: frames, sourceOutUs: sourceInUs + span };
    }
  }
  return null;
}

/**
 * Nominal (integer) fps used to split SS/FF in timecode: round(num/den), so
 * 30000/1001 reads as 30. Exported because four call sites need the SAME
 * rounding — the ruler labels, formatTimecode and the editor's timecode input
 * parser; a private copy in any of them is how two clocks silently disagree.
 */
export function nominalFpsOf(fps: Rational): number {
  assertRational(fps);
  return Math.max(1, roundHalfUp(fps.num / fps.den));
}

/**
 * Non-drop timecode "HH:MM:SS:FF" on the project fps grid.
 * Frame count is derived with floor (not round) per the UI contract; the
 * nominal fps used for the FF/SS split is round(num/den) (e.g. 29.97 -> 30).
 * Drop-frame timecode is intentionally NOT supported (MVP decision).
 */
export function formatTimecode(timeUs: MicroSec, fps: Rational): string {
  assertInt('timeUs', timeUs);
  assertRational(fps);
  if (timeUs < 0) {
    throw new RangeError(`timeUs must be non-negative, got ${timeUs}`);
  }
  const totalFrames = Math.floor((timeUs * fps.num) / (fps.den * US_PER_SECOND));
  const nominalFps = nominalFpsOf(fps);
  const ff = totalFrames % nominalFps;
  const totalSeconds = Math.floor(totalFrames / nominalFps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}
