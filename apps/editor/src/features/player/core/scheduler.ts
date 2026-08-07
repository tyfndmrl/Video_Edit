/**
 * Video element pool scheduling — pure decision logic (unit-testable).
 *
 * The v1 engine keeps a pool of at most POOL_SIZE hidden <video> elements.
 * Target policy (design doc §4.2): one element per currently ACTIVE video/audio
 * media clip, plus double-buffer preloads for clips starting within the
 * lookahead window (~1 s) so cuts don't stall.
 *
 * planPool() is deliberately stable: a clip that stays wanted keeps its slot
 * (and therefore its <video> element, decoder and MediaElementAudioSourceNode).
 */
import type { MediaClip, MicroSec, TimelineDoc, Uuid } from '@videoedit/timeline-schema';
import { isMediaClip } from '@videoedit/timeline-schema';
import { clipEndUs, isClipActiveAt, sourceTimeUs } from './resolve';

export const POOL_SIZE = 4;
/** Start preparing the next clip ~1 s before the cut (design §4.2). */
export const PRELOAD_LOOKAHEAD_US = 1_000_000;

export interface SlotRequest {
  clipId: Uuid;
  assetId: Uuid;
  /** 0 = active now; preloads get 1 + (startUs - tUs) so sooner = smaller. */
  priority: number;
  /** Where the element should be positioned (active: now; preload: clip start). */
  sourceTimeUs: MicroSec;
  /** Element playbackRate base = clip speed. */
  rate: number;
}

/** Needs a real <video> element? (images are plain textures, no element). */
function needsElement(clip: MediaClip): boolean {
  return clip.kind === 'video' || clip.kind === 'audio';
}

/**
 * Which clips want a pool element at time tUs: all active video/audio clips,
 * plus the next clip of each track when it starts within the lookahead window.
 * Sorted by priority (active first, then by time-to-start).
 */
export function computeSlotRequests(
  doc: TimelineDoc,
  tUs: MicroSec,
  lookaheadUs: MicroSec = PRELOAD_LOOKAHEAD_US,
): SlotRequest[] {
  const requests: SlotRequest[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || !needsElement(clip)) continue;
      if (isClipActiveAt(clip, tUs)) {
        requests.push({
          clipId: clip.id,
          assetId: clip.assetId,
          priority: 0,
          sourceTimeUs: sourceTimeUs(clip, tUs),
          rate: clip.speed.rate,
        });
      } else if (clip.timelineStartUs > tUs && clip.timelineStartUs - tUs <= lookaheadUs) {
        requests.push({
          clipId: clip.id,
          assetId: clip.assetId,
          priority: 1 + (clip.timelineStartUs - tUs),
          sourceTimeUs: clip.sourceInUs,
          rate: clip.speed.rate,
        });
        break; // one preload per track is enough (double-buffer)
      }
      if (clipEndUs(clip) > tUs + lookaheadUs) break; // sorted — rest is far future
    }
  }
  requests.sort((a, b) => a.priority - b.priority);
  return requests;
}

export interface PoolAssignment {
  slot: number;
  clipId: Uuid;
  assetId: Uuid;
}

/**
 * Assign wanted clips to pool slots.
 *
 * Rules:
 * - at most maxSlots assignments; when over-subscribed the highest-priority
 *   (lowest number) requests win — active clips always beat preloads
 * - a clip that keeps being wanted KEEPS its slot (stability: no element churn)
 * - freed slots are reused for new requests in priority order
 */
export function planPool(
  current: readonly PoolAssignment[],
  wanted: readonly SlotRequest[],
  maxSlots: number = POOL_SIZE,
): PoolAssignment[] {
  // Winners: top maxSlots by priority (wanted is caller-sorted; sort defensively).
  const sorted = [...wanted].sort((a, b) => a.priority - b.priority);
  const winners = sorted.slice(0, maxSlots);
  const winnerIds = new Set(winners.map((w) => w.clipId));

  const kept: PoolAssignment[] = [];
  const usedSlots = new Set<number>();
  for (const a of current) {
    if (a.slot >= maxSlots) continue; // pool shrank
    if (winnerIds.has(a.clipId) && !usedSlots.has(a.slot)) {
      kept.push(a);
      usedSlots.add(a.slot);
    }
  }

  const keptIds = new Set(kept.map((a) => a.clipId));
  const result = [...kept];
  let nextSlot = 0;
  for (const w of winners) {
    if (keptIds.has(w.clipId)) continue;
    while (usedSlots.has(nextSlot)) nextSlot++;
    if (nextSlot >= maxSlots) break;
    result.push({ slot: nextSlot, clipId: w.clipId, assetId: w.assetId });
    usedSlots.add(nextSlot);
  }
  result.sort((a, b) => a.slot - b.slot);
  return result;
}
