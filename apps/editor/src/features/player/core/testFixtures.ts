/**
 * Shared builders for player core tests. Plain data — no DOM, no stores.
 * IDs only need to be unique strings here (no zod validation in pure fns).
 */
import type {
  ClipAudio,
  MediaClip,
  ProjectSettings,
  TimelineDoc,
  Track,
  Transform,
  TransitionType,
} from '@videoedit/timeline-schema';

export const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scale: 1,
  rotationDeg: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};

export const UNITY_AUDIO: ClipAudio = {
  volume: 1,
  fadeInUs: 0,
  fadeOutUs: 0,
  muted: false,
};

export const TEST_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  audioSampleRate: 48000,
  backgroundColor: '#000000',
};

export interface MediaClipSpec {
  id: string;
  kind?: 'video' | 'audio' | 'image';
  assetId?: string;
  startUs: number;
  durationUs: number;
  sourceInUs?: number;
  sourceOutUs?: number;
  rate?: number;
  audio?: ClipAudio | null;
  transform?: Transform;
  opacity?: number;
}

export function mkMediaClip(spec: MediaClipSpec): MediaClip {
  const rate = spec.rate ?? 1;
  const sourceInUs = spec.sourceInUs ?? 0;
  return {
    id: spec.id,
    kind: spec.kind ?? 'video',
    assetId: spec.assetId ?? `asset-${spec.id}`,
    timelineStartUs: spec.startUs,
    timelineDurationUs: spec.durationUs,
    sourceInUs,
    sourceOutUs: spec.sourceOutUs ?? sourceInUs + Math.round(spec.durationUs * rate),
    speed: { rate },
    audio: spec.audio === undefined ? { ...UNITY_AUDIO } : spec.audio,
    transform: spec.transform ?? { ...IDENTITY_TRANSFORM },
    keyframes: {},
    effects: [],
    opacity: spec.opacity ?? 1,
  };
}

/**
 * Writes a transition on the cut between two ADJACENT clips, on BOTH sides —
 * the §5.2 symmetry invariant. A one-sided fixture would test a document the
 * schema rejects.
 */
export function linkTransition(
  a: MediaClip,
  b: MediaClip,
  durationUs: number,
  type: TransitionType = 'crossfade',
): void {
  a.transitionOut = { type, durationUs };
  b.transitionIn = { type, durationUs };
}

export function mkTrack(
  id: string,
  clips: Track['clips'],
  overrides: Partial<Pick<Track, 'type' | 'name' | 'muted' | 'hidden' | 'locked'>> = {},
): Track {
  return {
    id,
    type: overrides.type ?? 'video',
    ...(overrides.name === undefined ? {} : { name: overrides.name }),
    muted: overrides.muted ?? false,
    hidden: overrides.hidden ?? false,
    locked: overrides.locked ?? false,
    clips,
  };
}

/** tracks[0] = TOP layer (schema contract). */
export function mkDoc(tracks: Track[]): TimelineDoc {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    settings: { ...TEST_SETTINGS },
    tracks,
    markers: [],
  };
}
