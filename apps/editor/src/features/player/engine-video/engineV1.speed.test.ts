/**
 * VideoPlaybackEngine — SPEED preview (M5).
 *
 * The whole point of the speed feature is that the preview and the export
 * agree. Three things have to hold, and none of them is visible from the
 * document:
 *
 * 1. the element really runs at `clip.speed.rate * transportRate` and is
 *    positioned with the §1 source-time mapping (`sourceIn + (t-start)*rate`);
 * 2. the audio keeps its PITCH — the export time-stretches with `atempo`
 *    (§8.3), so a preview that pitch-shifts would be a different edit;
 * 3. when the product of the two rates leaves the element's portable range
 *    [0.0625, 16] it is CLAMPED, and the user is told (previewRate$) instead
 *    of watching a preview that silently disagrees with the document.
 *
 * Same harness as engineV1.preview.test.ts: node environment, Compositor and
 * AudioGraph module-mocked, the real VideoPool driving fake <video> elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset, PreviewRateStatus } from '../engine';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('../compositor/compositor', () => ({
  Compositor: class {
    resize(): void {}
    render(): void {}
    createTexture(): object {
      return {};
    }
    upload(): void {}
    deleteTexture(): void {}
    readPixel(): null {
      return null;
    }
    dispose(): void {}
  },
}));

vi.mock('../audio/audioGraph', () => ({
  AudioGraph: class {
    context = null;
    setSampleRate(): void {}
    nowSec(): number | null {
      return null;
    }
    attachElement(): void {}
    ensureContext(): Promise<void> {
      return new Promise<void>(() => {});
    }
    setElementGain(): void {}
    setElementGainCurve(): void {}
    cancelElement(): void {}
    readMeter(): null {
      return null; // meter tap is a real-AudioContext concern; engine tests stub it
    }
    dispose(): void {}
  },
}));

vi.mock('../mediaUrls', () => ({
  forceRefreshMediaUrls: vi.fn(),
}));

// ---------------------------------------------------------------------------
// DOM stubs (node environment)
// ---------------------------------------------------------------------------

class FakeVideoElement {
  currentTime = 0;
  readyState = 4;
  paused = true;
  videoWidth = 640;
  videoHeight = 360;
  playbackRate = 1;
  /** Present so setPreservesPitch's `in` check finds it, like a real element. */
  preservesPitch = false;
  src = '';
  crossOrigin = '';
  preload = '';
  playsInline = false;
  muted = false;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  requestVideoFrameCallback(): number {
    return 0;
  }
  cancelVideoFrameCallback(): void {}
}

const createdVideos: FakeVideoElement[] = [];
const rafCallbacks: Array<() => void> = [];

function stepFrame(): void {
  const cbs = [...rafCallbacks];
  rafCallbacks.length = 0;
  for (const cb of cbs) cb();
}

const g = globalThis as Record<string, unknown>;
g['document'] = {
  createElement: (): FakeVideoElement => {
    const el = new FakeVideoElement();
    createdVideos.push(el);
    return el;
  },
};
g['HTMLMediaElement'] = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
g['Image'] = class {};
g['requestAnimationFrame'] = (cb: () => void): number => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
g['cancelAnimationFrame'] = (): void => {};

import { VideoPlaybackEngine } from './engineV1';

const SEC = 1_000_000;
let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

const videoAsset = (): PlayerAsset => ({ kind: 'video', url: 'blob:x' });

/** One video clip on the timeline at `rate`, source [0 .. 20 s). */
function speedDoc(rate: number) {
  return mkDoc([
    mkTrack('t0', [
      mkMediaClip({
        id: 'c1',
        assetId: 'A',
        startUs: 0,
        durationUs: Math.round((20 * SEC) / rate),
        sourceInUs: 0,
        sourceOutUs: 20 * SEC,
        rate,
      }),
    ]),
  ]);
}

/** The pool element that ended up carrying clip c1. */
function activeVideo(engine: VideoPlaybackEngine): FakeVideoElement {
  const slot = engine['pool'].slotForClip('c1');
  expect(slot, 'the clip must own a pool slot').not.toBeNull();
  return slot!.video as unknown as FakeVideoElement;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  createdVideos.length = 0;
  rafCallbacks.length = 0;
  useEditorStore.getState().setIsPlaying(false);
  useDocStore
    .getState()
    .loadDoc(createEmptyDoc('00000000-0000-0000-0000-000000000000', defaultProjectSettings));
});

