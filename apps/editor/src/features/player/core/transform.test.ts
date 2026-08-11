/**
 * Transform -> pixel math vs the NORMATIVE formulas of
 * docs/rendering-semantics.md §2. Every expectation below is hand-computed
 * from the §2.2–§2.4 formulas (fit=contain -> scale -> rotate around anchor
 * -> anchor to P), NOT from the implementation.
 */
import { describe, expect, it } from 'vitest';
import type { Transform } from '@videoedit/timeline-schema';
import {
  applyMat3,
  computePlacement,
  fitScale,
  screenToNdc,
  sourceToScreen,
  unitQuadToNdcMatrix,
} from './transform';
import { IDENTITY_TRANSFORM } from './testFixtures';

function place(srcW: number, srcH: number, compW: number, compH: number, t: Partial<Transform> = {}) {
  return computePlacement({
    srcW,
    srcH,
    compW,
    compH,
    transform: { ...IDENTITY_TRANSFORM, ...t },
  });
}

describe('fitScale (§2.2 fit=contain)', () => {
  it('landscape source into landscape comp: limited by width', () => {
    // min(1920/1280, 1080/720) = min(1.5, 1.5) = 1.5
    expect(fitScale(1280, 720, 1920, 1080)).toBe(1.5);
  });

  it('portrait source into landscape comp: limited by height (pillarbox)', () => {
    // min(1920/1080, 1080/1920) = min(1.777.., 0.5625) = 0.5625
    expect(fitScale(1080, 1920, 1920, 1080)).toBe(0.5625);
  });

  it('wide source into square comp: limited by width (letterbox)', () => {
    // min(200/100, 200/50) = 2
    expect(fitScale(100, 50, 200, 200)).toBe(2);
  });
});

