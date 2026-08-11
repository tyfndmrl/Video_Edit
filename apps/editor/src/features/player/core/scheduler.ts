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
import type { ActiveClip } from './resolve';
import type { MediaClip, MicroSec, TimelineDoc, Track, Uuid } from '@videoedit/timeline-schema';
import { isMediaClip } from '@videoedit/timeline-schema';
import {
  clipAudioOf,
  clipEndUs,
  isClipActiveAt,
  isClipMuted,
  sourceTimeUs,
  sourceTimeUsInWindow,
  transitionHandleUs,
  transitionWindowAt,
} from './resolve';

export const POOL_SIZE = 4;
/** Start preparing the next clip ~1 s before the cut (design §4.2). */
export const PRELOAD_LOOKAHEAD_US = 1_000_000;

export interface SlotRequest {
  clipId: Uuid;
  assetId: Uuid;
  /** 0 = active now; preloads get 1 + (startUs - tUs) so sooner = smaller. */
  priority: number;
  /**
   * The owning track is hidden, i.e. this clip's PICTURE is not drawn
   * (resolveVisualStack skips it). It may still be audible — see the ordering
   * note in compareSlotRequests.
   */
  hidden: boolean;
  /**
   * Index of the owning track. tracks[0] is the TOP layer (schema contract), so
   * a SMALLER index means "closer to the viewer" and wins ties.
   */
  trackIndex: number;
  /** Where the element should be positioned (active: now; preload: clip start). */
  sourceTimeUs: MicroSec;
  /** Element playbackRate base = clip speed. */
  rate: number;
}

/**
 * Total order over slot requests — the ONLY place that decides who gets an
 * element when the pool is over-subscribed.
 *
 * 1. priority: active clips (0) always beat preloads (>= 1); sooner preloads
 *    beat later ones.
 * 2. hidden: a VISIBLE layer always beats a hidden one of the same urgency.
 *    This rung exists because the scheduler used to be hidden-agnostic and the
 *    user's most natural remedy for an over-subscribed preview — hiding the
 *    layers they do not need — made it WORSE: a hidden track on a small index
 *    kept its element and starved the visible layer underneath it, turning the
 *    preview black. Hiding a track must always free capacity, never consume it.
 *    Cost of the rule: a hidden track is still AUDIBLE (resolveAudible ignores
 *    `hidden`), so yielding its element can silence it. That is reported —
 *    countPreviewLayers counts audio too and the panel note names what dropped.
 * 3. trackIndex: among equally urgent, equally visible requests the TOP-most
 *    layer wins. Known limitation (M4 audit #22): with a picture-in-picture
 *    composition the small overlay on top can evict the full-frame base layer.
 *    The note names the dropped layer so the user can act (hide the overlay,
 *    which now really does free its slot); an automatic "the base layer wins"
 *    rule needs decoded frame sizes the scheduler does not have.
 * 4. clipId: last-resort tie-break so the plan is deterministic frame to frame
 *    (two clips of the same track cannot be active at once, so this only
 *    matters for malformed docs — but a flapping plan would thrash decoders).
 */
export function compareSlotRequests(a: SlotRequest, b: SlotRequest): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
  if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
  return a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0;
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
  for (let trackIndex = 0; trackIndex < doc.tracks.length; trackIndex++) {
    const track = doc.tracks[trackIndex]!;
    /**
     * Inside a transition window BOTH clips are on screen and audible
     * (rendering-semantics §5.3/§5.4), so both are priority 0 — a transition
     * pair OUTRANKS every preload. Only one of them is `isClipActiveAt` (the
     * other one is either not started yet or already over), which is exactly
     * why the pair has to be recognised here: as a plain preload the incoming
     * clip would lose its element to a nearer preload on another track and the
     * crossfade would half-vanish.
     */
    const window = transitionWindowAt(track, tUs);
    for (const clip of track.clips) {
      if (!isMediaClip(clip) || !needsElement(clip)) continue;
      // null unless THIS clip is one of the two sides of the open window.
      const side =
        window !== null && (clip.id === window.from.id || clip.id === window.to.id)
          ? window
          : null;
      if (side !== null || isClipActiveAt(clip, tUs)) {
        requests.push({
          clipId: clip.id,
          assetId: clip.assetId,
          priority: 0,
          hidden: track.hidden,
          trackIndex,
          sourceTimeUs:
            side !== null
              ? sourceTimeUsInWindow(
                  clip,
                  tUs,
                  transitionHandleUs(side.durationUs, clip.speed.rate),
                )
              : sourceTimeUs(clip, tUs),
          rate: clip.speed.rate,
        });
      } else if (clip.timelineStartUs > tUs && clip.timelineStartUs - tUs <= lookaheadUs) {
        requests.push({
          clipId: clip.id,
          assetId: clip.assetId,
          priority: 1 + (clip.timelineStartUs - tUs),
          hidden: track.hidden,
          trackIndex,
          sourceTimeUs: clip.sourceInUs,
          rate: clip.speed.rate,
        });
        break; // one preload per track is enough (double-buffer)
      }
      if (clipEndUs(clip) > tUs + lookaheadUs) break; // sorted — rest is far future
    }
  }
  requests.sort(compareSlotRequests);
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
  // Winners: top maxSlots by the total order (wanted is caller-sorted already;
  // sorting defensively keeps planPool correct for hand-built inputs too).
  const sorted = [...wanted].sort(compareSlotRequests);
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

// ---------------------------------------------------------------------------
// Preview capacity reporting
// ---------------------------------------------------------------------------

