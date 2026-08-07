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
} from '@videoedit/timeline-schema';
import { isMediaClip, roundHalfUp, sampleKeyframes } from '@videoedit/timeline-schema';

export interface ActiveClip<C extends Clip = Clip> {
  trackIndex: number;
  track: Track;
  clip: C;
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
