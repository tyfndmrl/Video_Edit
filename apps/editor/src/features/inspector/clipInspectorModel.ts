/**
 * clipInspectorModel — the Inspector's "selected clip" panel, as PURE data.
 *
 * The React component only paints what this module derives, so every rule that
 * a reviewer cares about (which section shows up, what a multi-selection with
 * differing values displays, how a linear gain becomes a dB label) is unit
 * testable without a DOM.
 *
 * Multi-selection contract: a field shows the shared value when every selected
 * clip agrees, and `null` ("—") when they differ. `null` is unambiguous here —
 * no inspector field is legitimately null in the document.
 *
 * Units follow docs/rendering-semantics.md:
 * - §2  transform is NORMALIZED: x,y are fractions of the composition measured
 *       from its center (0 = centered, 0.5 = half a composition to the
 *       right/down) and scale=1 means "fit", not "native pixels".
 * - §8.1 volume is a LINEAR gain in [0..2]; the dB text is a label only.
 * - §8.2 fades are linear ramps, expressed in microseconds.
 */
import {
  formatTimecode,
  isMediaClip,
  type Clip,
  type ClipAudio,
  type MicroSec,
  type Rational,
  type ShapeClip,
  type TextClip,
  type TimelineDoc,
  type Track,
  type Uuid,
} from '@videoedit/timeline-schema';

/** Shown wherever a multi-selection disagrees. */
export const MIXED_LABEL = '—';

/** Fade sliders top out at 5 s (or the clip length, whichever is shorter). */
export const FADE_SLIDER_MAX_US = 5_000_000;

/** A number every selected clip agrees on, or null when they differ. */
export type CommonNumber = number | null;
export type CommonBoolean = boolean | null;
export type CommonString = string | null;

export interface ClipIdentity {
  clipId: Uuid;
  /** Asset file name for media clips, otherwise a kind-derived name. */
  name: string;
  kindLabel: string;
  trackLabel: string;
  /** Source range timecode "in → out" (media clips only). */
  sourceRange: string | null;
  startTc: string;
  endTc: string;
  durationTc: string;
}

export interface AudioSection {
  /** Clips this section writes to (media clips that still own their audio). */
  clipIds: Uuid[];
  volume: CommonNumber;
  fadeInUs: CommonNumber;
  fadeOutUs: CommonNumber;
  muted: CommonBoolean;
  /** Slider ceiling: no fade may exceed the SHORTEST selected clip. */
  maxFadeUs: MicroSec;
}

export interface VisualSection {
  /** Clips this section writes to (everything that is drawn = not audio). */
  clipIds: Uuid[];
  x: CommonNumber;
  y: CommonNumber;
  scale: CommonNumber;
  rotationDeg: CommonNumber;
  opacity: CommonNumber;
}

/**
 * Text style section (M4 wave 2). Optional schema objects (`stroke`,
 * `background`) are flattened into an `*Enabled` toggle plus their fields, so a
 * mixed selection can say "some have an outline" without the panel having to
 * reason about undefined vs missing.
 */
export interface TextSection {
  /** Clips this section writes to (text clips only). */
  clipIds: Uuid[];
  content: CommonString;
  fontId: CommonString;
  fontSizePx: CommonNumber;
  fontWeight: CommonNumber;
  italic: CommonBoolean;
  fill: CommonString;
  align: CommonString;
  lineHeight: CommonNumber;
  strokeEnabled: CommonBoolean;
  strokeColor: CommonString;
  strokeWidthPx: CommonNumber;
  backgroundEnabled: CommonBoolean;
  backgroundColor: CommonString;
  backgroundPaddingPx: CommonNumber;
  backgroundRadiusPx: CommonNumber;
}

export interface ShapeSection {
  /** Clips this section writes to (shape clips only). */
  clipIds: Uuid[];
  type: CommonString;
  fill: CommonString;
  strokeEnabled: CommonBoolean;
  strokeColor: CommonString;
  strokeWidthPx: CommonNumber;
  radiusPx: CommonNumber;
}

export interface ClipInspectorModel {
  /** Selected clips that still exist in the document. */
  count: number;
  /** False when ANY selected clip sits on a locked track — panel goes read-only. */
  editable: boolean;
  /** Present only for a single selection. */
  identity: ClipIdentity | null;
  audio: AudioSection | null;
  visual: VisualSection | null;
  text: TextSection | null;
  shape: ShapeSection | null;
}

export interface AssetNameSource {
  get(assetId: Uuid): { name: string } | undefined;
}

interface Located {
  clip: Clip;
  track: Track;
  trackIndex: number;
}

