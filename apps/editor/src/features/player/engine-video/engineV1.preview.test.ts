/**
 * VideoPlaybackEngine — preview HONESTY tests (M4 audit wave 1):
 *
 * 1. A broken image URL must not vanish silently. The <img> error path exists,
 *    recovers through the same media-urls refresh as a <video> error, and is
 *    THROTTLED (renderFrame runs every rAF; an unthrottled retry would be a
 *    60 fps request storm against a dead URL).
 * 2. previewStatus$ reports AUDIO as well as picture. Audio clips share the
 *    finite element pool and live on the bottom tracks, so they are the first
 *    thing a crowded pool drops — reporting only visual layers let a music bed
 *    disappear in silence.
 *
 * Same harness as engineV1.seek.test.ts: node environment, Compositor/AudioGraph
 * module-mocked, real VideoPool on fake <video> elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset, PreviewStatus } from '../engine';
import { forceRefreshMediaUrls } from '../mediaUrls';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

interface RenderedItem {
  srcW: number;
  srcH: number;
}

const harness = vi.hoisted(() => ({
  /** Items handed to Compositor.render on the LAST frame. */
  lastRender: [] as RenderedItem[],
  deletedTextures: 0,
}));

vi.mock('../compositor/compositor', () => ({
  Compositor: class {
    resize(): void {}
    render(items: RenderedItem[]): void {
      harness.lastRender = items;
    }
    createTexture(): object {
      return {};
    }
    upload(): void {}
    deleteTexture(): void {
      harness.deletedTextures++;
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

/** Minimal HTMLImageElement stand-in — the test fires onload/onerror by hand. */
class FakeImage {
  crossOrigin = '';
  naturalWidth = 800;
  naturalHeight = 600;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';
  get src(): string {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
  }
}

const createdImages: FakeImage[] = [];
const rafCallbacks: Array<() => void> = [];

function stepFrame(): void {
  const cbs = [...rafCallbacks];
  rafCallbacks.length = 0;
  for (const cb of cbs) cb();
}

const g = globalThis as Record<string, unknown>;
g['document'] = { createElement: (): FakeVideoElement => new FakeVideoElement() };
g['HTMLMediaElement'] = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
g['Image'] = class extends FakeImage {
  constructor() {
    super();
    createdImages.push(this);
  }
};
g['requestAnimationFrame'] = (cb: () => void): number => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
g['cancelAnimationFrame'] = (): void => {};

import { VideoPlaybackEngine } from './engineV1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEC = 1_000_000;

let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  createdImages.length = 0;
  rafCallbacks.length = 0;
  harness.lastRender = [];
  harness.deletedTextures = 0;
  vi.mocked(forceRefreshMediaUrls).mockClear();
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

// ---------------------------------------------------------------------------
// 1. Image decode failures
// ---------------------------------------------------------------------------

describe('imageDrawItem media-error path', () => {
  const imageDoc = mkDoc([
    mkTrack('t0', [
      mkMediaClip({ id: 'img', assetId: 'A', kind: 'image', startUs: 0, durationUs: 10 * SEC, audio: null }),
    ]),
  ]);

  /** Resolver whose URL the test can swap (presign refresh simulation). */
  function urlResolver(get: () => string | null) {
    return (): PlayerAsset => ({ kind: 'image', url: get() });
  }

  it('a failed decode asks media-urls for a fresh presign (same path as <video>)', () => {
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => 'https://cdn/expired.png'));

    stepFrame();
    expect(createdImages, 'the engine must actually try to load the image').toHaveLength(1);
    expect(forceRefreshMediaUrls).not.toHaveBeenCalled();

    createdImages[0]!.onerror?.();
    expect(
      forceRefreshMediaUrls,
      'A dead image URL must trigger the SAME recovery as a dead video URL.',
    ).toHaveBeenCalledTimes(1);
  });

  it('retries are throttled — a dead URL cannot become a 60 fps request storm', () => {
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => 'https://cdn/expired.png'));

    stepFrame();
    createdImages[0]!.onerror?.();

    // Every rAF re-enters imageDrawItem; none of them may re-request.
    for (let i = 0; i < 30; i++) stepFrame();
    expect(createdImages, 'A failed image must not be re-requested every frame.').toHaveLength(1);

    // ...until the cooldown elapses.
    vi.advanceTimersByTime(5_000);
    stepFrame();
    expect(createdImages, 'After the cooldown the engine must try again.').toHaveLength(2);
    expect(harness.deletedTextures, 'The abandoned texture must be released.').toBeGreaterThan(0);
  });

  it('a refreshed URL retries IMMEDIATELY (no cooldown wait)', () => {
    let url = 'https://cdn/expired.png';
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => url));

    stepFrame();
    createdImages[0]!.onerror?.();
    stepFrame();
    expect(createdImages).toHaveLength(1); // still cooling down

    url = 'https://cdn/fresh.png'; // media-urls sync delivered a new presign
    stepFrame();
    expect(createdImages, 'A new URL is new information — retry at once.').toHaveLength(2);
    expect(createdImages[1]!.src).toBe('https://cdn/fresh.png');
  });

  it('the retry actually recovers: the image draws once it decodes', () => {
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => 'https://cdn/expired.png'));

    stepFrame();
    createdImages[0]!.onerror?.();
    stepFrame();
    expect(harness.lastRender, 'A failed image must not be drawn.').toHaveLength(0);

    vi.advanceTimersByTime(5_000);
    stepFrame();
    createdImages[1]!.onload?.();
    stepFrame();
    expect(harness.lastRender).toHaveLength(1);
    expect(harness.lastRender[0]).toMatchObject({ srcW: 800, srcH: 600 });
    expect(engine.getClipSourceSize('img')).toEqual({ width: 800, height: 600 });
  });

  it('a late callback from a superseded load cannot clobber the retry', () => {
    let url = 'https://cdn/expired.png';
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => url));

    stepFrame();
    const stale = createdImages[0]!;
    stale.onerror?.();
    url = 'https://cdn/fresh.png';
    stepFrame(); // retry with the fresh URL replaces the entry

    // The old request finally completes — with different pixels.
    stale.naturalWidth = 4;
    stale.naturalHeight = 4;
    stale.onload?.();
    stepFrame();
    expect(
      harness.lastRender,
      'The stale load owns no entry any more; it must draw nothing.',
    ).toHaveLength(0);

    createdImages[1]!.onload?.();
    stepFrame();
    expect(harness.lastRender[0]).toMatchObject({ srcW: 800, srcH: 600 });
  });

  it('no URL at all is not an error state (asset still uploading)', () => {
    const engine = makeEngine();
    engine.load(imageDoc, urlResolver(() => null));
    stepFrame();
    expect(createdImages).toHaveLength(0);
    expect(forceRefreshMediaUrls).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. previewStatus$ covers sound
// ---------------------------------------------------------------------------

describe('previewStatus$ (engine contract: a dropped layer MUST be reported)', () => {
  /** 4 video tracks + one music track at the BOTTOM — 5 clips, 4 slots. */
  const crowdedDoc = mkDoc([
    ...Array.from({ length: 4 }, (_, i) =>
      mkTrack(`v${i}`, [
        mkMediaClip({ id: `c${i}`, assetId: `A${i}`, startUs: 0, durationUs: 10 * SEC }),
      ]),
    ),
    mkTrack('m', [mkMediaClip({ id: 'music', assetId: 'M', kind: 'audio', startUs: 0, durationUs: 10 * SEC })], {
      type: 'audio',
      name: 'Müzik',
    }),
  ]);

  it('reports the SILENCED music bed even though every picture is intact', () => {
    const engine = makeEngine();
    const seen: PreviewStatus[] = [];
    engine.previewStatus$.subscribe((s) => seen.push(s));
    engine.load(crowdedDoc, (): PlayerAsset => ({ kind: 'video', url: 'blob:x' }));

    stepFrame();

    const last = seen.at(-1);
    expect(last, 'previewStatus$ must emit when capacity is short.').toBeDefined();
    expect(last!.totalLayers).toBe(4);
    expect(last!.shownLayers).toBe(4);
    expect(last!.totalAudio, '4 video sound tracks + the music bed').toBe(5);
    expect(
      last!.shownAudio,
      'The pool holds 4 elements; the bottom-most clip (the music) loses.',
    ).toBe(4);
    expect(last!.dropped).toEqual(['Müzik']);
  });

  it('stays silent when everything fits (no note churn per frame)', () => {
    const engine = makeEngine();
    const seen: PreviewStatus[] = [];
    engine.previewStatus$.subscribe((s) => seen.push(s));
    engine.load(
      mkDoc([mkTrack('t', [mkMediaClip({ id: 'only', startUs: 0, durationUs: 10 * SEC })])]),
      (): PlayerAsset => ({ kind: 'video', url: 'blob:x' }),
    );

    for (let i = 0; i < 5; i++) stepFrame();
    expect(seen).toHaveLength(1); // the initial 0/0 -> 1/1 transition, then quiet
    expect(seen[0]).toMatchObject({ totalLayers: 1, shownLayers: 1, totalAudio: 1, shownAudio: 1 });
    expect(seen[0]!.dropped).toEqual([]);
  });
});
