/**
 * Shape geometry — the preview's half of a CROSS-SLICE contract.
 *
 * The export rasterizes shapes with `backend/src/VideoEdit.Media/Text/
 * ShapeGeometry.cs`. Every expectation below is derived from THAT file's
 * documented rules, not from this implementation; if the two drift, a shape
 * looks one size in the preview and another in the export — the exact class of
 * bug rendering-semantics exists to prevent. (This mismatch was real: the first
 * version of the preview used a half-frame box while the export used the full
 * frame, i.e. every shape would have exported at double size.)
 */
import { describe, expect, it } from 'vitest';
import type { ShapeClip } from '@videoedit/timeline-schema';
import { defaultProjectSettings } from '../../state/docStore';
import { shapeBoxPx } from './overlayGeometry';
import {
  ARROW_HEAD_HALF_WIDTH_FACTOR,
  ARROW_HEAD_LENGTH_FACTOR,
  computeShapeGeometry,
  insetBox,
  MIN_LINE_THICKNESS_PX,
} from './shapeGeometry';

const W = 1920;
const H = 1080;

function shape(patch: Partial<ShapeClip['shape']> = {}): ShapeClip['shape'] {
  return { type: 'rect', fill: '#5a8cff', ...patch };
}

describe('shapeBoxPx (natural box = the project frame)', () => {
  it('is the composition, so scale=1 is a full-frame shape', () => {
    expect(shapeBoxPx({ width: W, height: H })).toEqual({ width: W, height: H });
    expect(shapeBoxPx(defaultProjectSettings)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('computeShapeGeometry (mirror of ShapeGeometry.Compute)', () => {
  it('clamps the corner radius to half the SHORT edge', () => {
    expect(computeShapeGeometry(shape({ radiusPx: 99_999 }), W, H).cornerRadiusPx).toBe(H / 2);
    expect(computeShapeGeometry(shape({ radiusPx: 32 }), W, H).cornerRadiusPx).toBe(32);
    expect(computeShapeGeometry(shape({ radiusPx: -5 }), W, H).cornerRadiusPx).toBe(0);
  });

  it('never lets the stroke overflow the box (an inverted inset box draws nothing)', () => {
    const g = computeShapeGeometry(shape({ stroke: { color: '#fff', widthPx: 99_999 } }), W, H);
    expect(g.strokeWidthPx).toBe(Math.min(W, H));
    const box = insetBox(g);
    expect(box.right - box.left).toBeGreaterThanOrEqual(0);
  });

  it('insets rect/ellipse by HALF the stroke so the stroke stays inside the bbox', () => {
    const g = computeShapeGeometry(shape({ stroke: { color: '#fff', widthPx: 40 } }), W, H);
    expect(insetBox(g)).toEqual({ left: 20, top: 20, right: W - 20, bottom: H - 20 });
  });

  it('falls back to 1 % of the short edge (min 2 px) for a line without a stroke', () => {
    expect(computeShapeGeometry(shape({ type: 'line' }), W, H).lineThicknessPx).toBe(
      Math.round(H * 0.01),
    );
    // Tiny composition: the floor wins.
    expect(computeShapeGeometry(shape({ type: 'line' }), 40, 20).lineThicknessPx).toBe(
      MIN_LINE_THICKNESS_PX,
    );
  });

  it('sizes the arrow head from the thickness and keeps it inside the frame', () => {
    const g = computeShapeGeometry(
      shape({ type: 'arrow', stroke: { color: '#fff', widthPx: 20 } }),
      W,
      H,
    );
    expect(g.lineThicknessPx).toBe(20);
    expect(g.arrowHeadLengthPx).toBe(20 * ARROW_HEAD_LENGTH_FACTOR);
    expect(g.arrowHeadHalfWidthPx).toBe(20 * ARROW_HEAD_HALF_WIDTH_FACTOR);

    // A monstrous stroke: the head is capped by the frame (half-width <= H/2,
    // length <= W/3) instead of drawing outside the raster.
    const huge = computeShapeGeometry(
      shape({ type: 'arrow', stroke: { color: '#fff', widthPx: 900 } }),
      W,
      H,
    );
    expect(huge.arrowHeadHalfWidthPx).toBeLessThanOrEqual(H / 2);
    expect(huge.arrowHeadLengthPx).toBeLessThanOrEqual(W / 3);
  });

  it('survives a degenerate composition without producing NaN', () => {
    const g = computeShapeGeometry(shape({ type: 'arrow' }), 0, 0);
    for (const value of Object.values(g)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    expect(g.boxWidthPx).toBeGreaterThan(0);
  });
});
