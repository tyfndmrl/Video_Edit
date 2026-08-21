/**
 * keyframeModel — the animatable-channel vocabulary, as PURE data.
 *
 * Everything a reviewer cares about ("which properties can be animated", "what
 * value is on screen at the playhead", "is this channel animated at all") is
 * derived here without a DOM and without touching a store, so it is unit
 * testable. The React panels and the timeline strip only paint what this
 * module returns.
 *
 * Contract anchors:
 * - docs/rendering-semantics.md §3.3: `Keyframe.timeUs` is CLIP-RELATIVE
 *   timeline time (speed independent), easing belongs to the segment AFTER the
 *   keyframe, and a channel with no keyframes falls back to the static base
 *   value. Sampling is `sampleKeyframes` from the schema package — the
 *   REFERENCE implementation the C# exporter ports 1:1. It is imported, never
 *   re-implemented.
 * - packages/timeline-schema KeyframeTracks is a STRICT object: exactly
 *   x / y / scale / rotationDeg / opacity / volume. Effect params (`fx.*`) are
 *   deliberately NOT keyframable in the MVP.
 *
 * TIME UNIT DISCIPLINE (the one thing that bites): every `timeUs` in this
 * module and in keyframeOps is CLIP-RELATIVE. The playhead is absolute;
 * `keyframeTimeAtPlayhead()` is the ONLY sanctioned conversion and it also
 * snaps to the project frame grid, so a keyframe can never land between two
 * frames the exporter would sample (§3.4).
 */
import {
  MAX_KEYFRAME_SAMPLES,
  isMediaClip,
  keyframeSampleUpperBound,
  sampleKeyframes,
  snapUsToFrameGrid,
  type Clip,
  type Easing,
  type Keyframe,
  type MicroSec,
  type ProjectSettings,
  type Rational,
  type TimelineDoc,
  type Track,
  type Uuid,
} from '@videoedit/timeline-schema';
import { clipLocalTimeUs } from '../player/core/resolve';
import {
  OPACITY_DECIMALS,
  POSITION_DECIMALS,
  POSITION_LIMIT,
  REASON_KEYFRAME_NEEDS_NO_TRANSITION,
  REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
  ROTATION_DECIMALS,
  ROTATION_LIMIT,
  SCALE_DECIMALS,
  SCALE_MIN,
  VOLUME_DECIMALS,
  VOLUME_MAX,
  VOLUME_MIN,
  clipHasScaleKeyframes,
  clipHasTransition,
  clipRotationIsActive,
  maxClipScale,
} from '../../state/timelineOps';

/** Every animatable scalar (schema KeyframeTracks key), in panel order. */
export const KEYFRAME_CHANNELS = [
  'x',
  'y',
  'scale',
  'rotationDeg',
  'opacity',
  'volume',
] as const;

export type KeyframeChannel = (typeof KEYFRAME_CHANNELS)[number];

export function isKeyframeChannel(value: string): value is KeyframeChannel {
  return (KEYFRAME_CHANNELS as readonly string[]).includes(value);
}

export interface ChannelMeta {
  /** Same wording as the Inspector field the diamond button sits next to. */
  label: string;
  /** Short tag drawn on the timeline strip row (space is ~28 px). */
  short: string;
  unit?: string;
  /** Row colour on the timeline strip. */
  color: string;
}

export const CHANNEL_META: Readonly<Record<KeyframeChannel, ChannelMeta>> = {
  x: { label: 'Konum X', short: 'X', color: '#5a8cff' },
  y: { label: 'Konum Y', short: 'Y', color: '#7c6cff' },
  scale: { label: 'Ölçek', short: 'S', color: '#e8833a' },
  rotationDeg: { label: 'Döndürme', short: 'R', unit: '°', color: '#e0b341' },
  opacity: { label: 'Opaklık', short: 'O', color: '#57c785' },
  volume: { label: 'Seviye', short: 'V', color: '#3fb6c0' },
};