describe('identity transform (scale=1 = FIT size, not natural pixels)', () => {
  it('maps a 1280x720 source exactly onto a 1920x1080 comp', () => {
    const p = place(1280, 720, 1920, 1080);
    // fitScale=1.5, w_d=1920, h_d=1080, P=(960,540), a=(960,540)
    expect(sourceToScreen(p, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(sourceToScreen(p, 1280, 720)).toEqual({ x: 1920, y: 1080 });
    expect(sourceToScreen(p, 640, 360)).toEqual({ x: 960, y: 540 });
  });

  it('pillarboxes a portrait 1080x1920 source centered in 1920x1080', () => {
    const p = place(1080, 1920, 1920, 1080);
    // fitScale=0.5625 -> w_d=607.5, h_d=1080; a=(303.75,540); P=(960,540)
    // top-left: (960-303.75, 540-540) = (656.25, 0)
    expect(sourceToScreen(p, 0, 0).x).toBeCloseTo(656.25, 6);
    expect(sourceToScreen(p, 0, 0).y).toBeCloseTo(0, 6);
    // source center lands on comp center
    expect(sourceToScreen(p, 540, 960).x).toBeCloseTo(960, 6);
    expect(sourceToScreen(p, 540, 960).y).toBeCloseTo(540, 6);
    // bottom-right: (960+303.75, 1080)
    expect(sourceToScreen(p, 1080, 1920).x).toBeCloseTo(1263.75, 6);
    expect(sourceToScreen(p, 1080, 1920).y).toBeCloseTo(1080, 6);
  });
});

describe('scale + normalized offset (§2.3 step 2 and 4)', () => {
  it('scale=0.5 with x=0.25, y=-0.25 on same-size source/comp', () => {
    // 1920x1080 src in 1920x1080 comp: fitScale=1, s=0.5, w_d=960, h_d=540
    // P = (960 + 0.25*1920, 540 - 0.25*1080) = (1440, 270); a=(480,270)
    const p = place(1920, 1080, 1920, 1080, { scale: 0.5, x: 0.25, y: -0.25 });
    expect(sourceToScreen(p, 0, 0)).toEqual({ x: 960, y: 0 });
    expect(sourceToScreen(p, 1920, 1080)).toEqual({ x: 1920, y: 540 });
    // anchor pixel (source center) sits exactly on P
    expect(sourceToScreen(p, 960, 540)).toEqual({ x: 1440, y: 270 });
  });

  it('x=0.5 puts the anchor half a comp-width right of center (1.0 = full width)', () => {
    const p = place(100, 100, 200, 200, { x: 0.5 });
    // P = (100 + 0.5*200, 100) = (200, 100); anchor=(center of 200x200 draw)
    expect(sourceToScreen(p, 50, 50)).toEqual({ x: 200, y: 100 });
  });
});

describe('rotation around the anchor (§2.3 step 3, positive = clockwise)', () => {
  it('rotates 90 deg around the center: 100x50 source fit into 200x200', () => {
    // fitScale=2 -> w_d=200, h_d=100; a=(100,50); P=(100,100); cos=0, sin=1
    const p = place(100, 50, 200, 200, { rotationDeg: 90 });
    // source top-left (0,0): rel=(-100,-50) -> rotated (50,-100) -> (150, 0)
    expect(sourceToScreen(p, 0, 0).x).toBeCloseTo(150, 6);
    expect(sourceToScreen(p, 0, 0).y).toBeCloseTo(0, 6);
    // center stays put
    expect(sourceToScreen(p, 50, 25).x).toBeCloseTo(100, 6);
    expect(sourceToScreen(p, 50, 25).y).toBeCloseTo(100, 6);
    // bottom-right (100,50): rel=(100,50) -> rotated (-50,100) -> (50, 200)
    expect(sourceToScreen(p, 100, 50).x).toBeCloseTo(50, 6);
    expect(sourceToScreen(p, 100, 50).y).toBeCloseTo(200, 6);
  });

  it('rotates around a NON-center anchor (0,0): the anchor is the fixed point', () => {
    // 100x100 src in 200x200 comp: fitScale=2, w_d=h_d=200, a=(0,0), P=(100,100)
    const p = place(100, 100, 200, 200, { rotationDeg: 90, anchorX: 0, anchorY: 0 });
    // anchor pixel itself does not move
    expect(sourceToScreen(p, 0, 0).x).toBeCloseTo(100, 6);
    expect(sourceToScreen(p, 0, 0).y).toBeCloseTo(100, 6);
    // top-right (100,0): rel=(200,0) -> rotated cw (0,200) -> (100, 300)
    expect(sourceToScreen(p, 100, 0).x).toBeCloseTo(100, 6);
    expect(sourceToScreen(p, 100, 0).y).toBeCloseTo(300, 6);
  });

  it('rotation=180 flips around the anchor point', () => {
    const p = place(100, 100, 200, 200, { rotationDeg: 180 });
    // w_d=200, a=(100,100), P=(100,100): (0,0) -> rel(-100,-100) -> (100,100) rel -> (200,200)
    expect(sourceToScreen(p, 0, 0).x).toBeCloseTo(200, 6);
    expect(sourceToScreen(p, 0, 0).y).toBeCloseTo(200, 6);
  });
});

describe('screenToNdc (§2.4)', () => {
  it('maps comp corners and center to NDC', () => {
    expect(screenToNdc(1920, 1080, 0, 0)).toEqual({ x: -1, y: 1 });
    expect(screenToNdc(1920, 1080, 1920, 1080)).toEqual({ x: 1, y: -1 });
    expect(screenToNdc(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0 });
  });
});

describe('unitQuadToNdcMatrix (vertex shader input)', () => {
  const CASES: { name: string; srcW: number; srcH: number; t: Partial<Transform> }[] = [
    { name: 'identity', srcW: 1280, srcH: 720, t: {} },
    { name: 'scaled+offset', srcW: 1920, srcH: 1080, t: { scale: 0.5, x: 0.25, y: -0.25 } },
    {
      name: 'rotated around off-center anchor',
      srcW: 640,
      srcH: 360,
      t: { rotationDeg: 37, anchorX: 0.2, anchorY: 0.8, scale: 1.3, x: -0.1, y: 0.05 },
    },
  ];

  for (const { name, srcW, srcH, t } of CASES) {
    it(`matches the open pixel formula for every quad corner (${name})`, () => {
      const compW = 1920;
      const compH = 1080;
      const p = place(srcW, srcH, compW, compH, t);
      const m = unitQuadToNdcMatrix(p, srcW, srcH, compW, compH);
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.25, 0.75]]) {
        const viaMatrix = applyMat3(m, u!, v!);
        const px = sourceToScreen(p, u! * srcW, v! * srcH);
        const expected = screenToNdc(compW, compH, px.x, px.y);
        expect(viaMatrix.x).toBeCloseTo(expected.x, 5);
        expect(viaMatrix.y).toBeCloseTo(expected.y, 5);
      }
    });
  }

  it('identity fill: unit corners land exactly on the NDC corners', () => {
    const p = place(1280, 720, 1920, 1080);
    const m = unitQuadToNdcMatrix(p, 1280, 720, 1920, 1080);
    // (0,0) = source top-left -> screen (0,0) -> NDC (-1, +1)
    expect(applyMat3(m, 0, 0).x).toBeCloseTo(-1, 6);
    expect(applyMat3(m, 0, 0).y).toBeCloseTo(1, 6);
    expect(applyMat3(m, 1, 1).x).toBeCloseTo(1, 6);
    expect(applyMat3(m, 1, 1).y).toBeCloseTo(-1, 6);
  });
});

