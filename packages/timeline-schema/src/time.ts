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
  const nominalFps = Math.max(1, roundHalfUp(fps.num / fps.den));
  const ff = totalFrames % nominalFps;
  const totalSeconds = Math.floor(totalFrames / nominalFps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}