/**
 * Write bounds per channel.
 *
 * These are the SAME numbers `state/timelineOps` clamps the static base values
 * with — imported, not re-declared, because a keyframe and the base value of
 * the same property must be clampable to exactly the same range. `scale` is the
 * interesting one: its ceiling is a PROJECT property (the export compiler caps
 * a rendered layer at 8192 px), so it is resolved from the document settings.
 */
export interface ChannelBounds {
  min: number;
  max: number;
  decimals: number;
}

export function channelBounds(
  channel: KeyframeChannel,
  settings: Pick<ProjectSettings, 'width' | 'height'>,
): ChannelBounds {
  switch (channel) {
    case 'x':
    case 'y':
      return { min: -POSITION_LIMIT, max: POSITION_LIMIT, decimals: POSITION_DECIMALS };
    case 'scale':
      return { min: SCALE_MIN, max: maxClipScale(settings), decimals: SCALE_DECIMALS };
    case 'rotationDeg':
      return { min: -ROTATION_LIMIT, max: ROTATION_LIMIT, decimals: ROTATION_DECIMALS };
    case 'opacity':
      return { min: 0, max: 1, decimals: OPACITY_DECIMALS };
    case 'volume':
      return { min: VOLUME_MIN, max: VOLUME_MAX, decimals: VOLUME_DECIMALS };
  }
}

/**
 * Clamp + round exactly like the base-value ops do (timelineOps.clampFinite).
 * Returns null for a non-finite input so a broken number can never reach the
 * document. `roundHalfUp` is the schema's normative rounding (§1.2).
 */
export function clampChannelValue(
  channel: KeyframeChannel,
  value: number,
  settings: Pick<ProjectSettings, 'width' | 'height'>,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const { min, max, decimals } = channelBounds(channel, settings);
  const clamped = Math.min(max, Math.max(min, value));
  const f = 10 ** decimals;
  return Math.floor(clamped * f + 0.5) / f;
}

// ---------------------------------------------------------------------------
// Clip-level reads
// ---------------------------------------------------------------------------

/**
 * Which channels this clip kind can animate.
 *
 * `volume` needs audio the clip still owns (an image, or a video whose sound
 * was detached, has none). The visual channels are excluded for an 'audio'
 * clip: the schema gives it a transform, but nothing draws it — offering an
 * animation that renders nowhere would be a lie.
 */
export function channelIsAvailable(clip: Clip, channel: KeyframeChannel): boolean {
  if (channel === 'volume') return isMediaClip(clip) && clip.audio !== null;
  return clip.kind !== 'audio';
}

/** Kanal bu klip TÜRÜNDE hiç animasyonlanamaz (elmas düğmesi hiç çizilmez). */
export const REASON_CHANNEL_UNAVAILABLE = 'channel is not animatable on this clip';

/**
 * Bu kanala YENİ keyframe açılamamasının gerekçesi, yoksa null.
 *
 * `channelIsAvailable` klibin TÜRÜNE bakar ("ses klibinin opaklığı yoktur");
 * burada ek olarak dışa aktarıcının reddettiği BİLEŞİMLER de kapatılır
 * (state/timelineOps'taki "yönlendir-sonra-reddet" bölümü):
 *  - geçişli klipte GÖRSEL kanal (volume hariç — ses zinciri geçişten etkilenmez);
 *  - katman dönüyorken ÖLÇEK kanalı, ölçek animasyonluyken DÖNME kanalı.
 *
 * Kapı yalnız EKLEME yolundadır: var olan bir keyframe her zaman taşınabilir,
 * değeri değiştirilebilir ve TEMİZLENEBİLİR — aksi halde (eski bir projeden
 * gelen) yasak bileşimden çıkış yolu kalmazdı.
 *
 * `channelIsAvailable` bilinçli olarak DEĞİŞTİRİLMEDİ: false dönmesi paneldeki
 * elması tamamen kaldırıyor ("bu klipte böyle bir özellik yok" demek), oysa
 * buradaki kurallar geçici durumlardır ve kullanıcı NEDENİNİ görmelidir —
 * düğme yerinde kalır, kapalı ve ipucu gerekçeyi söyler.
 */