/**
 * Overlay rasters (rendering-semantics §7): the raster is produced at 2x its
 * project-space bbox and drawn at `bboxPx * scale`. `baseScale` REPLACES the
 * fit=contain factor; without it a 400x100 caption would be blown up to fill
 * the composition, which is what fit does to media.
 */
describe('baseScale override (§7 overlay rasters)', () => {
  const OVERLAY_BASE = 0.5; // 1 / rasterScale(2)

  it('draws the raster at bbox * scale, NOT at fit size', () => {
    // 800x200 raster = a 400x100 project-space bbox at 2x.
    const p = computePlacement({
      srcW: 800,
      srcH: 200,
      compW: 1920,
      compH: 1080,
      transform: { ...IDENTITY_TRANSFORM },
      baseScale: OVERLAY_BASE,
    });
    expect(p.s).toBe(0.5);
    expect(p.wDraw).toBe(400);
    expect(p.hDraw).toBe(100);
    // Fit would have been min(1920/800, 1080/200) = 2.4 -> 1920x480.
    expect(fitScale(800, 200, 1920, 1080)).toBe(2.4);
  });

  it('multiplies with transform.scale exactly like the fit factor does', () => {
    const p = computePlacement({
      srcW: 800,
      srcH: 200,
      compW: 1920,
      compH: 1080,
      transform: { ...IDENTITY_TRANSFORM, scale: 3 },
      baseScale: OVERLAY_BASE,
    });
    expect(p.wDraw).toBe(1200);
    expect(p.hDraw).toBe(300);
  });

  it('keeps the anchor on P and the quad centred (same §2.3 order)', () => {
    const p = computePlacement({
      srcW: 800,
      srcH: 200,
      compW: 1920,
      compH: 1080,
      transform: { ...IDENTITY_TRANSFORM, x: 0.25, y: -0.1 },
      baseScale: OVERLAY_BASE,
    });
    // P = (W/2 + x*W, H/2 + y*H)
    expect(p.px).toBe(1440);
    expect(p.py).toBe(432);
    const nw = sourceToScreen(p, 0, 0);
    const se = sourceToScreen(p, 800, 200);
    expect(nw).toEqual({ x: 1440 - 200, y: 432 - 50 });
    expect(se).toEqual({ x: 1440 + 200, y: 432 + 50 });
  });

  it('ignores a degenerate override and falls back to fit (never draws nothing)', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = computePlacement({
        srcW: 1280,
        srcH: 720,
        compW: 1920,
        compH: 1080,
        transform: { ...IDENTITY_TRANSFORM },
        baseScale: bad,
      });
      expect(p.s).toBe(1.5);
    }
  });
});
