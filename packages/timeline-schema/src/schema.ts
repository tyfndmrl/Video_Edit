/**
 * Timeline document schema (zod v4) — the single source of truth for the
 * timeline contract. JSON Schema is generated from here (scripts/generate.ts)
 * and the C# DTOs are generated from that JSON Schema via NJsonSchema.
 *
 * Binding chief-architect decisions baked in:
 * - Transitions are metadata on adjacent clips (no overlap model).
 * - Effect params are NOT keyframable in MVP (no `fx.*` keyframe keys).
 * - MVP effect set is exactly 'colorAdjust' | 'lut' (no blur/chromaKey).
 * - Text uses `fontId` (curated font manifest), not a free-form font family.
 * - IDs are UUIDs (UUIDv7 recommended, time-sortable, Postgres Guid compatible).
 * - All *Us fields are non-negative integer microseconds.
 */

import { z } from 'zod';

// ---------- Primitives ----------

/** Non-negative integer microseconds. */
const microSec = z.number().int().min(0);
/** Strictly positive integer microseconds. */
const positiveMicroSec = z.number().int().positive();
/** UUID (v7 recommended). */
const uuid = z.uuid();
export type Uuid = string;
/** #RGB, #RRGGBB or #RRGGBBAA hex color. */
const colorHex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const RationalSchema = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .meta({ id: 'Rational' });

// ---------- Project settings / markers ----------

export const ProjectSettingsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Project/output fps; frame-step, snapping and timecode all use this grid. */
    fps: RationalSchema,
    audioSampleRate: z.union([z.literal(44100), z.literal(48000)]),
    backgroundColor: colorHex,
  })
  .meta({ id: 'ProjectSettings' });

export const MarkerSchema = z
  .object({
    id: uuid,
    timeUs: microSec,
    label: z.string().max(200).optional(),
    color: colorHex.optional(),
  })
  .meta({ id: 'Marker' });

// ---------- Transform ----------

/**
 * Normalized coordinates: x,y relative to composition center (1.0 = full
 * width/height, typical range [-0.5..0.5]); scale=1 means "fit". Anchor in
 * [0..1] with default 0.5/0.5. Pixel mapping is defined in the Rendering
 * Semantics document.
 */
export const TransformSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    scale: z.number().min(0),
    rotationDeg: z.number(),
    anchorX: z.number().min(0).max(1),
    anchorY: z.number().min(0).max(1),
  })
  .meta({ id: 'Transform' });

// ---------- Easing / keyframes ----------

export const EasingSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('linear') }),
    z.object({ type: z.literal('easeIn') }),
    z.object({ type: z.literal('easeOut') }),
    z.object({ type: z.literal('easeInOut') }),
    z.object({
      type: z.literal('cubicBezier'),
      x1: z.number().min(0).max(1),
      y1: z.number(),
      x2: z.number().min(0).max(1),
      y2: z.number(),
    }),
  ])
  .meta({ id: 'Easing' });

export const KeyframeSchema = z
  .object({
    /** Relative to clip timeline start, in timeline time (speed independent). */
    timeUs: microSec,
    value: z.number(),
    /** Easing of the segment AFTER this keyframe. */
    easing: EasingSchema,
  })
  .meta({ id: 'Keyframe' });

/**
 * Animatable scalar properties. Strict object: only these keys are allowed —
 * effect params ("fx.*") are intentionally NOT keyframable in MVP.
 */
export const KeyframeTracksSchema = z
  .strictObject({
    x: z.array(KeyframeSchema).optional(),
    y: z.array(KeyframeSchema).optional(),
    scale: z.array(KeyframeSchema).optional(),
    rotationDeg: z.array(KeyframeSchema).optional(),
    opacity: z.array(KeyframeSchema).optional(),
    volume: z.array(KeyframeSchema).optional(),
  })
  .meta({ id: 'KeyframeTracks' });

// ---------- Effects / transitions ----------

/** MVP effect set. blur/chromaKey are explicitly out of scope. */
export const EffectTypeSchema = z.enum(['colorAdjust', 'lut']);

export const EffectSchema = z
  .object({
    id: uuid,
    type: EffectTypeSchema,
    enabled: z.boolean(),
    /**
     * Plain scalar params (not keyframable).
     * colorAdjust: brightness/contrast/saturation/temperature/tint/exposure, each -1..1.
     * lut: { assetId: Uuid, intensity: 0..1 }.
     */
    params: z.record(z.string(), z.union([z.number(), z.string()])),
  })
  .meta({ id: 'Effect' });

export const TransitionTypeSchema = z.enum([
  'crossfade',
  'fadeToBlack',
  'wipeLeft',
  'wipeRight',
  'slideUp',
  'dissolve',
]);

/**
 * Transition metadata on a cut between ADJACENT clips (clips never overlap).
 * The export compiler extends A.sourceOut by D/2 and pulls B.sourceIn back by
 * D/2 (handle requirement — see invariants.ts).
 */
export const TransitionSchema = z
  .object({
    type: TransitionTypeSchema,
    durationUs: positiveMicroSec,
  })
  .meta({ id: 'Transition' });

// ---------- Clips ----------

