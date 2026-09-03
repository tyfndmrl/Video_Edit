/**
 * VideoPlaybackEngine — TRANSITION preview (M4 wave 2).
 *
 * The bug this file locks down: `resolveVisualStack` used to return ONE clip
 * per track, so the preview showed a hard cut while the export produced a
 * crossfade — a silent divergence between what the user approves and what they
 * get. rendering-semantics §5.3 says the preview applies the SAME window
 * ([T-D/2, T+D/2], linear p), and §5.4 says the sound crosses with it.
 *
 * Four things have to hold, none of them visible from the document:
 *  1. inside the window the compositor receives ONE transition item carrying
 *     BOTH sides and the progress (not two independent draws, not one clip);
 *  2. both <video> elements stay alive and are positioned on HANDLE material
 *     (source time outside [sourceIn, sourceOut]) — otherwise one side of every
 *     crossfade is a frozen frame;
 *  3. outside the window nothing changes (hard cut = one picture) — the
 *     negative control;
 *  4. the gain envelope of the outgoing clip runs D/2 PAST its end and reaches
 *     zero linearly (§5.4 acrossfade equivalent).
 *
 * Same harness as engineV1.preview.test.ts: node environment, Compositor and
 * AudioGraph module-mocked, the real VideoPool driving fake <video> elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { linkTransition, mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset } from '../engine';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

interface RenderedItem {
  kind?: string;
  srcW?: number;
  progress?: number;
  from?: { srcW: number };
  to?: { srcW: number };
}

interface GainCurveCall {
  element: unknown;
  curve: number[];
  durationSec: number;
}

const harness = vi.hoisted(() => ({
  lastRender: [] as RenderedItem[],
  gainCurves: [] as GainCurveCall[],
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
    deleteTexture(): void {}
    readPixel(): null {
      return null;
    }
    dispose(): void {}
  },
  isTransitionItem: (item: RenderedItem): boolean => item.kind === 'transition',
}));

vi.mock('../audio/audioGraph', () => ({
  AudioGraph: class {
    // A live context: the envelope path returns early without one.
    context = {} as unknown;
    setSampleRate(): void {}
    nowSec(): number {
      return 0;
    }
    attachElement(): void {}
    ensureContext(): Promise<void> {
      return Promise.resolve();
    }
    setElementGain(): void {}
    setElementGainCurve(element: unknown, curve: Float32Array, durationSec: number): void {
      harness.gainCurves.push({ element, curve: [...curve], durationSec });
    }
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

const rafCallbacks: Array<() => void> = [];

const g = globalThis as Record<string, unknown>;
g['document'] = { createElement: (): FakeVideoElement => new FakeVideoElement() };
g['HTMLMediaElement'] = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
g['Image'] = class {};
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
/** Cut at 6 s, D = 1 s -> window [5.5 s, 6.5 s). */
const CUT_US = 6 * SEC;
const D_US = 1 * SEC;

let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

const videoAsset = (): PlayerAsset => ({ kind: 'video', url: 'blob:x' });

/**
 * A: [0, 6 s) from source [0, 6 s) — its tail handle is source [6 s, 6.5 s).
 * B: [6 s, 12 s) from source [1 s, 7 s) — its head handle is source [0.5 s, 1 s).
 */
function transitionDoc(withTransition = true) {
  const a = mkMediaClip({
    id: 'a',
    assetId: 'A',
    startUs: 0,
    durationUs: 6 * SEC,
    sourceInUs: 0,
    sourceOutUs: 6 * SEC,
  });
  const b = mkMediaClip({
    id: 'b',
    assetId: 'B',
    startUs: CUT_US,
    durationUs: 6 * SEC,
    sourceInUs: 1 * SEC,
    sourceOutUs: 7 * SEC,
  });
  if (withTransition) linkTransition(a, b, D_US);
  return mkDoc([mkTrack('t0', [a, b])]);
}

/** The pool element carrying a clip (null when it owns no slot). */
function elementOf(engine: VideoPlaybackEngine, clipId: string): FakeVideoElement | null {
  const slot = engine['pool'].slotForClip(clipId);
  return slot ? (slot.video as unknown as FakeVideoElement) : null;
}

/** Paused scrub seek — synchronous (applyScrub) and it re-renders the frame. */
function scrubTo(engine: VideoPlaybackEngine, tUs: number): void {
  void engine.seek(tUs, { precise: false });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rafCallbacks.length = 0;
  harness.lastRender = [];
  harness.gainCurves = [];
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

describe('composition inside a transition window (§5.3)', () => {
  it('hands the compositor ONE item carrying both sides and the progress', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    scrubTo(engine, CUT_US);

    expect(harness.lastRender, 'the pair is composed in one pass').toHaveLength(1);
    const item = harness.lastRender[0]!;
    expect(item.kind).toBe('transition');
    expect(item.from, 'the outgoing side must be there').toBeDefined();
    expect(item.to, 'the incoming side must be there').toBeDefined();
    expect(item.progress, 'the cut instant is the halfway point').toBeCloseTo(0.5, 6);
  });

  it('progress advances linearly across the window', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);

    const at = (tUs: number): number => {
      scrubTo(engine, tUs);
      vi.advanceTimersByTime(100); // scrub throttle
      scrubTo(engine, tUs);
      return harness.lastRender[0]!.progress!;
    };
    expect(at(CUT_US - D_US / 2)).toBeCloseTo(0, 6);
    expect(at(CUT_US - D_US / 4)).toBeCloseTo(0.25, 6);
    expect(at(CUT_US + D_US / 4)).toBeCloseTo(0.75, 6);
  });

  it('NEGATIVE CONTROL: without the transition the same instant is a single picture', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(false), videoAsset);
    scrubTo(engine, CUT_US);

    expect(harness.lastRender).toHaveLength(1);
    expect(harness.lastRender[0]!.kind, 'a hard cut draws ONE clip').toBeUndefined();
    expect(harness.lastRender[0]!.srcW).toBe(640);
  });

  it('outside the window a transitioned document still draws a single picture', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    scrubTo(engine, 3 * SEC);

    expect(harness.lastRender).toHaveLength(1);
    expect(harness.lastRender[0]!.kind).toBeUndefined();
  });
});

