/**
 * Timeline geometry — the single time<->pixel transform and track layout.
 * xPx = (timeUs - scrollUs) * pxPerUs (design 01 §3.2).
 */
import type { MicroSec } from '@videoedit/timeline-schema';

export const RULER_H = 28;
export const TRACK_H = 56;
export const TRACK_GAP = 6;
/** Height of the "drop here for a new track" zone below the last track. */
export const NEW_TRACK_ZONE_H = 44;
/** Trim handle hit width inside each clip edge, px. */
export const TRIM_HANDLE_W = 8;

/**
 * Transition badge on a cut: width/height and the gap from the lane bottom.
 *
 * It lives in the BOTTOM strip on purpose — the trim handles cover the full
 * lane height on both sides of the same cut, and the roll-trim gesture grabs
 * the vertical MIDDLE of the edge. A centred badge would steal that grab.
 */
export const TRANSITION_BADGE_W = 20;
export const TRANSITION_BADGE_H = 14;
export const TRANSITION_BADGE_BOTTOM_GAP = 3;

/** Content-space top of the transition badge in track row `index`. */
export function transitionBadgeTop(index: number): number {
  return trackTop(index) + TRACK_H - TRANSITION_BADGE_H - TRANSITION_BADGE_BOTTOM_GAP;
}

/**
 * A cut only gets a badge when BOTH neighbours are wide enough to still be
 * grabbable next to it; otherwise the badge would cover whole clips at low
 * zoom and make trimming impossible.
 */
export const TRANSITION_BADGE_MIN_CLIP_W = 26;
/** Snap threshold in screen px (design 01 §3.3). */
export const SNAP_THRESHOLD_PX = 8;

/** pxPerUs bounds (design 01 §3.2: ~[width/totalDur, 0.005]). */
export const MIN_PX_PER_US = 0.000001; // 1 px per second
export const MAX_PX_PER_US = 0.005; // 5 px per ms (frame-level zoom)

export const clampPxPerUs = (v: number): number =>
  Math.min(MAX_PX_PER_US, Math.max(MIN_PX_PER_US, v));

export function timeToX(timeUs: MicroSec, scrollUs: MicroSec, pxPerUs: number): number {
  return (timeUs - scrollUs) * pxPerUs;
}

export function xToTime(xPx: number, scrollUs: MicroSec, pxPerUs: number): MicroSec {
  return Math.max(0, Math.round(scrollUs + xPx / pxPerUs));
}

/** Content-space y of the top of track row `index` (0 = first/topmost row). */
export function trackTop(index: number): number {
  return index * (TRACK_H + TRACK_GAP);
}

export function tracksContentHeight(trackCount: number): number {
  return trackCount * (TRACK_H + TRACK_GAP) + NEW_TRACK_ZONE_H;
}

/**
 * Track row at a content-space y. Returns the row index, 'new' inside the
 * new-track zone below the rows, or null in a gap/above.
 */
export function trackIndexAtY(contentY: number, trackCount: number): number | 'new' | null {
  if (contentY < 0) return null;
  const row = Math.floor(contentY / (TRACK_H + TRACK_GAP));
  if (row >= trackCount) {
    return contentY <= trackTop(trackCount) + NEW_TRACK_ZONE_H ? 'new' : null;
  }
  const within = contentY - trackTop(row);
  return within <= TRACK_H ? row : null; // gap between rows
}

/** Visible time range with a small margin, for virtualization. */
export function visibleRangeUs(
  scrollUs: MicroSec,
  pxPerUs: number,
  widthPx: number,
): { startUs: MicroSec; endUs: MicroSec } {
  const marginUs = 64 / pxPerUs;
  return {
    startUs: Math.max(0, Math.floor(scrollUs - marginUs)),
    endUs: Math.ceil(scrollUs + widthPx / pxPerUs + marginUs),
  };
}

/** Zoom level that fits the whole content span into the viewport (5% margin). */
export function fitPxPerUs(viewportWidthPx: number, contentEndUs: MicroSec): number {
  if (contentEndUs <= 0) return clampPxPerUs(0.0001);
  return clampPxPerUs((viewportWidthPx * 0.95) / contentEndUs);
}
