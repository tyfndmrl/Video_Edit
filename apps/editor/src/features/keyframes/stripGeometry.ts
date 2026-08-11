/**
 * stripGeometry — where the keyframe strip and its diamonds live, as PURE
 * geometry. The canvas painter and the pointer code both read this, so "what is
 * drawn" and "what is clickable" cannot drift apart.
 *
 * Coordinates are the timeline's CONTENT space, exactly like hitTest.ts:
 * x is relative to the canvas left edge, y is track-content space (vertical
 * scroll already removed). The time<->pixel transform is the timeline's own
 * `timeToX` — there is no second mapping here.
 *
 * WHERE THE BAND SITS (and why it is not simply "under the clip")
 * ---------------------------------------------------------------
 * The lane is 56 px and every pixel of it is already spoken for:
 *   [ 2 .. 17]  clip name bar
 *   [17 .. 52]  filmstrip / waveform content
 *   [39 .. 53]  transition badge (a cut's click target)
 *   full height, 8 px at each clip edge: the trim handles
 * The strip takes the band BETWEEN the name bar and the transition badge. That
 * vertical choice is not decoration: an overlay covering a transition badge
 * would silently break a shipped interaction, which is a far worse defect than
 * a strip that is 18 px tall.
 *
 * Horizontally the band spans the WHOLE clip (a keyframe at t=0 sits exactly on
 * the clip's left edge and must stay grabbable). The trim handles survive
 * because a press that hits no diamond is not consumed: `hitTestStrip` returns
 * null and the event keeps bubbling to the timeline canvas, so only the ~12 px
 * around an actual diamond inside an 18 px band ever belongs to the strip.
 *
 * Consequence (declared, not hidden): at most
 * `KEYFRAME_STRIP_MAX_ROWS` channels are editable ON THE STRIP at once. The
 * Inspector is the COMPLETE surface — it lists and toggles every channel — and
 * the strip draws a "+N" chip when channels are folded away.
 */
import type { MicroSec, TimelineDoc, Uuid } from '@videoedit/timeline-schema';
import {
  TRACK_H,
  TRANSITION_BADGE_BOTTOM_GAP,
  TRANSITION_BADGE_H,
  timeToX,
  trackTop,
} from '../timeline/geometry';
import {
  CHANNEL_META,
  animatedChannels,
  channelKeyframes,
  locateClip,
  type KeyframeChannel,
} from './keyframeModel';

/** One channel row. Tall enough for an 8 px diamond plus a hairline baseline. */
export const KEYFRAME_ROW_H = 9;
/** Rows that fit between the name bar and the transition badge (see header). */
export const KEYFRAME_STRIP_MAX_ROWS = 2;
/** Half-diagonal of a diamond, px. */
export const KEYFRAME_DIAMOND_R = 4;
/** Horizontal grab slop around a diamond centre, px. */
export const KEYFRAME_HIT_SLOP_PX = 6;
/** Below this on-screen clip width the strip is not drawn (nothing grabbable). */
export const KEYFRAME_STRIP_MIN_CLIP_W = 34;

/** Lane-relative y of the band bottom: just above the transition badge. */
export const KEYFRAME_STRIP_BOTTOM_OFFSET =
  TRACK_H - TRANSITION_BADGE_H - TRANSITION_BADGE_BOTTOM_GAP - 1;

export interface StripDiamond {
  channel: KeyframeChannel;
  /** Index inside the channel's keyframe array. */
  index: number;
  /** CLIP-RELATIVE time (schema semantics). */
  timeUs: MicroSec;
  /** Content-space x of the diamond centre. */
  x: number;
}

export interface StripRow {
  channel: KeyframeChannel;
  color: string;
  short: string;
  /** Content-space top of the row. */
  y: number;
  diamonds: StripDiamond[];
}

export interface StripLayout {
  clipId: Uuid;
  trackIndex: number;
  /** Locked track: the strip is drawn (informative) but not editable. */
  editable: boolean;
  clipStartUs: MicroSec;
  clipDurationUs: MicroSec;
  /** Content-space band (already inset by the trim handles). */
  x0: number;
  x1: number;
  topY: number;
  bottomY: number;
  rows: StripRow[];
  /** Animated channels that did not fit — shown as a "+N" chip. */
  hiddenChannels: KeyframeChannel[];
}

export interface StripLayoutInput {
  doc: TimelineDoc;
  selection: ReadonlySet<Uuid>;
  scrollUs: MicroSec;
  pxPerUs: number;
  widthPx: number;
}

