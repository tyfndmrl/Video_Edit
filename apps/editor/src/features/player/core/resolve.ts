/**
 * Clip-at-time resolution — pure functions shared by the render loop, the
 * audio graph and the preload scheduler. No DOM here (unit-testable).
 *
 * Conventions:
 * - A clip is active on [timelineStartUs, timelineStartUs + timelineDurationUs)
 *   (end-exclusive: at the cut instant only the NEXT clip is active).
 * - tracks[0] is the TOP layer; visual stacking iterates the array from the
 *   end to the start ("bottom track first", design doc §1.2 / prompt).
 * - sourceTimeUs = sourceInUs + roundHalfUp((t - start) * speed.rate), clamped
 *   into [sourceInUs, sourceOutUs] (rendering-semantics §1 rounding contract).
 */
import type {
  Clip,
  ClipAudio,
  MediaClip,
  MicroSec,
  TimelineDoc,
  Track,
  Transform,
  Transition,
  TransitionType,
} from '@videoedit/timeline-schema';
import { isMediaClip, roundHalfUp, sampleKeyframes } from '@videoedit/timeline-schema';

/**
 * Which side of a transition an active clip is: the OUTGOING picture (A, fading
 * away) or the INCOMING one (B). Both are active at the same instant inside the
 * window — that is the whole point of §5.3.
 */
export type TransitionRole = 'from' | 'to';

export interface ActiveTransition {
  type: TransitionType;
  /** D, the full window width (§5.2 even-frame snapped). */
  durationUs: MicroSec;
  /** The cut instant T (= A's timeline end = B's timeline start). */
  cutUs: MicroSec;
  /** Linear mix position p = (t - (T - D/2)) / D, in [0, 1) (§5.3). */
  p: number;
  role: TransitionRole;
  /** id of the clip on the OTHER side of the cut (pairing evidence). */
  partnerClipId: string;
}

export interface ActiveClip<C extends Clip = Clip> {
  trackIndex: number;
  track: Track;
  clip: C;
  /**
   * Set only while the playhead sits inside this clip's transition window
   * (rendering-semantics §5.3). Absent = an ordinary hard cut, one picture.
   */
  transition?: ActiveTransition;
}

export function clipEndUs(clip: Clip): MicroSec {
  return clip.timelineStartUs + clip.timelineDurationUs;
}

export function isClipActiveAt(clip: Clip, tUs: MicroSec): boolean {
  return tUs >= clip.timelineStartUs && tUs < clipEndUs(clip);
}

/** The clip active at tUs in a track (clips are sorted + non-overlapping). */
export function clipAtTime(track: Track, tUs: MicroSec): Clip | null {
  for (const clip of track.clips) {
    if (clip.timelineStartUs > tUs) break; // sorted — nothing later can match
    if (isClipActiveAt(clip, tUs)) return clip;
  }
  return null;
}

/** First clip starting strictly after tUs (preload lookahead), or null. */
export function nextClipAfter(track: Track, tUs: MicroSec): Clip | null {
  for (const clip of track.clips) {
    if (clip.timelineStartUs > tUs) return clip;
  }
  return null;
}

/**
 * Media source time for a timeline instant:
 *   sourceIn + roundHalfUp((t - start) * rate), clamped to [sourceIn, sourceOut].
 */
export function sourceTimeUs(clip: MediaClip, tUs: MicroSec): MicroSec {
  const raw = clip.sourceInUs + roundHalfUp((tUs - clip.timelineStartUs) * clip.speed.rate);
  return Math.min(clip.sourceOutUs, Math.max(clip.sourceInUs, raw));
}

// ---------------------------------------------------------------------------
// Transitions (rendering-semantics §5.3) — the PREVIEW half of the contract
// ---------------------------------------------------------------------------

/**
 * Source-domain half window of a transition — the "handle" the export compiler
 * consumes: roundHalfUp((D/2) * speed.rate). Same formula as the schema
 * invariant (packages/timeline-schema/src/invariants.ts) and the ffmpeg
 * compiler; the preview MUST read the same frames the export will.
 */
export function transitionHandleUs(durationUs: MicroSec, rate: number): MicroSec {
  return roundHalfUp((durationUs / 2) * rate);
}

/**
 * Source time INSIDE a transition window, i.e. allowed to leave the clip's own
 * [sourceIn, sourceOut] range by one handle.
 *
 * Why the normal sourceTimeUs() cannot be used here: it clamps, so the outgoing
 * clip would freeze on its last frame for the whole second half of the window
 * (and the incoming one would show a frozen first frame in the first half) —
 * a crossfade between a frozen frame and a live one is not a crossfade.
 */
export function sourceTimeUsInWindow(
  clip: MediaClip,
  tUs: MicroSec,
  handleUs: MicroSec,
): MicroSec {
  const raw = clip.sourceInUs + roundHalfUp((tUs - clip.timelineStartUs) * clip.speed.rate);
  const lo = Math.max(0, clip.sourceInUs - handleUs);
  const hi = clip.sourceOutUs + handleUs;
  return Math.min(hi, Math.max(lo, raw));
}