function locate(doc: TimelineDoc, selection: ReadonlySet<Uuid>): Located[] {
  const found: Located[] = [];
  for (let ti = 0; ti < doc.tracks.length; ti++) {
    const track = doc.tracks[ti];
    for (const clip of track.clips) {
      if (selection.has(clip.id)) found.push({ clip, track, trackIndex: ti });
    }
  }
  return found;
}

export function commonNumber(values: readonly number[]): CommonNumber {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

export function commonBoolean(values: readonly boolean[]): CommonBoolean {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

export function commonString(values: readonly string[]): CommonString {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

const KIND_LABELS: Record<Clip['kind'], string> = {
  video: 'Video',
  audio: 'Ses',
  image: 'Görsel',
  text: 'Metin',
  shape: 'Şekil',
  sticker: 'Çıkartma',
};

const TRACK_LABELS: Record<Track['type'], string> = {
  video: 'Video',
  audio: 'Ses',
  overlay: 'Katman',
};

function clipName(clip: Clip, assets: AssetNameSource | undefined): string {
  if (isMediaClip(clip) || clip.kind === 'sticker') {
    const asset = assets?.get(clip.assetId);
    if (asset?.name) return asset.name;
    // Asset metadata not loaded (or the clip outlived it): show a stable stub
    // instead of an empty row, so the panel never looks broken.
    return `${KIND_LABELS[clip.kind]} klibi`;
  }
  if (clip.kind === 'text') {
    const content = clip.text.content.trim();
    return content.length > 0 ? content.slice(0, 40) : 'Metin';
  }
  return KIND_LABELS[clip.kind];
}

function buildIdentity(
  located: Located,
  fps: Rational,
  assets: AssetNameSource | undefined,
): ClipIdentity {
  const { clip, track, trackIndex } = located;
  const endUs = clip.timelineStartUs + clip.timelineDurationUs;
  return {
    clipId: clip.id,
    name: clipName(clip, assets),
    kindLabel: KIND_LABELS[clip.kind],
    trackLabel: `${TRACK_LABELS[track.type]} ${trackIndex + 1}${track.locked ? ' (kilitli)' : ''}`,
    sourceRange: isMediaClip(clip)
      ? `${formatTimecode(clip.sourceInUs, fps)} → ${formatTimecode(clip.sourceOutUs, fps)}`
      : null,
    startTc: formatTimecode(clip.timelineStartUs, fps),
    endTc: formatTimecode(endUs, fps),
    durationTc: formatTimecode(clip.timelineDurationUs, fps),
  };
}

/**
 * Derives the whole panel from (document, selection). Clips in the selection
 * that no longer exist are ignored — selection is view state and may lag a
 * delete/undo by a render.
 */
export function buildClipInspectorModel(
  doc: TimelineDoc,
  selection: ReadonlySet<Uuid>,
  assets?: AssetNameSource,
): ClipInspectorModel {
  const located = locate(doc, selection);
  if (located.length === 0) {
    return {
      count: 0,
      editable: false,
      identity: null,
      audio: null,
      visual: null,
      text: null,
      shape: null,
    };
  }

  const editable = located.every((l) => !l.track.locked);
  const identity = located.length === 1 ? buildIdentity(located[0], doc.settings.fps, assets) : null;

  // Audio: video/audio clips that still own their embedded audio. A video clip
  // whose sound was detached has audio === null and drops out of the section.
  const audioClips: { id: Uuid; audio: ClipAudio; durationUs: MicroSec }[] = [];
  for (const { clip } of located) {
    if (isMediaClip(clip) && clip.audio !== null) {
      audioClips.push({ id: clip.id, audio: clip.audio, durationUs: clip.timelineDurationUs });
    }
  }
  const audio: AudioSection | null =
    audioClips.length === 0
      ? null
      : {
          clipIds: audioClips.map((c) => c.id),
          volume: commonNumber(audioClips.map((c) => c.audio.volume)),
          fadeInUs: commonNumber(audioClips.map((c) => c.audio.fadeInUs)),
          fadeOutUs: commonNumber(audioClips.map((c) => c.audio.fadeOutUs)),
          muted: commonBoolean(audioClips.map((c) => c.audio.muted)),
          maxFadeUs: Math.min(
            FADE_SLIDER_MAX_US,
            Math.min(...audioClips.map((c) => c.durationUs)),
          ),
        };

  // Visual: everything that is drawn. Audio clips carry a transform in the
  // schema but nothing renders it, so they are excluded on purpose.
  const visualClips = located.map((l) => l.clip).filter((c) => c.kind !== 'audio');
  const visual: VisualSection | null =
    visualClips.length === 0
      ? null
      : {
          clipIds: visualClips.map((c) => c.id),
          x: commonNumber(visualClips.map((c) => c.transform.x)),
          y: commonNumber(visualClips.map((c) => c.transform.y)),
          scale: commonNumber(visualClips.map((c) => c.transform.scale)),
          rotationDeg: commonNumber(visualClips.map((c) => c.transform.rotationDeg)),
          opacity: commonNumber(visualClips.map((c) => c.opacity)),
        };

  // Text / shape styles (M4 wave 2). A selection can legitimately mix kinds
  // (a caption and its background box): each section appears when at least one
  // clip of its kind is selected and writes ONLY to those clips.
  const textClips = located.map((l) => l.clip).filter((c): c is TextClip => c.kind === 'text');
  const text: TextSection | null =
    textClips.length === 0
      ? null
      : {
          clipIds: textClips.map((c) => c.id),
          content: commonString(textClips.map((c) => c.text.content)),
          fontId: commonString(textClips.map((c) => c.text.fontId)),
          fontSizePx: commonNumber(textClips.map((c) => c.text.fontSizePx)),
          fontWeight: commonNumber(textClips.map((c) => c.text.fontWeight)),
          italic: commonBoolean(textClips.map((c) => c.text.italic)),
          fill: commonString(textClips.map((c) => c.text.fill)),
          align: commonString(textClips.map((c) => c.text.align)),
          lineHeight: commonNumber(textClips.map((c) => c.text.lineHeight)),
          strokeEnabled: commonBoolean(textClips.map((c) => c.text.stroke !== undefined)),
          strokeColor: commonString(
            textClips.map((c) => c.text.stroke?.color).filter((v): v is string => v !== undefined),
          ),
          strokeWidthPx: commonNumber(
            textClips
              .map((c) => c.text.stroke?.widthPx)
              .filter((v): v is number => v !== undefined),
          ),
          backgroundEnabled: commonBoolean(textClips.map((c) => c.text.background !== undefined)),
          backgroundColor: commonString(
            textClips
              .map((c) => c.text.background?.color)
              .filter((v): v is string => v !== undefined),
          ),
          backgroundPaddingPx: commonNumber(
            textClips
              .map((c) => c.text.background?.paddingPx)
              .filter((v): v is number => v !== undefined),
          ),
          backgroundRadiusPx: commonNumber(
            textClips
              .map((c) => c.text.background?.radiusPx)
              .filter((v): v is number => v !== undefined),
          ),
        };

  const shapeClips = located.map((l) => l.clip).filter((c): c is ShapeClip => c.kind === 'shape');
  const shape: ShapeSection | null =
    shapeClips.length === 0
      ? null
      : {
          clipIds: shapeClips.map((c) => c.id),
          type: commonString(shapeClips.map((c) => c.shape.type)),
          fill: commonString(shapeClips.map((c) => c.shape.fill)),
          strokeEnabled: commonBoolean(shapeClips.map((c) => c.shape.stroke !== undefined)),
          strokeColor: commonString(
            shapeClips.map((c) => c.shape.stroke?.color).filter((v): v is string => v !== undefined),
          ),
          strokeWidthPx: commonNumber(
            shapeClips
              .map((c) => c.shape.stroke?.widthPx)
              .filter((v): v is number => v !== undefined),
          ),
          radiusPx: commonNumber(
            shapeClips.map((c) => c.shape.radiusPx ?? 0),
          ),
        };

  return { count: located.length, editable, identity, audio, visual, text, shape };
}

// ---------------------------------------------------------------------------
// Formatting (labels only — the document always stores the raw linear value)
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

/** "0.0 dB" / "+6.0 dB" / "-6.0 dB" / "-∞ dB". `null` (mixed) -> "—". */
export function formatDb(volume: CommonNumber): string {
  if (volume === null) return MIXED_LABEL;
  const db = linearToDb(volume);
  if (!Number.isFinite(db)) return '-∞ dB';
  const rounded = Math.round(db * 10) / 10;
  // -0.0 is noise; normalize it to 0.0 so the label never flickers a sign.
  const shown = Object.is(rounded, -0) ? 0 : rounded;
  const sign = shown > 0 ? '+' : '';
  return `${sign}${shown.toFixed(1)} dB`;
}

/** "1.00×" — the raw linear factor next to the dB label. */
export function formatGain(volume: CommonNumber): string {
  return volume === null ? MIXED_LABEL : `${volume.toFixed(2)}×`;
}

/** Microseconds -> "1.25 s" (fade fields are edited in seconds). */
export function formatSeconds(valueUs: CommonNumber, decimals = 2): string {
  if (valueUs === null) return MIXED_LABEL;
  return `${(valueUs / 1_000_000).toFixed(decimals)} s`;
}

/** Formats a numeric field value, collapsing a mixed selection to "—". */
export function formatNumber(value: CommonNumber, decimals: number): string {
  return value === null ? MIXED_LABEL : value.toFixed(decimals);
}
