/**
 * Canvas hit-testing — rect list produced during drawing, queried on pointer
 * events (design 01 §3.1: no DOM, so we own hit-testing).
 * Coordinates are CONTENT space: x relative to the canvas left edge, y in
 * track-content space (vertical scroll already removed).
 */
import type { Uuid } from '@videoedit/timeline-schema';

export type HitRegion = 'body' | 'trimL' | 'trimR';

export interface ClipHitRect {
  clipId: Uuid;
  trackId: Uuid;
  trackIndex: number;
  region: HitRegion;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Topmost hit wins: rects are pushed in draw order, so scan from the end. */
export function hitTestClips(
  rects: readonly ClipHitRect[],
  x: number,
  y: number,
): ClipHitRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}