/** A live transition window on one track at one instant. */
export interface TransitionWindow {
  /** Outgoing clip (A) — the one BEFORE the cut. */
  from: MediaClip;
  /** Incoming clip (B) — the one AFTER the cut. */
  to: MediaClip;
  type: TransitionType;
  durationUs: MicroSec;
  /** Cut instant T. */
  cutUs: MicroSec;
  /** p = (t - (T - D/2)) / D, in [0, 1). */
  p: number;
}

function windowFor(a: Clip, b: Clip, transition: Transition, tUs: MicroSec): TransitionWindow | null {
  if (!isMediaClip(a) || !isMediaClip(b)) return null;
  const cutUs = clipEndUs(a);
  if (cutUs !== b.timelineStartUs) return null; // not a cut (gap/overlap): §5.1
  const d = transition.durationUs;
  if (d <= 0) return null;
  const half = d / 2;
  if (tUs < cutUs - half || tUs >= cutUs + half) return null; // end-exclusive, like clips
  return {
    from: a,
    to: b,
    type: transition.type,
    durationUs: d,
    cutUs,
    p: (tUs - (cutUs - half)) / d,
  };
}

/**
 * The transition window covering tUs on this track, or null.
 *
 * Only ONE window can be open at a time on a track: §5.2's upper bound
 * (`D*2 <= min(A.dur, B.dur)`) means each clip spends at most a quarter of its
 * own length in each of its two half windows, so they cannot meet.
 *
 * Both ends of the cut are inspected because the playhead may sit on either
 * side of T: at t < T the clip under the playhead is A (look at transitionOut),
 * at t >= T it is B (look at transitionIn). Both paths return the SAME window.
 */
export function transitionWindowAt(track: Track, tUs: MicroSec): TransitionWindow | null {
  const clips = track.clips;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    // Nothing later can start before tUs + a plausible half window once we are
    // past the playhead by more than the clip we are looking at — the cheap
    // early exit is simply "this clip starts after the window we could open".
    if (!isMediaClip(clip)) continue;
    const out = clip.transitionOut;
    if (out) {
      const next = clips[i + 1];
      if (next) {
        const w = windowFor(clip, next, out, tUs);
        if (w) return w;
      }
    }
    const inn = clip.transitionIn;
    if (inn) {
      const prev = clips[i - 1];
      if (prev) {
        const w = windowFor(prev, clip, inn, tUs);
        if (w) return w;
      }
    }
    if (clip.timelineStartUs > tUs) break; // sorted — later clips are further away
  }
  return null;
}

/**
 * The transition window under the playhead anywhere in the document, top track
 * first (tracks[0] = top layer), or null. Feeds the player's "geçiş" badge —
 * without it a crossfade between two similar shots is indistinguishable from a
 * preview that simply failed to update.
 */
export function transitionAtPlayhead(doc: TimelineDoc, tUs: MicroSec): TransitionWindow | null {
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    const window = transitionWindowAt(track, tUs);
    if (window) return window;
  }
  return null;
}

function activeTransition(
  window: TransitionWindow,
  role: TransitionRole,
): ActiveTransition {
  return {
    type: window.type,
    durationUs: window.durationUs,
    cutUs: window.cutUs,
    p: window.p,
    role,
    partnerClipId: role === 'from' ? window.to.id : window.from.id,
  };
}

/** Timeline end of the project = max clip end over all tracks (0 when empty). */
export function projectDurationUs(doc: TimelineDoc): MicroSec {
  let end = 0;
  for (const track of doc.tracks) {
    const last = track.clips[track.clips.length - 1];
    if (last) end = Math.max(end, clipEndUs(last));
  }
  return end;
}

/**
 * Visual stack at tUs, BOTTOM first (draw order). Hidden tracks and non-visual
 * clips (audio kind) are excluded. tracks[0] = top layer ends up LAST.
 */
export function resolveVisualStack(doc: TimelineDoc, tUs: MicroSec): ActiveClip[] {
  const stack: ActiveClip[] = [];
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    const track = doc.tracks[i]!;
    if (track.hidden) continue;
    // Inside a transition window BOTH pictures are live (§5.3): the outgoing
    // clip first, the incoming one on top of it. Returning only the clip under
    // the playhead is what made the preview show a hard cut while the export
    // produced a crossfade.
    const window = transitionWindowAt(track, tUs);
    if (window && window.from.kind !== 'audio' && window.to.kind !== 'audio') {
      stack.push({
        trackIndex: i,
        track,
        clip: window.from,
        transition: activeTransition(window, 'from'),
      });
      stack.push({
        trackIndex: i,
        track,
        clip: window.to,
        transition: activeTransition(window, 'to'),
      });
      continue;
    }
    const clip = clipAtTime(track, tUs);
    if (!clip) continue;
    if (clip.kind === 'audio') continue;
    stack.push({ trackIndex: i, track, clip });
  }
  return stack;
}