export function channelBlockReason(clip: Clip, channel: KeyframeChannel): string | null {
  if (!channelIsAvailable(clip, channel)) return REASON_CHANNEL_UNAVAILABLE;
  if (channel === 'volume') return null;
  if (clipHasTransition(clip)) return REASON_KEYFRAME_NEEDS_NO_TRANSITION;
  if (channel === 'scale' && clipRotationIsActive(clip)) {
    return REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION;
  }
  if (channel === 'rotationDeg' && clipHasScaleKeyframes(clip)) {
    return REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION;
  }
  return null;
}

/** The STATIC value of a channel (what applies when the track is empty). */
export function channelBaseValue(clip: Clip, channel: KeyframeChannel): number | null {
  switch (channel) {
    case 'x':
      return clip.transform.x;
    case 'y':
      return clip.transform.y;
    case 'scale':
      return clip.transform.scale;
    case 'rotationDeg':
      return clip.transform.rotationDeg;
    case 'opacity':
      return clip.opacity;
    case 'volume':
      return isMediaClip(clip) && clip.audio !== null ? clip.audio.volume : null;
  }
}

/** The clip's keyframes for a channel ([] when the track is absent/empty). */
export function channelKeyframes(clip: Clip, channel: KeyframeChannel): readonly Keyframe[] {
  return clip.keyframes[channel] ?? [];
}

export function channelIsAnimated(clip: Clip, channel: KeyframeChannel): boolean {
  return channelKeyframes(clip, channel).length > 0;
}

/** Channels that currently carry keyframes, in panel order. */
export function animatedChannels(clip: Clip): KeyframeChannel[] {
  return KEYFRAME_CHANNELS.filter((c) => channelIsAnimated(clip, c));
}

/** Clip-relative time, clamped into [0, duration] and integral. */
export function clampClipTimeUs(clip: Clip, timeUs: MicroSec): MicroSec {
  return Math.min(clip.timelineDurationUs, Math.max(0, Math.round(timeUs)));
}

/**
 * Absolute playhead -> the clip-relative, FRAME-SNAPPED time a keyframe would
 * be written at. Snapping matters twice: the exporter samples non-linear
 * easings once per output frame (§3.4), and two "same instant" edits (a gizmo
 * drag and an Inspector field) must land on the SAME keyframe rather than
 * silently create two a microsecond apart.
 */
export function keyframeTimeAtPlayhead(
  clip: Clip,
  playheadUs: MicroSec,
  fps: Rational,
): MicroSec {
  return clampClipTimeUs(clip, snapUsToFrameGrid(clipLocalTimeUs(clip, playheadUs), fps));
}

/**
 * Value of a channel at a clip-relative time: the sampled curve when the
 * channel is animated, the static base value otherwise. `sampleKeyframes` is
 * the schema package's reference implementation (§3.2 fixed 32-iteration
 * bisection) — never a local copy.
 */
export function channelValueAt(
  clip: Clip,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): number | null {
  const kfs = channelKeyframes(clip, channel);
  if (kfs.length === 0) return channelBaseValue(clip, channel);
  return sampleKeyframes(kfs, clampClipTimeUs(clip, timeUs));
}

/** Index of the keyframe sitting EXACTLY at `timeUs`, or -1. */
export function keyframeIndexAt(
  clip: Clip,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): number {
  return channelKeyframes(clip, channel).findIndex((k) => k.timeUs === timeUs);
}

export function keyframeAt(
  clip: Clip,
  channel: KeyframeChannel,
  timeUs: MicroSec,
): Keyframe | null {
  const i = keyframeIndexAt(clip, channel, timeUs);
  return i < 0 ? null : channelKeyframes(clip, channel)[i];
}

