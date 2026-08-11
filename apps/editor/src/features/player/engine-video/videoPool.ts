/**
 * Hidden <video> element pool (design doc §4.2).
 *
 * A fixed set of detached (never in the DOM) video elements. Slot assignment
 * decisions come from core/scheduler.ts (pure); this module owns the DOM side:
 * element lifecycle, src swaps, preload positioning.
 *
 * Elements are created once and live for the whole engine lifetime because
 * createMediaElementSource() is once-per-element (audio graph constraint).
 */
import type { Uuid } from '@videoedit/timeline-schema';
import type { PoolAssignment } from '../core/scheduler';

export interface PoolSlot {
  readonly index: number;
  readonly video: HTMLVideoElement;
  clipId: Uuid | null;
  assetId: Uuid | null;
  /** Currently loaded media URL ('' = none). */
  url: string;
  /** Monotonic token to ignore stale async callbacks after reassignment. */
  epoch: number;
  /** Last media 'error' event time (per-slot retry throttle). */
  lastErrorAt: number;
}

/** Min interval between error-driven URL clears per slot (retry storm guard). */
const MEDIA_ERROR_RETRY_MIN_MS = 5_000;

/**
 * `preservesPitch` with its legacy vendor names (Safari `webkitPreservesPitch`,
 * old Gecko `mozPreservesPitch`). Exported so the rate tests can assert that
 * the engine really asks for pitch preservation — rendering-semantics §8.3.
 */
export function setPreservesPitch(el: HTMLMediaElement, value: boolean): void {
  const target = el as unknown as Record<string, unknown>;
  for (const key of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) {
    if (key in target) target[key] = value;
  }
}

export class VideoPool {
  readonly slots: PoolSlot[] = [];

  constructor(
    size: number,
    onElementCreated?: (el: HTMLVideoElement) => void,
    onMediaError?: (slot: PoolSlot) => void,
  ) {
    for (let i = 0; i < size; i++) {
      const video = document.createElement('video');
      // COEP require-corp: R2 media must be fetched with CORS (§7 pitfall 4).
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = false; // audibility is governed by the Web Audio gain graph
      // Clip speed is played back through playbackRate. The export chain
      // time-stretches with `atempo`, which PRESERVES pitch (§8.3) — so the
      // preview must too, or a 2x clip sounds like a chipmunk on screen and
      // normal in the file. The spec default is already true, but it is
      // vendor-prefixed on older engines and too load-bearing to assume.
      setPreservesPitch(video, true);
      const slot: PoolSlot = {
        index: i,
        video,
        clipId: null,
        assetId: null,
        url: '',
        epoch: 0,
        lastErrorAt: 0,
      };
      // Media error path (expired presigned URL, network failure): forget the
      // slot's URL so the next pool apply() reloads it (with a refreshed URL
      // once media-urls sync delivers one). Throttled per slot so a
      // permanently broken URL cannot cause a load/error storm.
      video.addEventListener('error', () => {
        if (slot.url === '') return; // teardown / empty-src noise
        const now = Date.now();
        if (now - slot.lastErrorAt < MEDIA_ERROR_RETRY_MIN_MS) return;
        slot.lastErrorAt = now;
        slot.url = '';
        slot.epoch++; // stale positionWhenReady callbacks must not fire
        onMediaError?.(slot);
      });
      this.slots.push(slot);
      onElementCreated?.(video);
    }
  }

  slotForClip(clipId: Uuid): PoolSlot | null {
    return this.slots.find((s) => s.clipId === clipId) ?? null;
  }

  /**
   * Apply a plan from core/scheduler.planPool. Returns slots whose clip
   * assignment CHANGED (the engine re-positions / re-schedules those).
   */
  apply(assignments: readonly PoolAssignment[], resolveUrl: (assetId: Uuid) => string | null): PoolSlot[] {
    const bySlot = new Map<number, PoolAssignment>();
    for (const a of assignments) bySlot.set(a.slot, a);

    const changed: PoolSlot[] = [];
    for (const slot of this.slots) {
      const next = bySlot.get(slot.index) ?? null;
      if (next === null) {
        if (slot.clipId !== null) {
          slot.clipId = null;
          slot.assetId = null;
          slot.epoch++;
          if (!slot.video.paused) slot.video.pause();
          changed.push(slot);
        }
        continue;
      }
      const url = resolveUrl(next.assetId) ?? '';
      const clipChanged = slot.clipId !== next.clipId;
      const urlChanged = url !== '' && url !== slot.url;
      if (!clipChanged && !urlChanged) continue;

      slot.clipId = next.clipId;
      slot.assetId = next.assetId;
      slot.epoch++;
      if (urlChanged) {
        slot.url = url;
        if (!slot.video.paused) slot.video.pause();
        slot.video.src = url;
        slot.video.load();
      }
      changed.push(slot);
    }
    return changed;
  }

  /**
   * Position a slot's element at sourceSec once metadata is available
   * (preload warm-up: decode near the upcoming cut point).
   */
  positionWhenReady(slot: PoolSlot, sourceSec: number): void {
    const { video } = slot;
    const epoch = slot.epoch;
    const apply = () => {
      if (slot.epoch !== epoch) return; // reassigned meanwhile
      try {
        video.currentTime = sourceSec;
      } catch {
        // not seekable yet — the engine's tick will retry via drift correction
      }
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      apply();
    } else {
      video.addEventListener('loadedmetadata', apply, { once: true });
    }
  }

  pauseAll(): void {
    for (const slot of this.slots) {
      if (!slot.video.paused) slot.video.pause();
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.epoch++;
      const v = slot.video;
      v.pause();
      v.removeAttribute('src');
      v.load();
      slot.clipId = null;
      slot.assetId = null;
      slot.url = '';
    }
  }
}