describe('element scheduling inside the window (§5.3 handles)', () => {
  it('BOTH clips own a pool element while the window is open', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    scrubTo(engine, CUT_US);

    expect(elementOf(engine, 'a'), 'the outgoing clip must keep its decoder').not.toBeNull();
    expect(elementOf(engine, 'b'), 'the incoming clip must already have one').not.toBeNull();
    expect(elementOf(engine, 'a')).not.toBe(elementOf(engine, 'b'));
  });

  it('each element sits on HANDLE material, not on a clamped edge frame', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    // 0.4 s PAST the cut: A is 0.4 s beyond its sourceOut, B 0.4 s past its in.
    scrubTo(engine, CUT_US + 400_000);

    expect(
      elementOf(engine, 'a')!.currentTime,
      'a frozen last frame here is exactly the "crossfade with a still" bug',
    ).toBeCloseTo(6.4, 3);
    expect(elementOf(engine, 'b')!.currentTime).toBeCloseTo(1.4, 3);
  });

  it('NEGATIVE CONTROL: with no transition the outgoing clip is NOT scheduled on handle material', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(false), videoAsset);
    scrubTo(engine, CUT_US + 400_000);

    // The backward double-buffer keeps A's element warm for reverse scrubbing…
    const a = elementOf(engine, 'a');
    expect(a, 'the just-ended clip stays warm (backward preload)').not.toBeNull();
    // …but the §5.3 HANDLE scheduling is off: A is not advanced to 6.4 s the
    // way the with-transition test above requires, and its picture is not part
    // of the composition (hard cut draws the single incoming clip).
    expect(a!.currentTime).not.toBeCloseTo(6.4, 3);
    expect(harness.lastRender).toHaveLength(1);
    expect(harness.lastRender[0]!.kind, 'hard cut: single picture, no pair').toBeUndefined();
    expect(elementOf(engine, 'b')).not.toBeNull();
  });
});

describe('audio crossfade (§5.4 acrossfade equivalent)', () => {
  /** The gain curve scheduled for a clip's element, latest wins. */
  function curveFor(engine: VideoPlaybackEngine, clipId: string): GainCurveCall {
    const element = engine['pool'].slotForClip(clipId)?.video;
    const call = [...harness.gainCurves].reverse().find((c) => c.element === element);
    expect(call, `no gain envelope was scheduled for ${clipId}`).toBeDefined();
    return call!;
  }

  it('the outgoing clip keeps sounding D/2 past its end and ramps to zero', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    engine.play();

    const call = curveFor(engine, 'a');
    expect(
      call.durationSec,
      'the envelope must cover the clip PLUS its half window (6 s + 0.5 s)',
    ).toBeCloseTo(6.5, 3);
    expect(call.curve.at(-1), 'silence at the window end').toBeCloseTo(0, 3);
    // The cut sits at 6/6.5 of the curve: half gain there (linear ramp).
    const atCut = call.curve[Math.round(((call.curve.length - 1) * 6) / 6.5)]!;
    expect(atCut, 'half gain at the cut is what makes A+B constant').toBeCloseTo(0.5, 2);
    // ...and it is still at full level well before the window opens.
    const before = call.curve[Math.round(((call.curve.length - 1) * 4) / 6.5)]!;
    expect(before).toBeCloseTo(1, 3);
  });

  it('NEGATIVE CONTROL: without the transition the envelope stops at the clip end', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(false), videoAsset);
    engine.play();

    const call = curveFor(engine, 'a');
    expect(call.durationSec, 'no handle extension on a hard cut').toBeCloseTo(6, 3);
    // A hard cut keeps the §8.4 click guard instead of a 1 s ramp.
    const atFourFifths = call.curve[Math.round((call.curve.length - 1) * 0.8)]!;
    expect(atFourFifths, 'full level right up to the 5 ms micro-fade').toBeCloseTo(1, 3);
  });

  it('the incoming clip fades UP over the window (both sides, not just one)', () => {
    const engine = makeEngine();
    engine.load(transitionDoc(), videoAsset);
    scrubTo(engine, CUT_US - D_US / 2); // window just opened
    engine.play();

    const call = curveFor(engine, 'b');
    // The envelope starts D/2 BEFORE the clip (handle) and runs to its end:
    // 0.5 s + 6 s = 6.5 s.
    expect(call.durationSec).toBeCloseTo(6.5, 3);
    const at = (localSec: number): number =>
      call.curve[Math.round(((call.curve.length - 1) * (localSec + 0.5)) / 6.5)]!;
    expect(call.curve[0], 'B starts silent at the window edge').toBeCloseTo(0, 3);
    expect(at(0), 'half gain at the cut — the mirror of A').toBeCloseTo(0.5, 2);
    expect(at(0.5), 'full level once the window closes').toBeCloseTo(1, 2);
    // The clip's own END still gets the §8.4 click guard (it is a hard edge).
    expect(at(5.5)).toBeCloseTo(1, 3);
    expect(call.curve.at(-1)).toBeCloseTo(0, 3);
  });
});
