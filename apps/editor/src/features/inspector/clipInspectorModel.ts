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
  type Effect,
  type MediaClip,
  type MicroSec,
  type Rational,
  type ShapeClip,
  type TextClip,
  type TimelineDoc,
  type Track,
  type Uuid,
} from '@videoedit/timeline-schema';
import { maxClipScale, maxClipScaleFor, maxTextSizeFor } from '../../state/timelineOps';

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
  /**
   * Scale ceiling for the SELECTION: the strictest of the selected clips, since
   * one write goes to all of them. It is per-clip and not merely per-project
   * because a text layer is drawn at `bbox * scale` (§7), so a 2000 px caption
   * runs out of room long before a video clip does (`maxClipScaleFor`).
   */
  maxScale: number;
  /** True when the ceiling comes from a text layer's own box, not the canvas. */
  maxScaleFromTextBox: boolean;
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
  /**
   * Font-size ceiling for the SELECTION (strictest selected clip). Derived, not
   * constant: line count, background padding and the clip's own scale all spend
   * the same 8192 px layer budget — see `maxTextSizeFor`.
   */
  maxFontSizePx: number;
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

/**
 * Speed section (M5). Only video/audio clips carry it — an image has no time
 * axis, so "2x" there would silently be a duration edit (see
 * timelineOps.clipSupportsSpeed).
 *
 * `nextGapUs` is what makes the panel honest BEFORE the click: it is how far
 * the SHORTEST-headroom selected clip may grow before it hits its neighbour,
 * which is exactly the bound `setClipSpeed` refuses against. null = unbounded
 * (nothing after it on the track).
 */
export interface SpeedSection {
  /** Clips this section writes to (video/audio clips). */
  clipIds: Uuid[];
  rate: CommonNumber;
  /** Timeline duration at the current rate (mixed selection -> null). */
  durationUs: CommonNumber;
  /** Free space after the clip on its track, us; null = no clip follows. */
  nextGapUs: CommonNumber;
  /** Slowest rate that still fits without rippling (null = no bound). */
  minRateWithoutRipple: number | null;
  /** true when at least one selected clip has a transition on either edge. */
  hasTransition: boolean;
}

/**
 * colorAdjust section (M5, rendering-semantics §4.1). Offered for every DRAWN
 * clip; `enabled: false` with all-zero values is the "no effect yet" state, so
 * the section never has to disappear and reappear as the user works.
 */
export interface ColorSection {
  /** Clips this section writes to (everything that is drawn). */
  clipIds: Uuid[];
  /** false = no colorAdjust effect at all, or one that is switched off. */
  enabled: CommonBoolean;
  /** True when at least one selected clip owns a colorAdjust effect. */
  present: boolean;
  brightness: CommonNumber;
  contrast: CommonNumber;
  saturation: CommonNumber;
  temperature: CommonNumber;
  tint: CommonNumber;
  exposure: CommonNumber;
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
  speed: SpeedSection | null;
  color: ColorSection | null;
}

export interface AssetNameSource {
  get(assetId: Uuid): { name: string } | undefined;
}

/**
 * Measures a text clip's §7 bbox in project px, or returns null when it cannot
 * (no DOM, font still loading). The panel passes the browser measurer
 * (features/text/overlayRaster.measureTextLayout — the SAME layout rule the
 * export's SkiaSharp uses); tests and SSR leave it out and the model falls back
 * to the font-independent lower bound the export compiler also uses. The
 * fallback can only be MORE permissive, so a missing measurement never blocks a
 * value the server would have accepted.
 */
export type TextBoxMeasurer = (clip: TextClip) => { widthPx: number; heightPx: number } | null;

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

