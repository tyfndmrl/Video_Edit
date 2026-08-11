import { describe, expect, it } from 'vitest';
import { clampScrollUs, maxPanScrollUs, PAN_TAIL_FRACTION, panScrollUs, panScrollY } from './pan';

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

/**
 * Denetim bulgusu 5 (bu dilimin kök nedeni): yatay pan'in ÜST sınırı yoktu.
 * Ölçülen davranış: 6 orta-tuş sürüklemesinde scrollUs 0 -> 486 975 648 µs,
 * içerik sonu 82 000 000 µs — yani tek jestle "boş timeline".
 */
describe('maxPanScrollUs (yatay kaydırmanın üst sınırı)', () => {
  // 800 px / 0.0001 pxPerUs = 8 000 000 µs (8 s) görünür aralık.
  const W = 800;
  const ZOOM = 0.0001;
  const VIEWPORT_US = W / ZOOM;

  it('leaves the content end inside the viewport (plus a small tail)', () => {
    const contentEndUs = 82_000_000;
    const max = maxPanScrollUs(contentEndUs, W, ZOOM);
    expect(max).toBe(
      Math.round(contentEndUs - VIEWPORT_US + VIEWPORT_US * PAN_TAIL_FRACTION),
    );
    // En uçta bile içerik sonu görünür alanın içinde kalır.
    const endXpx = (contentEndUs - max) * ZOOM;
    expect(endXpx).toBeGreaterThan(0);
    expect(endXpx).toBeLessThanOrEqual(W);
  });

  it('is only the tail margin when the content fits in the viewport', () => {
    // 3 s içerik, 8 s görünür alan -> kaydıracak bir şey yok, yalnız kuyruk payı.
    expect(maxPanScrollUs(3_000_000, W, ZOOM)).toBe(Math.round(VIEWPORT_US * PAN_TAIL_FRACTION));
  });

  it('is the tail margin for an empty project (contentEnd = 0)', () => {
    expect(maxPanScrollUs(0, W, ZOOM)).toBe(Math.round(VIEWPORT_US * PAN_TAIL_FRACTION));
  });

  it('shrinks as you zoom in (less time visible -> more room to scroll)', () => {
    const zoomedOut = maxPanScrollUs(82_000_000, W, ZOOM);
    const zoomedIn = maxPanScrollUs(82_000_000, W, ZOOM * 10);
    expect(zoomedIn).toBeGreaterThan(zoomedOut);
  });

  it('degrades to 0 on a non-positive/non-finite zoom or width', () => {
    expect(maxPanScrollUs(82_000_000, W, 0)).toBe(0);
    expect(maxPanScrollUs(82_000_000, W, Number.NaN)).toBe(0);
    expect(maxPanScrollUs(82_000_000, 0, ZOOM)).toBe(0);
  });
});

describe('clampScrollUs', () => {
  it('clamps into [0, max]', () => {
    expect(clampScrollUs(-5, 1000)).toBe(0);
    expect(clampScrollUs(500, 1000)).toBe(500);
    expect(clampScrollUs(5000, 1000)).toBe(1000);
  });

  it('treats a negative/NaN limit as 0 and never returns NaN', () => {
    expect(clampScrollUs(500, -10)).toBe(0);
    expect(clampScrollUs(Number.NaN, 1000)).toBe(0);
  });

  it('returns integers', () => {
    expect(clampScrollUs(123.6, 1000)).toBe(124);
  });
});

describe('panScrollUs — üst sınır', () => {
  const W = 800;
  const ZOOM = 0.0001;
  const CONTENT_END = 82_000_000;

  it('never scrolls past the content end however far the drag goes', () => {
    const max = maxPanScrollUs(CONTENT_END, W, ZOOM);
    // Sola doğru 100 000 px'lik (uçuk) bir sürükleme.
    expect(panScrollUs(0, 100_000, 0, ZOOM, max)).toBe(max);
    // Sınır aşılmadığı sürece normal davranış korunur.
    expect(panScrollUs(0, 100, 0, ZOOM, max)).toBe(1_000_000);
  });

  it('the content end stays on screen after repeated drags (regression)', () => {
    const max = maxPanScrollUs(CONTENT_END, W, ZOOM);
    let scroll = 0;
    // Denetimde ölçülen jest dizisi: art arda 6 sola sürükleme. Sınırsızken
    // scrollUs 486 975 648 µs'ye çıkıyor (içerik sonu 82 000 000 µs) ve ekran
    // boşalıyordu.
    for (let i = 0; i < 6; i++) {
      scroll = panScrollUs(scroll, 2100, 100, ZOOM, max);
    }
    expect(scroll).toBe(max);
    expect(scroll).toBeLessThan(CONTENT_END);

    // Son klibin sonu (82 s) hâlâ görünür alanın İÇİNDE — ekran asla boşalmaz.
    const endXpx = (CONTENT_END - scroll) * ZOOM;
    expect(endXpx).toBeGreaterThan(0);
    expect(endXpx).toBeLessThanOrEqual(W);
  });

  it('a mid-way drag is not clamped (content end is still to the right)', () => {
    const max = maxPanScrollUs(CONTENT_END, W, ZOOM);
    const scroll = panScrollUs(0, 700, 100, ZOOM, max);
    expect(scroll).toBe(6_000_000);
    expect(scroll).toBeLessThan(max);
    expect((CONTENT_END - scroll) * ZOOM).toBeGreaterThan(W); // içerik sağa taşıyor
  });

  it('is unbounded when no limit is given (default parameter)', () => {
    expect(panScrollUs(0, 100_000, 0, ZOOM)).toBe(1_000_000_000);
  });

  it('clamps the degraded (invalid zoom) path too', () => {
    expect(panScrollUs(9_000_000, 0, 100, 0, 1_000_000)).toBe(1_000_000);
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
