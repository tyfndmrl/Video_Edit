/**
 * Speed badge label (M5). The pill itself is canvas pixels, but WHEN it shows
 * and WHAT it says are rules — and both are load-bearing: a badge on every clip
 * carries no information, and a missing badge on a re-timed clip makes the
 * block length silently lie about its content.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, MediaClip, ShapeClip } from '@videoedit/timeline-schema';
import { drawSpeedBadge, speedBadgeLabel, SPEED_BADGE_MIN_CLIP_W } from './speedBadge';

function mediaClip(rate: number): MediaClip {
  return {
    id: 'c1',
    kind: 'video',
    assetId: 'a1',
    timelineStartUs: 0,
    timelineDurationUs: 1_000_000,
    sourceInUs: 0,
    sourceOutUs: Math.round(1_000_000 * rate),
    speed: { rate },
    audio: null,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

const shapeClip: ShapeClip = {
  id: 's1',
  kind: 'shape',
  timelineStartUs: 0,
  timelineDurationUs: 1_000_000,
  shape: { type: 'rect', fill: '#ffffff' },
  transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
  keyframes: {},
  effects: [],
  opacity: 1,
};

describe('speedBadgeLabel', () => {
  it('says nothing at native speed (a badge on every clip is no badge)', () => {
    expect(speedBadgeLabel(mediaClip(1))).toBeNull();
  });

  it('drops trailing zeros so presets read as "2x" / "0.5x"', () => {
    expect(speedBadgeLabel(mediaClip(2))).toBe('2x');
    expect(speedBadgeLabel(mediaClip(0.5))).toBe('0.5x');
    expect(speedBadgeLabel(mediaClip(0.25))).toBe('0.25x');
    expect(speedBadgeLabel(mediaClip(1.25))).toBe('1.25x');
  });

  it('shows the STORED precision (3 decimals) for a free-typed rate', () => {
    expect(speedBadgeLabel(mediaClip(1.235))).toBe('1.235x');
  });

  it('non-media clips have no speed at all', () => {
    expect(speedBadgeLabel(shapeClip as Clip)).toBeNull();
  });

  it('a corrupt rate never paints a broken pill', () => {
    expect(speedBadgeLabel(mediaClip(Number.NaN))).toBeNull();
    expect(speedBadgeLabel(mediaClip(0))).toBeNull();
  });
});

/**
 * The width gate has already cost one real red: a FITTED timeline draws a 3 s
 * clip at ~25 px, and a threshold tuned for wide clips silently dropped the
 * badge exactly where it matters most. Pinned here so it cannot drift back.
 */
describe('drawSpeedBadge width gate', () => {
  /** Minimal Canvas2D stand-in: 6 px per character is close enough to 9px UI. */
  function fakeCtx(): CanvasRenderingContext2D & { fills: number } {
    const ctx = {
      fills: 0,
      font: '',
      textBaseline: '' as CanvasTextBaseline,
      fillStyle: '' as string,
      save: () => undefined,
      restore: () => undefined,
      measureText: (t: string) => ({ width: t.length * 6 }) as TextMetrics,
      beginPath: () => undefined,
      moveTo: () => undefined,
      arcTo: () => undefined,
      closePath: () => undefined,
      fill: () => {
        ctx.fills++;
      },
      fillText: () => undefined,
    };
    return ctx as unknown as CanvasRenderingContext2D & { fills: number };
  }

  it('draws on a clip as narrow as a FITTED 3 s block (~25 px)', () => {
    const ctx = fakeCtx();
    const width = drawSpeedBadge(ctx, mediaClip(2), 0, 0, 26, 15);
    expect(width, 'the badge must survive a fitted timeline').toBeGreaterThan(0);
    expect(ctx.fills).toBe(1);
  });

  it('gives up when the pill would not fit inside the clip at all', () => {
    const ctx = fakeCtx();
    expect(drawSpeedBadge(ctx, mediaClip(2), 0, 0, SPEED_BADGE_MIN_CLIP_W - 1, 15)).toBe(0);
    expect(drawSpeedBadge(ctx, mediaClip(1.235), 0, 0, 26, 15), 'a long label needs room').toBe(0);
    expect(ctx.fills, 'nothing may be painted when the gate refuses').toBe(0);
  });

  it('draws nothing at native speed, whatever the width', () => {
    const ctx = fakeCtx();
    expect(drawSpeedBadge(ctx, mediaClip(1), 0, 0, 500, 15)).toBe(0);
    expect(ctx.fills).toBe(0);
  });
});