/** Measured bbox of a text clip, or null for anything else / no measurement. */
function textBoxOf(
  clip: Clip,
  measure: TextBoxMeasurer | undefined,
): { widthPx: number; heightPx: number } | null {
  if (clip.kind !== 'text' || measure === undefined) return null;
  const box = measure(clip);
  if (box === null) return null;
  return Number.isFinite(box.widthPx) && Number.isFinite(box.heightPx) && box.widthPx > 0 && box.heightPx > 0
    ? box
    : null;
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
  measureTextBox?: TextBoxMeasurer,
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
      speed: null,
      color: null,
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
          // STRICTEST wins: the field writes one value to every selected clip,
          // so offering the loosest ceiling would let the op silently clamp the
          // others — the exact failure mode this whole blocker is about.
          maxScale: Math.min(
            ...visualClips.map((c) => maxClipScaleFor(c, doc.settings, textBoxOf(c, measureTextBox))),
          ),
          maxScaleFromTextBox: visualClips.some(
            (c) =>
              c.kind === 'text' &&
              maxClipScaleFor(c, doc.settings, textBoxOf(c, measureTextBox)) < maxClipScale(doc.settings),
          ),
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
          maxFontSizePx: Math.min(
            ...textClips.map((c) => maxTextSizeFor(c, textBoxOf(c, measureTextBox))),
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

  // Speed (M5): video/audio only. `nextGapUs` is derived from the TRACK, not
  // from the clip, which is why this section cannot be built from the clip
  // alone — the panel has to be able to say "0.5x will not fit" beforehand.
  const speedClips = located.filter((l) => l.clip.kind === 'video' || l.clip.kind === 'audio');
  const speed: SpeedSection | null =
    speedClips.length === 0
      ? null
      : {
          clipIds: speedClips.map((l) => l.clip.id),
          rate: commonNumber(speedClips.map((l) => (l.clip as MediaClip).speed.rate)),
          durationUs: commonNumber(speedClips.map((l) => l.clip.timelineDurationUs)),
          nextGapUs: commonNumber(
            speedClips
              .map((l) => gapAfterClip(l.track, l.clip))
              .filter((v): v is number => v !== null),
          ),
          minRateWithoutRipple: minRateWithoutRipple(speedClips),
          hasTransition: speedClips.some(
            (l) =>
              (l.clip as MediaClip).transitionIn !== undefined ||
              (l.clip as MediaClip).transitionOut !== undefined,
          ),
        };

  // colorAdjust (M5 §4.1): every drawn clip. A clip with no effect reads as
  // all-zero + disabled, so the section is stable while the user works.
  const colorClips = located.map((l) => l.clip).filter((c) => c.kind !== 'audio');
  const colorEffects = colorClips.map((c) => c.effects.find((e) => e.type === 'colorAdjust'));
  const colorParam = (key: ColorParamKey): CommonNumber =>
    commonNumber(colorEffects.map((e) => readColorParam(e, key)));
  const color: ColorSection | null =
    colorClips.length === 0
      ? null
      : {
          clipIds: colorClips.map((c) => c.id),
          enabled: commonBoolean(colorEffects.map((e) => e?.enabled === true)),
          present: colorEffects.some((e) => e !== undefined),
          brightness: colorParam('brightness'),
          contrast: colorParam('contrast'),
          saturation: colorParam('saturation'),
          temperature: colorParam('temperature'),
          tint: colorParam('tint'),
          exposure: colorParam('exposure'),
        };

  return { count: located.length, editable, identity, audio, visual, text, shape, speed, color };
}

/** Free timeline space after `clip` on its track; null when nothing follows. */
export function gapAfterClip(track: Track, clip: Clip): number | null {
  const endUs = clip.timelineStartUs + clip.timelineDurationUs;
  let nearest: number | null = null;
  for (const other of track.clips) {
    if (other.id === clip.id) continue;
    if (other.timelineStartUs < endUs) continue;
    if (nearest === null || other.timelineStartUs < nearest) nearest = other.timelineStartUs;
  }
  return nearest === null ? null : Math.max(0, nearest - endUs);
}

/**
 * Slowest rate the selection can take WITHOUT rippling: a clip may grow into
 * its gap only, and `duration = (out-in)/rate` means the bound is
 * `rate >= (out-in) / (duration + gap)`. The strictest selected clip wins.
 * null = nothing follows any of them, so slowing down is unbounded.
 */
function minRateWithoutRipple(clips: Located[]): number | null {
  let bound: number | null = null;
  for (const { clip, track } of clips) {
    const gap = gapAfterClip(track, clip);
    if (gap === null) continue;
    const media = clip as MediaClip;
    const room = clip.timelineDurationUs + gap;
    if (room <= 0) continue;
    const rate = (media.sourceOutUs - media.sourceInUs) / room;
    if (bound === null || rate > bound) bound = rate;
  }
  // Round UP to the stored precision: a rate rounded DOWN would be one
  // microsecond too slow and the op would refuse the value the panel offered.
  return bound === null ? null : Math.ceil(bound * 1000) / 1000;
}

type ColorParamKey = 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'tint' | 'exposure';

/** A §4.1 param of an effect, defaulting to the identity 0 (same as the shader). */
function readColorParam(effect: Effect | undefined, key: ColorParamKey): number {
  const v = effect?.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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

/**
 * "2x" / "0.5x" / "1.25x" — the speed readout AND the timeline badge text.
 * Trailing zeros are dropped so the common presets read as "2x", not "2.00x".
 */
export function formatSpeed(rate: CommonNumber): string {
  if (rate === null) return MIXED_LABEL;
  const rounded = Math.round(rate * 1000) / 1000;
  return `${String(rounded)}x`;
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
