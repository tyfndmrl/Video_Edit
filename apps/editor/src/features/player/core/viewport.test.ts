/**
 * Screen <-> composition mapping. Every expectation is hand-computed from the
 * "contain" definition (rendering-semantics §2.2 applied to the VIEWPORT, not
 * to the clip): scale = min(rectW/W, rectH/H), the composition is centred, the
 * leftover is letterbox/pillarbox.
 */
import { describe, expect, it } from 'vitest';
import { compToScreen, fitViewport, screenLenToComp, screenToComp } from './viewport';

const COMP_W = 1920;
const COMP_H = 1080;

describe('fitViewport', () => {
  it('exact aspect match: uniform scale, no bars', () => {
    // min(960/1920, 540/1080) = min(0.5, 0.5) = 0.5 ; leftover 0 on both axes
    const m = fitViewport(COMP_W, COMP_H, { left: 100, top: 50, width: 960, height: 540 });
    expect(m).toEqual({ scale: 0.5, offsetX: 100, offsetY: 50 });
  });

  it('taller viewport: letterbox bars top/bottom', () => {
    // min(960/1920, 1080/1080) = 0.5 -> drawn 960x540 inside a 960x1080 box
    // vertical leftover 540 -> 270 px per bar
    const m = fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 960, height: 1080 });
    expect(m).toEqual({ scale: 0.5, offsetX: 0, offsetY: 270 });
  });

  it('wider viewport: pillarbox bars left/right', () => {
    // min(1920/1920, 540/1080) = 0.5 -> drawn 960x540 inside 1920x540:
    // the HEIGHT is the binding constraint, so the leftover is horizontal
    // (1920 - 960 = 960 -> 480 px per bar) and there is no vertical bar.
    const m = fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 1920, height: 540 });
    expect(m).toEqual({ scale: 0.5, offsetX: 480, offsetY: 0 });
  });

  it('rect origin is carried into the offsets (panel is not at 0,0)', () => {
    const m = fitViewport(COMP_W, COMP_H, { left: 37, top: 11, width: 1920, height: 540 });
    expect(m.offsetX).toBe(37 + 480);
    expect(m.offsetY).toBe(11);
  });

  it('degenerate inputs report scale 0 (caller skips interaction)', () => {
    expect(fitViewport(0, 1080, { left: 0, top: 0, width: 960, height: 540 }).scale).toBe(0);
    expect(fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 0, height: 540 }).scale).toBe(0);
    const nan = screenToComp(fitViewport(0, 0, { left: 0, top: 0, width: 0, height: 0 }), {
      x: 5,
      y: 5,
    });
    expect(Number.isNaN(nan.x)).toBe(true);
  });
});

describe('compToScreen / screenToComp', () => {
  it('maps the composition centre to the viewport centre (letterboxed)', () => {
    const rect = { left: 10, top: 20, width: 960, height: 1080 };
    const m = fitViewport(COMP_W, COMP_H, rect);
    expect(compToScreen(m, { x: COMP_W / 2, y: COMP_H / 2 })).toEqual({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  });

  it('maps composition corners onto the drawn image corners', () => {
    const m = fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 1920, height: 540 });
    expect(compToScreen(m, { x: 0, y: 0 })).toEqual({ x: 480, y: 0 });
    expect(compToScreen(m, { x: COMP_W, y: COMP_H })).toEqual({ x: 1440, y: 540 });
  });

  it('screenToComp is the exact inverse (round trip, letterboxed viewport)', () => {
    const m = fitViewport(COMP_W, COMP_H, { left: 137, top: 42, width: 811, height: 1234 });
    for (const p of [
      { x: 0, y: 0 },
      { x: 1920, y: 1080 },
      { x: 640.25, y: 371.5 },
      { x: -300, y: 2000 }, // outside the composition — still linear
    ]) {
      const back = screenToComp(m, compToScreen(m, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('a screen delta converts to a composition delta by the same scale', () => {
    const m = fitViewport(COMP_W, COMP_H, { left: 0, top: 0, width: 960, height: 540 });
    expect(screenLenToComp(m, 11)).toBe(22); // scale 0.5 -> 1 screen px = 2 comp px
  });
});