export const ClipAudioSchema = z
  .object({
    /** Linear gain 0..2 (1 = 0 dB). */
    volume: z.number().min(0).max(2),
    fadeInUs: microSec,
    fadeOutUs: microSec,
    muted: z.boolean(),
  })
  .meta({ id: 'ClipAudio' });

/** Fields shared by every clip kind. */
const clipBaseShape = {
  id: uuid,
  timelineStartUs: microSec,
  /** Timeline duration with speed applied. End = start + duration. */
  timelineDurationUs: positiveMicroSec,
  transform: TransformSchema,
  /** Empty object = no keyframes. */
  keyframes: KeyframeTracksSchema,
  effects: z.array(EffectSchema),
  /** Base opacity 0..1 (keyframes may override). */
  opacity: z.number().min(0).max(1),
};

export const MediaClipSchema = z
  .object({
    ...clipBaseShape,
    kind: z.enum(['video', 'audio', 'image']),
    assetId: uuid,
    /** Source (original media) range in the media's own time. Image: 0/duration. */
    sourceInUs: microSec,
    sourceOutUs: positiveMicroSec,
    /** MVP: constant speed. Invariant: timelineDurationUs === round((out-in)/rate). */
    speed: z.object({ rate: z.number().min(0.1).max(10) }),
    /** Embedded audio of a video clip; null when detached or absent. */
    audio: ClipAudioSchema.nullable(),
    transitionIn: TransitionSchema.optional(),
    transitionOut: TransitionSchema.optional(),
  })
  .meta({ id: 'MediaClip' });

export const TextClipSchema = z
  .object({
    ...clipBaseShape,
    kind: z.literal('text'),
    text: z.object({
      content: z.string(),
      /** Curated font manifest id — NOT a free-form CSS font family. */
      fontId: z.string().min(1),
      fontSizePx: z.number().positive(),
      fontWeight: z.number().int().min(1).max(1000),
      italic: z.boolean(),
      fill: colorHex,
      stroke: z
        .object({ color: colorHex, widthPx: z.number().min(0) })
        .optional(),
      background: z
        .object({ color: colorHex, paddingPx: z.number().min(0), radiusPx: z.number().min(0) })
        .optional(),
      align: z.enum(['left', 'center', 'right']),
      /** Line-height multiplier, e.g. 1.2. */
      lineHeight: z.number().positive(),
    }),
  })
  .meta({ id: 'TextClip' });

export const ShapeClipSchema = z
  .object({
    ...clipBaseShape,
    kind: z.literal('shape'),
    shape: z.object({
      type: z.enum(['rect', 'ellipse', 'line', 'arrow']),
      fill: colorHex,
      stroke: z
        .object({ color: colorHex, widthPx: z.number().min(0) })
        .optional(),
      radiusPx: z.number().min(0).optional(),
    }),
  })
  .meta({ id: 'ShapeClip' });

export const StickerClipSchema = z
  .object({
    ...clipBaseShape,
    kind: z.literal('sticker'),
    /** Static PNG/WebP asset (animated WebP is out of MVP scope). */
    assetId: uuid,
  })
  .meta({ id: 'StickerClip' });

export const ClipSchema = z
  .discriminatedUnion('kind', [MediaClipSchema, TextClipSchema, ShapeClipSchema, StickerClipSchema])
  .meta({ id: 'Clip' });

// ---------- Tracks / document root ----------

export const TrackTypeSchema = z.enum(['video', 'audio', 'overlay']);

export const TrackSchema = z
  .object({
    id: uuid,
    type: TrackTypeSchema,
    name: z.string().max(200).optional(),
    muted: z.boolean(),
    hidden: z.boolean(),
    locked: z.boolean(),
    /** Invariant: sorted by timelineStartUs, non-overlapping (see invariants.ts). */
    clips: z.array(ClipSchema),
  })
  .meta({ id: 'Track' });

/**
 * Structural schema of the timeline document. Cross-field invariants live in
 * invariants.ts — use `validateTimelineDoc` / `createTimelineDocSchema` from
 * the package root for full validation.
 */
export const TimelineDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: uuid,
    settings: ProjectSettingsSchema,
    /** Index 0 = top layer (render order: last to first). */
    tracks: z.array(TrackSchema),
    markers: z.array(MarkerSchema),
  })
  .meta({ id: 'TimelineDoc' });

// ---------- Inferred types ----------
// (MicroSec/Rational come from time.ts, Easing/Keyframe from easing.ts —
//  intentionally not re-exported here to avoid duplicate names in the barrel.)

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type KeyframeTracks = z.infer<typeof KeyframeTracksSchema>;
export type EffectType = z.infer<typeof EffectTypeSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type TransitionType = z.infer<typeof TransitionTypeSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type ClipAudio = z.infer<typeof ClipAudioSchema>;
export type MediaClip = z.infer<typeof MediaClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type ShapeClip = z.infer<typeof ShapeClipSchema>;
export type StickerClip = z.infer<typeof StickerClipSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type TrackType = z.infer<typeof TrackTypeSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type TimelineDoc = z.infer<typeof TimelineDocSchema>;

/** Narrowing helper: video/audio/image clips carry source media. */
export function isMediaClip(clip: Clip): clip is MediaClip {
  return clip.kind === 'video' || clip.kind === 'audio' || clip.kind === 'image';
}
