/**
 * Audio gain math — pure (unit-testable), shared by the Web Audio graph.
 *
 * Contract (docs/rendering-semantics.md §8):
 * - volume is a LINEAR amplitude multiplier in [0..2] (§8.1)
 * - fade in/out curves are LINEAR: g = t/D in, g = 1 - t/D out (§8.2)
 * - keyframed volume interpolates per §3 (sampleKeyframes)
 * - every hard cut edge gets a 5 ms linear micro-fade unless the user's own
 *   fade already covers that edge, or the cut is a seamless splice (§8.4)
 */
import type { ClipAudio, Keyframe, MediaClip, MicroSec } from '@videoedit/timeline-schema';
import { roundHalfUp, sampleKeyframes } from '@videoedit/timeline-schema';

/** §8.4: 5 ms (= 240 samples @48 kHz). */
export const MICRO_FADE_US = 5_000;

/**
 * Linear fade envelope (fades only, no volume) at clip-local time tClipUs.
 * Returns 0 outside [0, clipDurUs].
 */
export function fadeEnvelopeAt(audio: ClipAudio, clipDurUs: MicroSec, tClipUs: number): number {
  if (tClipUs < 0 || tClipUs > clipDurUs) return 0;
  let g = 1;
  if (audio.fadeInUs > 0 && tClipUs < audio.fadeInUs) {
    g *= tClipUs / audio.fadeInUs;
  }
  const tFromEnd = clipDurUs - tClipUs;
  if (audio.fadeOutUs > 0 && tFromEnd < audio.fadeOutUs) {
    g *= tFromEnd / audio.fadeOutUs;
  }
  return g;
}

/**
 * Full linear gain of a clip at clip-local time tClipUs:
 *   (keyframed) volume x fade envelope; 0 when muted or outside the clip.
 */
export function clipGainAt(
  audio: ClipAudio,
  clipDurUs: MicroSec,
  tClipUs: number,
  volumeKeyframes?: readonly Keyframe[],
): number {
  if (audio.muted) return 0;
  const volume =
    volumeKeyframes && volumeKeyframes.length > 0
      ? sampleKeyframes(volumeKeyframes, clampInt(tClipUs, clipDurUs))
      : audio.volume;
  return Math.max(0, volume) * fadeEnvelopeAt(audio, clipDurUs, tClipUs);
}

function clampInt(tClipUs: number, clipDurUs: MicroSec): number {
  return Math.min(clipDurUs, Math.max(0, roundHalfUp(tClipUs)));
}

// ---------------------------------------------------------------------------
// Transitions (rendering-semantics §5.4) — the acrossfade equivalent
// ---------------------------------------------------------------------------

/**
 * The transition durations on a clip's two edges (0 = no transition there).
 * §5.4 pairs the audio window with the picture's: A's tail overlaps B's head
 * over the SAME D, so the sound crosses exactly when the picture does.
 */
export interface TransitionRamp {
  /** D of the transition on the clip's IN edge (its left cut). */
  inUs: number;
  /** D of the transition on the clip's OUT edge (its right cut). */
  outUs: number;
}

export const NO_TRANSITION_RAMP: TransitionRamp = { inUs: 0, outUs: 0 };

/**
 * Linear crossfade factor at clip-local time tClipUs (§5.4 `c1=tri:c2=tri`,
 * i.e. the same linear law as §8.2's fades).
 *
 * The domain is the clip's timeline life EXTENDED by D/2 at each transition
 * edge — that extension is the handle the export compiler feeds to acrossfade,
 * and the preview plays the very same material. Outside it: silence.
 */
export function transitionGainAt(
  tClipUs: number,
  clipDurUs: MicroSec,
  ramp: TransitionRamp = NO_TRANSITION_RAMP,
): number {
  const halfIn = ramp.inUs > 0 ? ramp.inUs / 2 : 0;
  const halfOut = ramp.outUs > 0 ? ramp.outUs / 2 : 0;
  if (tClipUs < -halfIn || tClipUs > clipDurUs + halfOut) return 0;
  let g = 1;
  if (ramp.inUs > 0 && tClipUs < halfIn) {
    g *= Math.min(1, Math.max(0, (tClipUs + halfIn) / ramp.inUs));
  }
  if (ramp.outUs > 0 && tClipUs > clipDurUs - halfOut) {
    g *= Math.min(1, Math.max(0, (clipDurUs + halfOut - tClipUs) / ramp.outUs));
  }
  return g;
}

export interface GainCurveOptions {
  /**
   * Apply a 5 ms micro-fade at the start/end EDGE OF THE WINDOW. The engine
   * passes true for hard boundaries (cut without an explicit fade, resume
   * mid-clip) and false for seamless splices (§8.4 exception).
   */
  microFadeIn?: boolean;
  microFadeOut?: boolean;
  volumeKeyframes?: readonly Keyframe[];
  /**
   * §5.4 crossfade ramps. When present the clip's own volume/fade envelope is
   * evaluated CLAMPED into [0, duration] (the handle material plays at the
   * clip's normal level) and multiplied by the linear crossfade factor.
   */
  transition?: TransitionRamp;
}

/**
 * Sample the gain over the clip-local window [startClipUs, endClipUs] into a
 * Float32Array suitable for AudioParam.setValueCurveAtTime (linear
 * interpolation between samples matches §8.2's linear fades exactly when the
 * sample grid is dense enough; the engine uses ~100 samples/s).
 *
 * Micro-fades multiply the sampled gain by a 0->1 (in) / 1->0 (out) linear
 * ramp over the first/last 5 ms of the window. An explicit user fade covering
 * that edge disables the corresponding micro-fade (§8.4).
 */
