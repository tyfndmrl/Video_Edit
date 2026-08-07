import { describe, expect, it } from 'vitest';
import { panScrollUs, panScrollY } from './pan';

describe('panScrollUs (orta tuşla yatay kaydırma)', () => {
  it('drag right shows earlier time (scrollUs decreases by the pixel delta)', () => {
    // 0.0001 px/us => 100 px = 1 000 000 us.
    expect(panScrollUs(5_000_000, 200, 300, 0.0001)).toBe(4_000_000);
  });

  it('drag left shows later time', () => {
    expect(panScrollUs(5_000_000, 300, 200, 0.0001)).toBe(6_000_000);
  });

  it('clamps at the timeline start', () => {
    expect(panScrollUs(500_000, 0, 400, 0.0001)).toBe(0);
  });

  it('no movement keeps the scroll exactly where it was', () => {
    expect(panScrollUs(1_234_567, 120, 120, 0.0001)).toBe(1_234_567);
  });

  it('is zoom relative: the same pixel delta pans less when zoomed in', () => {
    const zoomedOut = 5_000_000 - panScrollUs(5_000_000, 0, 100, 0.0001);
    const zoomedIn = 5_000_000 - panScrollUs(5_000_000, 0, 100, 0.001);
    expect(zoomedOut).toBe(1_000_000);
    expect(zoomedIn).toBe(100_000);
  });

  it('returns an integer µs value', () => {
    expect(Number.isInteger(panScrollUs(1_000_000, 0, 33, 0.0007))).toBe(true);
  });

  it('degrades safely on a non-positive/non-finite zoom', () => {
    expect(panScrollUs(2_000_000, 0, 100, 0)).toBe(2_000_000);
    expect(panScrollUs(2_000_000, 0, 100, Number.NaN)).toBe(2_000_000);
  });
});

describe('panScrollY (orta tuşla dikey kaydırma)', () => {
  it('drag down reveals the tracks above (scrollY decreases)', () => {
    expect(panScrollY(120, 400, 460, 500)).toBe(60);
  });

  it('drag up reveals the tracks below', () => {
    expect(panScrollY(120, 400, 340, 500)).toBe(180);
  });

  it('clamps into [0, maxScrollY]', () => {
    expect(panScrollY(10, 400, 600, 500)).toBe(0);
    expect(panScrollY(400, 400, 0, 500)).toBe(500);
  });

  it('stays at 0 when there is nothing to scroll', () => {
    expect(panScrollY(0, 400, 200, 0)).toBe(0);
    expect(panScrollY(0, 400, 200, -20)).toBe(0);
  });
});