// ---------------------------------------------------------------------------
// Easing vocabulary (schema EasingSchema minus the free cubicBezier form —
// the MVP UI offers the four presets; a hand-authored bezier stays legal in the
// document and is displayed as "özel")
// ---------------------------------------------------------------------------

export const EASING_PRESET_TYPES = ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const;
export type EasingPresetType = (typeof EASING_PRESET_TYPES)[number];

export const EASING_OPTIONS: readonly { type: EasingPresetType; label: string }[] = [
  { type: 'linear', label: 'Doğrusal' },
  { type: 'easeIn', label: 'Yavaş başla' },
  { type: 'easeOut', label: 'Yavaş bitir' },
  { type: 'easeInOut', label: 'Yavaş başla ve bitir' },
];

export function easingLabel(easing: Easing): string {
  const preset = EASING_OPTIONS.find((o) => o.type === easing.type);
  return preset?.label ?? 'Özel eğri';
}

// ---------------------------------------------------------------------------
// Inspector model
// ---------------------------------------------------------------------------

export interface ChannelState {
  channel: KeyframeChannel;
  /** The clip kind can animate this property at all. */
  available: boolean;
  /**
   * Why a NEW keyframe cannot be added here (channelBlockReason), or null.
   * `available === false` implies a reason; the reverse does not hold — a
   * transition or a rotation blocks an otherwise animatable channel.
   */
  blockReason: string | null;
  /** The channel has at least one keyframe (the "animated" indicator). */
  animated: boolean;
  count: number;
  /** Value at the model's clip time — sampled when animated, base otherwise. */
  value: number | null;
  /** The keyframe exactly at the model's clip time, if there is one. */
  atTime: Keyframe | null;
}

/**
 * The Inspector's keyframe layer for the CURRENT selection.
 *
 * Deliberately single-selection only (`clipId === null` for 0 or 2+ clips):
 * "add a keyframe to every selected clip" needs a per-clip time (the clips sit
 * at different timeline positions) and a per-clip current value. Rather than
 * invent a semantic nobody asked for, the buttons go disabled and the panel
 * says why.
 */
export interface KeyframePanelModel {
  /** The single selected clip, or null when keyframe editing is unavailable. */
  clipId: Uuid | null;
  /** Frame-snapped, clip-relative playhead time (0 when clipId is null). */
  clipTimeUs: MicroSec;
  /** The playhead is inside the clip — a keyframe may be written here. */
  inRange: boolean;
  /** False when the clip sits on a locked track. */
  editable: boolean;
  channels: Record<KeyframeChannel, ChannelState>;
  /** Channels that carry keyframes, in panel order. */
  animated: KeyframeChannel[];
}

const EMPTY_CHANNEL_STATE = (channel: KeyframeChannel): ChannelState => ({
  channel,
  available: false,
  blockReason: REASON_CHANNEL_UNAVAILABLE,
  animated: false,
  count: 0,
  value: null,
  atTime: null,
});

function emptyChannels(): Record<KeyframeChannel, ChannelState> {
  return {
    x: EMPTY_CHANNEL_STATE('x'),
    y: EMPTY_CHANNEL_STATE('y'),
    scale: EMPTY_CHANNEL_STATE('scale'),
    rotationDeg: EMPTY_CHANNEL_STATE('rotationDeg'),
    opacity: EMPTY_CHANNEL_STATE('opacity'),
    volume: EMPTY_CHANNEL_STATE('volume'),
  };
}

export const EMPTY_KEYFRAME_PANEL_MODEL: KeyframePanelModel = {
  clipId: null,
  clipTimeUs: 0,
  inRange: false,
  editable: false,
  channels: emptyChannels(),
  animated: [],
};

interface Located {
  clip: Clip;
  track: Track;
  trackIndex: number;
}