afterEach(() => {
  for (const e of engines) e.dispose();
  engines = [];
  vi.useRealTimers();
});

describe('clip speed reaches the element (design §4.2, rendering-semantics §1)', () => {
  it('a 2x clip plays its element at 2x', () => {
    const engine = makeEngine();
    engine.load(speedDoc(2), videoAsset);
    engine.play();

    expect(activeVideo(engine).playbackRate).toBe(2);
  });

  it('a 0.5x clip plays its element at 0.5x', () => {
    const engine = makeEngine();
    engine.load(speedDoc(0.5), videoAsset);
    engine.play();

    expect(activeVideo(engine).playbackRate).toBe(0.5);
  });

  it('the transport rate MULTIPLIES the clip rate (shuttle over a fast clip)', () => {
    const engine = makeEngine();
    engine.load(speedDoc(2), videoAsset);
    engine.setPlaybackRate(4);
    engine.play();

    expect(activeVideo(engine).playbackRate).toBe(8);
  });

  it('the element is positioned with the §1 source mapping, not the timeline time', () => {
    const engine = makeEngine();
    engine.load(speedDoc(2), videoAsset);
    // Timeline 3 s into a 2x clip = 6 s of SOURCE.
    void engine.seek(3 * SEC, { precise: false });
    vi.advanceTimersByTime(200);
    engine.play();

    expect(activeVideo(engine).currentTime).toBeCloseTo(6, 3);
  });

  it('asks the element to PRESERVE PITCH (export uses atempo — §8.3)', () => {
    makeEngine();
    expect(createdVideos.length, 'the pool creates its elements up front').toBeGreaterThan(0);
    for (const el of createdVideos) {
      expect(el.preservesPitch, 'a pitch-shifted preview is a different edit').toBe(true);
    }
  });
});

describe('previewRate$ — the browser rate limit is never silent', () => {
  it('stays quiet while the effective rate is inside [0.0625, 16]', () => {
    const engine = makeEngine();
    const seen: PreviewRateStatus[] = [];
    engine.previewRate$.subscribe((s) => seen.push(s));
    engine.load(speedDoc(10), videoAsset);
    engine.play();
    stepFrame();

    expect(activeVideo(engine).playbackRate).toBe(10);
    expect(seen.filter((s) => s.limited)).toHaveLength(0);
  });

  it('reports the clamp when clip speed x transport rate leaves the range', () => {
    const engine = makeEngine();
    const seen: PreviewRateStatus[] = [];
    engine.previewRate$.subscribe((s) => seen.push(s));
    engine.load(speedDoc(10), videoAsset);
    engine.setPlaybackRate(8); // 10 x 8 = 80, way past the element's 16x
    engine.play();

    expect(activeVideo(engine).playbackRate, 'the element gets the clamped rate').toBe(16);
    const limited = seen.filter((s) => s.limited);
    expect(limited.length, 'a clamped preview MUST be reported').toBeGreaterThan(0);
    expect(limited.at(-1)).toEqual({ limited: true, requested: 80, applied: 16 });
  });

  it('emits only on CHANGE (no note churn per frame)', () => {
    const engine = makeEngine();
    const seen: PreviewRateStatus[] = [];
    engine.previewRate$.subscribe((s) => seen.push(s));
    engine.load(speedDoc(10), videoAsset);
    engine.setPlaybackRate(8);
    engine.play();
    for (let i = 0; i < 5; i++) stepFrame();

    expect(seen).toHaveLength(1);
  });

  it('clears on pause — a note left on screen would describe nothing', () => {
    const engine = makeEngine();
    const seen: PreviewRateStatus[] = [];
    engine.previewRate$.subscribe((s) => seen.push(s));
    engine.load(speedDoc(10), videoAsset);
    engine.setPlaybackRate(8);
    engine.play();
    engine.pause();

    expect(seen.at(-1)!.limited).toBe(false);
  });
});