/**
 * Layout for the CURRENT selection, or null when there is nothing to draw
 * (no single selection, no animated channel, clip off-screen or too narrow).
 * Returning null is what makes the whole overlay inert by default: no rows, no
 * DOM hit area, zero interference with the existing timeline gestures.
 */
export function buildStripLayout(input: StripLayoutInput): StripLayout | null {
  const { doc, selection, scrollUs, pxPerUs, widthPx } = input;
  if (selection.size !== 1) return null;
  const [clipId] = [...selection];
  if (clipId === undefined) return null;
  const located = locateClip(doc, clipId);
  if (located === null) return null;
  const { clip, track, trackIndex } = located;

  const channels = animatedChannels(clip);
  if (channels.length === 0) return null;

  const clipX = timeToX(clip.timelineStartUs, scrollUs, pxPerUs);
  const clipW = clip.timelineDurationUs * pxPerUs;
  if (clipW < KEYFRAME_STRIP_MIN_CLIP_W) return null;
  if (clipX > widthPx || clipX + clipW < 0) return null;

  // Band = the whole clip, clipped to the viewport (plus a diamond's worth of
  // margin so a keyframe exactly on the clip edge is fully inside the box).
  const x0 = Math.max(-KEYFRAME_HIT_SLOP_PX, clipX - KEYFRAME_HIT_SLOP_PX);
  const x1 = Math.min(widthPx + KEYFRAME_HIT_SLOP_PX, clipX + clipW + KEYFRAME_HIT_SLOP_PX);
  if (x1 - x0 < 8) return null;

  const shown = channels.slice(0, KEYFRAME_STRIP_MAX_ROWS);
  const hiddenChannels = channels.slice(KEYFRAME_STRIP_MAX_ROWS);
  const bottomY = trackTop(trackIndex) + KEYFRAME_STRIP_BOTTOM_OFFSET;
  const topY = bottomY - shown.length * KEYFRAME_ROW_H;

  const rows: StripRow[] = shown.map((channel, rowIndex) => {
    const meta = CHANNEL_META[channel];
    return {
      channel,
      color: meta.color,
      short: meta.short,
      y: topY + rowIndex * KEYFRAME_ROW_H,
      diamonds: channelKeyframes(clip, channel).map((kf, index) => ({
        channel,
        index,
        timeUs: kf.timeUs,
        x: timeToX(clip.timelineStartUs + kf.timeUs, scrollUs, pxPerUs),
      })),
    };
  });

  return {
    clipId,
    trackIndex,
    editable: !track.locked,
    clipStartUs: clip.timelineStartUs,
    clipDurationUs: clip.timelineDurationUs,
    x0,
    x1,
    topY,
    bottomY,
    rows,
    hiddenChannels,
  };
}

export interface StripHit {
  channel: KeyframeChannel;
  index: number;
  timeUs: MicroSec;
  x: number;
}

/**
 * Nearest diamond under a content-space point, or null.
 * Vertical test is the row band; horizontal test is a slop window around the
 * diamond centre, so a 8 px lozenge is still comfortable to grab.
 */
export function hitTestStrip(
  layout: StripLayout,
  x: number,
  contentY: number,
): StripHit | null {
  for (const row of layout.rows) {
    if (contentY < row.y || contentY >= row.y + KEYFRAME_ROW_H) continue;
    let best: StripHit | null = null;
    let bestDx = Infinity;
    for (const d of row.diamonds) {
      const dx = Math.abs(d.x - x);
      if (dx > KEYFRAME_HIT_SLOP_PX || dx >= bestDx) continue;
      bestDx = dx;
      best = { channel: d.channel, index: d.index, timeUs: d.timeUs, x: d.x };
    }
    if (best) return best;
  }
  return null;
}

/**
 * The DOM box (content space) that must receive pointer events. Deliberately
 * the band only: everything outside it keeps flowing to the timeline canvas, so
 * clip drags, trims, the ruler and the context menu are untouched.
 */
export function stripHitRect(layout: StripLayout): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: layout.x0,
    y: layout.topY,
    width: Math.max(0, layout.x1 - layout.x0),
    height: Math.max(0, layout.bottomY - layout.topY),
  };
}

/** Content-space x -> CLIP-RELATIVE time (the unit every keyframe op takes). */
export function xToClipTimeUs(
  layout: StripLayout,
  x: number,
  scrollUs: MicroSec,
  pxPerUs: number,
): MicroSec {
  const absolute = scrollUs + x / pxPerUs;
  return Math.round(absolute - layout.clipStartUs);
}
