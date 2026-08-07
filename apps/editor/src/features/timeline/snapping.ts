/**
 * Snapping resolver (design 01 §3.3): candidate targets are other clip edges,
 * the playhead and markers, with an 8 px screen threshold — nearest wins.
 * The project fps frame grid is the ALWAYS-ON fallback (doc times live on the
 * grid per rendering-semantics §1.4), applied when no candidate is in range
 * or when snapping is toggled off.
 */
import {
  snapUsToFrameGrid,
  type MicroSec,
  type Rational,
  type TimelineDoc,
  type Uuid,
} from '@videoedit/timeline-schema';
import { SNAP_THRESHOLD_PX } from './geometry';

export interface SnapResult {
  timeUs: MicroSec;
  /** Non-null when a candidate target won (draw the orange guide there). */
  snappedTo: MicroSec | null;
}

/**
 * Collect snap candidate times: clip edges (excluding the dragged clips),
 * playhead, markers. Sorted ascending.
 */
export function collectSnapCandidates(
  doc: TimelineDoc,
  opts: { excludeClipIds?: ReadonlySet<Uuid>; playheadUs?: MicroSec } = {},
): MicroSec[] {
  const set = new Set<MicroSec>();
  set.add(0);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (opts.excludeClipIds?.has(clip.id)) continue;
      set.add(clip.timelineStartUs);
      set.add(clip.timelineStartUs + clip.timelineDurationUs);
    }
  }
  for (const marker of doc.markers) set.add(marker.timeUs);
  if (opts.playheadUs !== undefined) set.add(opts.playheadUs);
  return [...set].sort((a, b) => a - b);
}

/**
 * Resolve a raw time against candidates + frame grid.
 * - enabled && a candidate within thresholdPx: the NEAREST candidate wins.
 * - otherwise: frame-grid snap.
 */
export function resolveSnap(
  rawUs: MicroSec,
  candidates: readonly MicroSec[],
  pxPerUs: number,
  fps: Rational,
  enabled: boolean,
  thresholdPx: number = SNAP_THRESHOLD_PX,
): SnapResult {
  const raw = Math.max(0, Math.round(rawUs));
  if (enabled && candidates.length > 0) {
    const thresholdUs = thresholdPx / pxPerUs;
    let best: MicroSec | null = null;
    let bestDist = Infinity;
    // Binary search for the insertion point, then inspect neighbors.
    let lo = 0;
    let hi = candidates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[mid] < raw) lo = mid + 1;
      else hi = mid;
    }
    for (const i of [lo - 1, lo, lo + 1]) {
      if (i < 0 || i >= candidates.length) continue;
      const dist = Math.abs(candidates[i] - raw);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidates[i];
      }
    }
    if (best !== null && bestDist <= thresholdUs) {
      return { timeUs: best, snappedTo: best };
    }
  }
  return { timeUs: snapUsToFrameGrid(raw, fps), snappedTo: null };
}

/**
 * Snap helper for a move drag: tries to land EITHER edge of the anchor clip on
 * a candidate; the winning edge adjusts the uniform delta for the whole
 * selection. Falls back to grid-snapping the anchor's start.
 */
export function resolveMoveSnap(
  anchorStartUs: MicroSec,
  anchorDurationUs: MicroSec,
  rawDeltaUs: MicroSec,
  candidates: readonly MicroSec[],
  pxPerUs: number,
  fps: Rational,
  enabled: boolean,
): { deltaUs: MicroSec; snappedTo: MicroSec | null } {
  const rawStart = anchorStartUs + rawDeltaUs;
  const rawEnd = rawStart + anchorDurationUs;
  const startRes = resolveSnap(rawStart, candidates, pxPerUs, fps, enabled);
  const endRes = resolveSnap(rawEnd, candidates, pxPerUs, fps, enabled);

  if (startRes.snappedTo !== null || endRes.snappedTo !== null) {
    const startDist = startRes.snappedTo !== null ? Math.abs(startRes.timeUs - rawStart) : Infinity;
    const endDist = endRes.snappedTo !== null ? Math.abs(endRes.timeUs - rawEnd) : Infinity;
    if (endDist < startDist) {
      return { deltaUs: endRes.timeUs - anchorDurationUs - anchorStartUs, snappedTo: endRes.snappedTo };
    }
    return { deltaUs: startRes.timeUs - anchorStartUs, snappedTo: startRes.snappedTo };
  }
  // Grid fallback via the start edge; never push the clip before 0.
  const snapped = Math.max(0, startRes.timeUs);
  return { deltaUs: snapped - anchorStartUs, snappedTo: null };
}