/** Default audio settings for an 'audio'-kind clip whose audio field is null. */
export const DEFAULT_CLIP_AUDIO: ClipAudio = {
  volume: 1,
  fadeInUs: 0,
  fadeOutUs: 0,
  muted: false,
};

/**
 * Audio settings of a media clip, or null when the clip carries no audio:
 * - video: embedded audio; null = detached/absent -> no audio
 * - audio: its own audio; a null field falls back to defaults (unity gain)
 * - image: never has audio
 */
export function clipAudioOf(clip: MediaClip): ClipAudio | null {
  if (clip.kind === 'image') return null;
  if (clip.kind === 'audio') return clip.audio ?? DEFAULT_CLIP_AUDIO;
  return clip.audio;
}

/**
 * Clips audible at tUs. Track.muted and ClipAudio.muted mute (gain 0 handled
 * by the caller reading `audio.muted`/track state); clips with NO audio at all
 * (detached video sound, images) are excluded here.
 */
export function resolveAudible(doc: TimelineDoc, tUs: MicroSec): ActiveClip<MediaClip>[] {
  const out: ActiveClip<MediaClip>[] = [];
  for (let i = 0; i < doc.tracks.length; i++) {
    const track = doc.tracks[i]!;
    // §5.4: the audio window is the SAME window as the picture's (acrossfade
    // overlaps A's tail with B's head), so both sides are audible here.
    const window = transitionWindowAt(track, tUs);
    if (window) {
      for (const [clip, role] of [
        [window.from, 'from'],
        [window.to, 'to'],
      ] as const) {
        if (clipAudioOf(clip) === null) continue;
        out.push({ trackIndex: i, track, clip, transition: activeTransition(window, role) });
      }
      continue;
    }
    const clip = clipAtTime(track, tUs);
    if (!clip || !isMediaClip(clip)) continue;
    if (clipAudioOf(clip) === null) continue;
    out.push({ trackIndex: i, track, clip });
  }
  return out;
}

/** Is this clip effectively silent at the track level? */
export function isClipMuted(track: Track, clip: MediaClip): boolean {
  const audio = clipAudioOf(clip);
  return track.muted || audio === null || audio.muted;
}

// ---------------------------------------------------------------------------
// Keyframe-effective properties (rendering-semantics §3.3 via sampleKeyframes)
// ---------------------------------------------------------------------------

/** Clip-relative timeline time, clamped to [0, duration], integer. */
export function clipLocalTimeUs(clip: Clip, tUs: MicroSec): MicroSec {
  return Math.min(clip.timelineDurationUs, Math.max(0, Math.round(tUs - clip.timelineStartUs)));
}

/** Transform with keyframed x/y/scale/rotationDeg applied at timeline time tUs. */
export function effectiveTransform(clip: Clip, tUs: MicroSec): Transform {
  const kf = clip.keyframes;
  const t = clipLocalTimeUs(clip, tUs);
  const base = clip.transform;
  return {
    x: kf.x && kf.x.length > 0 ? sampleKeyframes(kf.x, t) : base.x,
    y: kf.y && kf.y.length > 0 ? sampleKeyframes(kf.y, t) : base.y,
    scale: kf.scale && kf.scale.length > 0 ? sampleKeyframes(kf.scale, t) : base.scale,
    rotationDeg:
      kf.rotationDeg && kf.rotationDeg.length > 0
        ? sampleKeyframes(kf.rotationDeg, t)
        : base.rotationDeg,
    anchorX: base.anchorX,
    anchorY: base.anchorY,
  };
}

/** Opacity with keyframes applied (clamped to [0,1]). */
export function effectiveOpacity(clip: Clip, tUs: MicroSec): number {
  const kf = clip.keyframes.opacity;
  const value =
    kf && kf.length > 0 ? sampleKeyframes(kf, clipLocalTimeUs(clip, tUs)) : clip.opacity;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// colorAdjust extraction (rendering-semantics §4.1)
// ---------------------------------------------------------------------------

export interface ColorAdjust {
  exposure: number;
  temperature: number;
  tint: number;
  brightness: number;
  contrast: number;
  saturation: number;
}

const CA_KEYS: (keyof ColorAdjust)[] = [
  'exposure',
  'temperature',
  'tint',
  'brightness',
  'contrast',
  'saturation',
];

/**
 * First enabled colorAdjust effect of the clip as numeric params (defaults 0 =
 * identity), or null when there is none. v1 limitation: multiple colorAdjust
 * effects on one clip are not stacked in the preview (single uber-shader pass).
 */
export function colorAdjustOf(clip: Clip): ColorAdjust | null {
  for (const effect of clip.effects) {
    if (effect.type !== 'colorAdjust' || !effect.enabled) continue;
    const out: ColorAdjust = {
      exposure: 0,
      temperature: 0,
      tint: 0,
      brightness: 0,
      contrast: 0,
      saturation: 0,
    };
    for (const key of CA_KEYS) {
      const v = effect.params[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return out;
  }
  return null;
}