export function buildGainCurve(
  audio: ClipAudio,
  clipDurUs: MicroSec,
  startClipUs: number,
  endClipUs: number,
  sampleCount: number,
  opts: GainCurveOptions = {},
): Float32Array {
  const n = Math.max(2, Math.floor(sampleCount));
  const span = endClipUs - startClipUs;
  const curve = new Float32Array(n);
  const ramp = opts.transition;

  // §8.4: the user's own fade already reaches zero at the edge -> skip micro-fade.
  // A transition edge does the same job (the ramp IS the fade) and a 5 ms notch
  // inside a crossfade is an audible dip, so it suppresses the micro-fade too.
  const wantMicroIn =
    (opts.microFadeIn ?? false) &&
    !(audio.fadeInUs > 0 && startClipUs <= 0) &&
    !((ramp?.inUs ?? 0) > 0);
  const wantMicroOut =
    (opts.microFadeOut ?? false) &&
    !(audio.fadeOutUs > 0 && endClipUs >= clipDurUs) &&
    !((ramp?.outUs ?? 0) > 0);

  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : i / (n - 1);
    const t = startClipUs + span * frac;
    // Inside a transition window the clip plays HANDLE material (t outside
    // [0, duration]); its own envelope is sampled at the clamped time and the
    // crossfade ramp does the rest (§5.4).
    let g = ramp
      ? clipGainAt(
          audio,
          clipDurUs,
          Math.min(clipDurUs, Math.max(0, t)),
          opts.volumeKeyframes,
        ) * transitionGainAt(t, clipDurUs, ramp)
      : clipGainAt(audio, clipDurUs, t, opts.volumeKeyframes);
    const fromStart = t - startClipUs;
    const fromEnd = endClipUs - t;
    if (wantMicroIn && fromStart < MICRO_FADE_US) {
      g *= Math.max(0, fromStart) / MICRO_FADE_US;
    }
    if (wantMicroOut && fromEnd < MICRO_FADE_US) {
      g *= Math.max(0, fromEnd) / MICRO_FADE_US;
    }
    curve[i] = g;
  }
  return curve;
}

/**
 * §8.4 seamless-splice exception: two clips cut apart from the same source
 * continue each other exactly — same asset, same rate, B starts where A ends
 * both on the timeline and in the source. No micro-fade on the shared edge
 * (a split clip must not develop an audio dip).
 */
export function isSeamlessSplice(a: MediaClip, b: MediaClip): boolean {
  return (
    a.assetId === b.assetId &&
    a.speed.rate === b.speed.rate &&
    a.timelineStartUs + a.timelineDurationUs === b.timelineStartUs &&
    a.sourceOutUs === b.sourceInUs
  );
}

/**
 * How far past a clip's left edge an envelope window may start and still count
 * as "starting at the clip edge" for the §8.4 splice decision.
 *
 * Envelope scheduling runs on the rAF tick AFTER the cut, so the window start
 * lags the clip edge by up to one project frame. The bare MICRO_FADE_US (5 ms)
 * is therefore NOT a usable threshold — at 30 fps the first tick lands ~33 ms
 * into the clip and a seamless splice would wrongly get a micro-fade (audible
 * dip on split clips). Threshold = one frame duration + 5 ms margin.
 */
export function spliceEdgeToleranceUs(frameDurationUs: number): MicroSec {
  return Math.max(0, Math.round(frameDurationUs)) + MICRO_FADE_US;
}

/**
 * Engine-side micro-fade-in decision (§8.4): suppressed ONLY when the window
 * starts at the clip's left edge (within spliceEdgeToleranceUs) AND the
 * previous clip on the track continues seamlessly into this one
 * (same asset, B.sourceIn == A.sourceOut, B.start == A.end, same rate).
 * A mid-clip resume always micro-fades in (click prevention).
 */
export function shouldMicroFadeIn(
  prev: MediaClip | null,
  clip: MediaClip,
  startClipUs: number,
  frameDurationUs: number,
): boolean {
  const startsAtClipEdge = startClipUs <= spliceEdgeToleranceUs(frameDurationUs);
  return !(startsAtClipEdge && prev !== null && isSeamlessSplice(prev, clip));
}

/**
 * Engine-side micro-fade-out decision (§8.4): suppressed only when the next
 * clip continues seamlessly (the envelope always runs to the clip end, so no
 * edge tolerance is involved on the out side).
 */
export function shouldMicroFadeOut(clip: MediaClip, next: MediaClip | null): boolean {
  return !(next !== null && isSeamlessSplice(clip, next));
}

// ---------------------------------------------------------------------------
// dB conversions (§8.1)
//
// These live HERE, next to the gain contract they belong to, because a second
// copy of the same formula is how two views of one number silently drift
// apart. The inspector keeps re-exporting them for its existing callers.
// ---------------------------------------------------------------------------

/** Linear gain -> dB (rendering-semantics §8.1). 0 maps to -Infinity. */
export function linearToDb(volume: number): number {
  if (!(volume > 0)) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(volume);
}

/** dB -> linear gain (inverse of linearToDb; -Infinity maps to 0). */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return db === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 0;
  return 10 ** (db / 20);
}
