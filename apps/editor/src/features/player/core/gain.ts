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

export interface GainCurveOptions {
  /**
   * Apply a 5 ms micro-fade at the start/end EDGE OF THE WINDOW. The engine
   * passes true for hard boundaries (cut without an explicit fade, resume
   * mid-clip) and false for seamless splices (§8.4 exception).
   */
  microFadeIn?: boolean;
  microFadeOut?: boolean;
  volumeKeyframes?: readonly Keyframe[];
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

  // §8.4: the user's own fade already reaches zero at the edge -> skip micro-fade.
  const wantMicroIn = (opts.microFadeIn ?? false) && !(audio.fadeInUs > 0 && startClipUs <= 0);
  const wantMicroOut =
    (opts.microFadeOut ?? false) && !(audio.fadeOutUs > 0 && endClipUs >= clipDurUs);

  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0 : i / (n - 1);
    const t = startClipUs + span * frac;
    let g = clipGainAt(audio, clipDurUs, t, opts.volumeKeyframes);
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