/**
 * What the preview is actually able to deliver right now — PICTURE AND SOUND.
 *
 * The pool is finite (POOL_SIZE elements shared by video AND audio clips), so a
 * composition with more simultaneous element-hungry clips than slots has to
 * drop some — compareSlotRequests decides which. Dropping is a legitimate v1
 * limitation; hiding it is not, so PlayerPanel renders the numbers below as a
 * visible note.
 *
 * Audio is counted separately and deliberately: audio clips live on the BOTTOM
 * tracks of a normal project, so under the trackIndex tie-break they are the
 * FIRST to lose their element. "4 video layers + 1 music bed" therefore played
 * silently while the note only talked about video layers — the engine contract
 * (engine.ts previewStatus$) says a dropped layer must be reported, and a
 * dropped audio bed is exactly as invisible-to-debug as a dropped picture.
 *
 * `hasElement` answers "does this clip currently own a pool element?" — the
 * caller passes the REAL pool, so the note reports what is on screen rather
 * than what a plan hoped for.
 */
export interface PreviewCapacity {
  /** Active visual clips on visible tracks at this instant. */
  totalLayers: number;
  /** How many of them can be composited (the rest have no element). */
  shownLayers: number;
  /** Clips that should be AUDIBLE at this instant (unmuted, carrying audio). */
  totalAudio: number;
  /** How many of them own an element (the rest are SILENT). */
  shownAudio: number;
  /** Labels of what had to be dropped, top track first (see trackLabel). */
  dropped: readonly string[];
}

/** Human label for a track in the note: its name, else its 1-based layer no. */
export function trackLabel(track: Track, trackIndex: number): string {
  const name = track.name?.trim();
  if (name) return name;
  return `${track.type === 'audio' ? 'Ses' : 'Katman'} ${trackIndex + 1}`;
}

export function countPreviewLayers(
  visualStack: readonly ActiveClip[],
  audibleStack: readonly ActiveClip<MediaClip>[],
  hasElement: (clipId: Uuid) => boolean,
): PreviewCapacity {
  let totalLayers = 0;
  let shownLayers = 0;
  let totalAudio = 0;
  let shownAudio = 0;
  /** trackIndex -> label, so one starved track is named once even if both its
   *  picture and its sound went missing. */
  const dropped = new Map<number, string>();

  for (const { clip, track, trackIndex } of visualStack) {
    if (!isMediaClip(clip)) continue; // text/shape/sticker: no element, drawn later
    if (clip.kind === 'audio') continue; // never visual (resolveVisualStack drops it too)
    totalLayers++;
    // Images are plain textures — they never compete for a <video> element.
    if (clip.kind === 'image' || hasElement(clip.id)) shownLayers++;
    else dropped.set(trackIndex, trackLabel(track, trackIndex));
  }

  for (const { clip, track, trackIndex } of audibleStack) {
    // Silent by INTENT (muted track/clip, no audio at all) is not a capacity
    // problem — counting it would cry wolf on every muted layer.
    if (clipAudioOf(clip) === null || isClipMuted(track, clip)) continue;
    totalAudio++;
    if (hasElement(clip.id)) shownAudio++;
    else dropped.set(trackIndex, trackLabel(track, trackIndex));
  }

  return {
    totalLayers,
    shownLayers,
    totalAudio,
    shownAudio,
    dropped: [...dropped.entries()].sort((a, b) => a[0] - b[0]).map(([, label]) => label),
  };
}

/** Value equality for the previewStatus$ change filter (arrays included). */
export function samePreviewCapacity(a: PreviewCapacity, b: PreviewCapacity): boolean {
  return (
    a.totalLayers === b.totalLayers &&
    a.shownLayers === b.shownLayers &&
    a.totalAudio === b.totalAudio &&
    a.shownAudio === b.shownAudio &&
    a.dropped.length === b.dropped.length &&
    a.dropped.every((label, i) => label === b.dropped[i])
  );
}

export interface PreviewNote {
  /** One-line badge over the canvas. */
  text: string;
  /** Tooltip: why it happens, what it does NOT affect, and what dropped. */
  detail: string;
}

/**
 * The honest-degradation note, or null when nothing was dropped. Pure so the
 * exact wording is unit-tested instead of eyeballed in a screenshot.
 */
export function previewShortfallNote(
  capacity: PreviewCapacity,
  poolSize: number = POOL_SIZE,
): PreviewNote | null {
  const layersShort = capacity.shownLayers < capacity.totalLayers;
  const audioShort = capacity.shownAudio < capacity.totalAudio;
  if (!layersShort && !audioShort) return null;

  const parts: string[] = [];
  if (layersShort) {
    parts.push(`${capacity.shownLayers} / ${capacity.totalLayers} katman gösteriliyor`);
  }
  if (audioShort) {
    parts.push(`${capacity.shownAudio} / ${capacity.totalAudio} ses klibi çalıyor`);
  }
  const detail = [
    `Önizleme motoru aynı anda en fazla ${poolSize} medya çözücü kullanabiliyor;` +
      ' kapasite dolduğunda görünür katmanlara ve üstteki katmanlara öncelik verilir.',
    capacity.dropped.length > 0 ? `Şu an düşen: ${capacity.dropped.join(', ')}.` : '',
    'Dışa aktarımda TÜM katmanlar ve sesler işlenir.',
  ]
    .filter((s) => s !== '')
    .join(' ');

  return { text: `Önizlemede ${parts.join(', ')}`, detail };
}