/** Finds a clip and the track it lives on (null when it is gone). */
export function locateClip(doc: TimelineDoc, clipId: Uuid): Located | null {
  for (let ti = 0; ti < doc.tracks.length; ti++) {
    const track = doc.tracks[ti];
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track, trackIndex: ti };
  }
  return null;
}

export function buildKeyframePanelModel(
  doc: TimelineDoc,
  selection: ReadonlySet<Uuid>,
  playheadUs: MicroSec,
): KeyframePanelModel {
  if (selection.size !== 1) return EMPTY_KEYFRAME_PANEL_MODEL;
  const [clipId] = [...selection];
  if (clipId === undefined) return EMPTY_KEYFRAME_PANEL_MODEL;
  const located = locateClip(doc, clipId);
  if (located === null) return EMPTY_KEYFRAME_PANEL_MODEL;

  const { clip, track } = located;
  const clipTimeUs = keyframeTimeAtPlayhead(clip, playheadUs, doc.settings.fps);
  const inRange =
    playheadUs >= clip.timelineStartUs &&
    playheadUs < clip.timelineStartUs + clip.timelineDurationUs;

  const channels = emptyChannels();
  for (const channel of KEYFRAME_CHANNELS) {
    const available = channelIsAvailable(clip, channel);
    const kfs = channelKeyframes(clip, channel);
    channels[channel] = {
      channel,
      available,
      blockReason: channelBlockReason(clip, channel),
      animated: available && kfs.length > 0,
      count: available ? kfs.length : 0,
      value: available ? channelValueAt(clip, channel, clipTimeUs) : null,
      atTime: available ? keyframeAt(clip, channel, clipTimeUs) : null,
    };
  }

  return {
    clipId,
    clipTimeUs,
    inRange,
    editable: !track.locked,
    channels,
    animated: KEYFRAME_CHANNELS.filter((c) => channels[c].animated),
  };
}

// ---------------------------------------------------------------------------
// Keyframe ornekleme butcesi (rendering-semantics 3.4) - Inspector uyarisi
// ---------------------------------------------------------------------------

/**
 * Uyari esigi: derleme geneli ust sinir kestirimi butcenin bu oranini asinca
 * Inspector rozet gosterir. 0.8 secildi cunku kestirim UST SINIRDIR (esdeger
 * ardisik ornekleri derleyici teklestirir, editor sayar): rozet gercek
 * harcamadan once yanar, 422 kullaniciyi asla ilk haberci olarak bulmaz.
 */
export const SAMPLE_BUDGET_WARN_RATIO = 0.8;

export interface SampleBudgetStatus {
  /** Derleyicinin harcayacagi orneklerin UST SINIRI (keyframeSampleUpperBound). */
  upperBound: number;
  /** Derleme geneli tavan - backend KeyframeCompiler.MaxSamples ikizi. */
  max: number;
  /** upperBound / max (0..N; 1 ustu derlemenin kesin reddi demektir). */
  ratio: number;
  /** ratio >= SAMPLE_BUDGET_WARN_RATIO - Inspector rozetinin kosulu. */
  warn: boolean;
}

/**
 * Dokumanin keyframe ornekleme butcesi durumu (DERLEME GENELI - tek klibin
 * degil, tum kliplerin/kanallarin toplami; backend SampleBudget ayni sekilde
 * tek muhasebe tutar). Saf dokuman aritmetigi: formul sema paketinde
 * (keyframeSampleUpperBound), esik ve sunum burada.
 */
export function keyframeSampleBudget(doc: TimelineDoc): SampleBudgetStatus {
  const upperBound = keyframeSampleUpperBound(doc);
  const ratio = upperBound / MAX_KEYFRAME_SAMPLES;
  return {
    upperBound,
    max: MAX_KEYFRAME_SAMPLES,
    ratio,
    warn: ratio >= SAMPLE_BUDGET_WARN_RATIO,
  };
}
