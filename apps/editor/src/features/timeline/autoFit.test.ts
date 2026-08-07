import { describe, expect, it } from 'vitest';
import { autoFitSettled, decideAutoFit, type AutoFitInput } from './autoFit';
import { MAX_PX_PER_US, timeToX } from './geometry';

const US = 1_000_000;

function input(over: Partial<AutoFitInput> = {}): AutoFitInput {
  return {
    sessionStatus: 'ready',
    contentEndUs: 60 * US,
    viewportWidthPx: 900,
    alreadyApplied: false,
    ...over,
  };
}

describe('decideAutoFit', () => {
  it('fits the view to the content when a project becomes ready', () => {
    const decision = decideAutoFit(input());
    expect(decision.kind).toBe('fit');
    if (decision.kind !== 'fit') return;
    expect(decision.scrollUs).toBe(0);
    expect(decision.pxPerUs).toBeGreaterThan(0);
  });

  it('REGRESSION: 60 s of content is visible instead of parked at x≈6000px', () => {
    // Varsayılan zoom (0.0001) ile 60. saniye x=6000px'te kalıyordu: kullanıcı
    // boş bir timeline görüyor ve "hiçbir şey çalışmıyor" sanıyordu.
    const contentEndUs = 60 * US;
    const widthPx = 900;
    expect(timeToX(contentEndUs, 0, 0.0001)).toBe(6000); // eski davranış

    const decision = decideAutoFit(input({ contentEndUs, viewportWidthPx: widthPx }));
    expect(decision.kind).toBe('fit');
    if (decision.kind !== 'fit') return;
    expect(timeToX(contentEndUs, decision.scrollUs, decision.pxPerUs)).toBeLessThanOrEqual(widthPx);
  });

  it('never overwrites the user zoom: applies at most once per project session', () => {
    const first = decideAutoFit(input());
    expect(autoFitSettled(first)).toBe(true);
    // Kullanıcı zoom'ladıktan sonra doküman değişse bile tekrar sığdırma yok.
    const second = decideAutoFit(input({ alreadyApplied: true, contentEndUs: 120 * US }));
    expect(second.kind).toBe('skip');
    expect(autoFitSettled(second)).toBe(false);
  });

  it('waits for the first canvas measurement instead of guessing a width', () => {
    const decision = decideAutoFit(input({ viewportWidthPx: 0 }));
    expect(decision.kind).toBe('wait');
    // 'wait' işi bitirmez: ölçüm gelince tekrar sorulur ve o zaman sığdırılır.
    expect(autoFitSettled(decision)).toBe(false);
    expect(decideAutoFit(input({ viewportWidthPx: 1200 })).kind).toBe('fit');
  });

  it('keeps the default zoom for an empty project (and stops retrying)', () => {
    const decision = decideAutoFit(input({ contentEndUs: 0 }));
    expect(decision.kind).toBe('keep-default');
    expect(autoFitSettled(decision)).toBe(true);
  });

  it('does nothing while the session is not ready', () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      const decision = decideAutoFit(input({ sessionStatus: status }));
      expect(decision.kind).toBe('skip');
      expect(autoFitSettled(decision)).toBe(false);
    }
  });

  it('clamps the zoom for very short content', () => {
    const decision = decideAutoFit(input({ contentEndUs: 1000, viewportWidthPx: 900 }));
    expect(decision.kind).toBe('fit');
    if (decision.kind !== 'fit') return;
    expect(decision.pxPerUs).toBeLessThanOrEqual(MAX_PX_PER_US);
  });
});
