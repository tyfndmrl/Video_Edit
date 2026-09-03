/**
 * VideoPlaybackEngine seek/clock contract tests (chief-architect findings):
 *
 * 1. clock$ NEVER emits from seeks/scrubs and is fully silent while paused —
 *    it carries only the engine's own playback progress (+ end clamp).
 * 2. A DELAYED precise seek (slow requestVideoFrameCallback) that completes
 *    after a newer seek landed must not re-position anything (seekSeq guard).
 * 3. Seek clamping uses the LIVE docStore duration, not the stale loaded model.
 * 4. play() without a usable AudioContext (autoplay policy) rolls back
 *    honestly after the watchdog and signals blocked$.
 *
 * Runs in the node environment: Compositor and AudioGraph are module-mocked,
 * the REAL VideoPool runs on fake <video> elements via a document stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset } from '../engine';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  ensureContextImpl: (() => new Promise<void>(() => {})) as () => Promise<void>,
}));

vi.mock('../compositor/compositor', () => ({
  Compositor: class {
    resize(): void {}
    render(): void {}
    createTexture(): object {
      return {};
    }
    upload(): void {}
    deleteTexture(): void {}
    dispose(): void {}
  },
}));

vi.mock('../audio/audioGraph', () => ({
  AudioGraph: class {
    context = null;
    setSampleRate(): void {}
    nowSec(): number | null {
      return null; // performance.now fallback clock
    }
    attachElement(): void {}
    ensureContext(): Promise<void> {
      return harness.ensureContextImpl();
    }
    setElementGain(): void {}
    setElementGainCurve(): void {}
    cancelElement(): void {}
    readMeter(): null {
      return null; // meter tap is a real-AudioContext concern; engine tests stub it
    }
    suspend(): Promise<void> {
      return Promise.resolve();
    }
    dispose(): void {}
  },
}));

vi.mock('../mediaUrls', () => ({
  forceRefreshMediaUrls: vi.fn(),
}));

// ---------------------------------------------------------------------------
// DOM stubs for the real VideoPool (node environment)
// ---------------------------------------------------------------------------

type FrameCb = (now: number, meta: { mediaTime: number }) => void;

class FakeVideoElement {
  currentTime = 0;
  readyState = 4; // HAVE_ENOUGH_DATA
  paused = true;
  videoWidth = 640;
  videoHeight = 360;
  playbackRate = 1;
  src = '';
  crossOrigin = '';
  preload = '';
  playsInline = false;
  muted = false;
  /** Pending requestVideoFrameCallback callbacks, in registration order. */
  frameCallbacks: FrameCb[] = [];
  private listeners = new Map<string, Set<(ev?: unknown) => void>>();

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(): void {}
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
  }
  removeEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
  requestVideoFrameCallback(cb: FrameCb): number {
    this.frameCallbacks.push(cb);
    return this.frameCallbacks.length;
  }
  cancelVideoFrameCallback(): void {}
  /** Test helper: present a frame to the i-th pending rVFC callback. */
  emitFrame(index: number, mediaTimeSec: number): void {
    const cb = this.frameCallbacks[index];
    if (!cb) throw new Error(`no pending frame callback at index ${index}`);
    this.frameCallbacks.splice(index, 1);
    cb(0, { mediaTime: mediaTimeSec });
  }
}

const createdVideos: FakeVideoElement[] = [];
const rafCallbacks: Array<() => void> = [];

function stepFrame(): void {
  const cbs = [...rafCallbacks];
  rafCallbacks.length = 0;
  for (const cb of cbs) cb();
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const g = globalThis as Record<string, unknown>;
g['document'] = {
  createElement: (): FakeVideoElement => {
    const v = new FakeVideoElement();
    createdVideos.push(v);
    return v;
  },
};
g['HTMLMediaElement'] = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
g['requestAnimationFrame'] = (cb: () => void): number => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
g['cancelAnimationFrame'] = (): void => {};

// Import AFTER the mocks/stubs above (vi.mock is hoisted anyway; the globals
// are only needed at construction time).
import { VideoPlaybackEngine } from './engineV1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEC = 1_000_000;

function resolver(): PlayerAsset {
  return { kind: 'video', url: 'blob:test-proxy', durationUs: 60 * SEC };
}

function docWithClip(durationUs: number) {
  return mkDoc([
    mkTrack('t1', [
      mkMediaClip({ id: 'c1', startUs: 0, durationUs, sourceInUs: 0, sourceOutUs: durationUs }),
    ]),
  ]);
}

let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  // NOT faking requestAnimationFrame — the manual rAF stub above drives ticks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  createdVideos.length = 0;
  rafCallbacks.length = 0;
  harness.ensureContextImpl = () => new Promise<void>(() => {});
  useEditorStore.getState().setIsPlaying(false);
  // Different projectId than mkDoc's 'project-1': the live-duration lookup
  // falls back to the engine model unless a test loads a live doc explicitly.
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
// 1 + 2: clock silence + stale precise seek
// ---------------------------------------------------------------------------

describe('clock$ contract (finding 1a): seeks and pause never emit', () => {
  it('emits nothing while paused: precise seeks, scrubs and ticks are silent', async () => {
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const clockEvents: number[] = [];
    engine.clock$.subscribe((t) => clockEvents.push(t));

    // Precise seek (with its async element verification finishing cleanly).
    const p = engine.seek(2 * SEC, { precise: true });
    await flushMicrotasks();
    createdVideos[0]!.emitFrame(0, 2.0); // frame presented exactly on target
    await p;

    // Fast scrub.
    void engine.seek(3 * SEC, { precise: false });
    await vi.advanceTimersByTimeAsync(500); // scrub throttle window passes

    // Paused rAF ticks keep compositing but must not emit.
    stepFrame();
    stepFrame();

    expect(clockEvents).toEqual([]);
    expect(engine.getPositionUs()).toBe(3 * SEC);
  });

  it('emits ONLY the engine own playback progress while playing', async () => {
    harness.ensureContextImpl = () => Promise.resolve();
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const clockEvents: number[] = [];
    engine.clock$.subscribe((t) => clockEvents.push(t));

    engine.play();
    await flushMicrotasks();
    stepFrame(); // one playing tick -> one clock emission
    expect(clockEvents).toHaveLength(1);

    engine.pause();
    stepFrame();
    stepFrame();
    expect(clockEvents).toHaveLength(1); // paused again: silent
  });
});

describe('stale precise seek (finding 1b: seekSeq guard)', () => {
  it('a delayed precise seek cannot re-position a later seek and emits no clock', async () => {
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const clockEvents: number[] = [];
    engine.clock$.subscribe((t) => clockEvents.push(t));
    const video = createdVideos[0]!;

    // Seek #1: element positioned at 2 s, then waits for frame verification.
    const p1 = engine.seek(2 * SEC, { precise: true });
    await flushMicrotasks();
    expect(video.currentTime).toBe(2);
    expect(video.frameCallbacks).toHaveLength(1); // #1 pending

    // Seek #2 arrives while #1 still verifies.
    const p2 = engine.seek(5 * SEC, { precise: true });
    await flushMicrotasks();
    expect(video.currentTime).toBe(5);
    expect(video.frameCallbacks).toHaveLength(2);

    // #2's frame lands on target -> #2 completes.
    video.emitFrame(1, 5.0);
    await p2;
    expect(engine.getPositionUs()).toBe(5 * SEC);

    // #1's frame finally arrives, WAY off its 2 s target — its retry loop
    // would normally nudge currentTime back towards 2 s. Stale guard: it must
    // leave the element (and everything else) alone.
    video.emitFrame(0, 3.7);
    await p1;
    await flushMicrotasks();

    expect(video.currentTime).toBe(5); // NOT re-positioned by the stale job
    expect(engine.getPositionUs()).toBe(5 * SEC);
    expect(clockEvents).toEqual([]); // and no clock echo from any of it
  });
});

// ---------------------------------------------------------------------------
// 3: live-duration clamp (stale durationUs fix)
// ---------------------------------------------------------------------------

describe('seek clamp uses the LIVE doc duration (finding 2)', () => {
  it('allows seeking into a region the debounced engine model does not know yet', async () => {
    const engine = makeEngine();
    engine.load(docWithClip(5 * SEC), resolver); // engine model: 5 s
    useDocStore.getState().loadDoc(docWithClip(10 * SEC)); // live doc: 10 s

    const p = engine.seek(8 * SEC, { precise: true });
    await vi.advanceTimersByTimeAsync(600); // element verification timeouts
    await p;
    expect(engine.getPositionUs()).toBe(8 * SEC); // NOT clamped to stale 5 s
  });

  it('clamps to a SHRUNK live doc even when the engine model is longer', async () => {
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver); // engine model: 10 s
    useDocStore.getState().loadDoc(docWithClip(3 * SEC)); // live doc: 3 s

    const p = engine.seek(8 * SEC, { precise: true });
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(engine.getPositionUs()).toBe(3 * SEC);
  });
});

// ---------------------------------------------------------------------------
// 4: autoplay-blocked honest rollback
// ---------------------------------------------------------------------------

describe('play() without a usable audio context (finding 3)', () => {
  it('rolls back honestly after the watchdog and signals blocked$', async () => {
    harness.ensureContextImpl = () => new Promise<void>(() => {}); // never resumes
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const playEvents: boolean[] = [];
    const blockedEvents: boolean[] = [];
    engine.playState$.subscribe((v) => playEvents.push(v));
    engine.blocked$.subscribe((v) => blockedEvents.push(v));

    engine.play();
    expect(engine.isPlaying()).toBe(true); // optimistic start on fallback clock
    expect(useEditorStore.getState().isPlaying).toBe(true);

    await vi.advanceTimersByTimeAsync(350); // watchdog (300 ms) fires

    expect(engine.isPlaying()).toBe(false);
    expect(useEditorStore.getState().isPlaying).toBe(false);
    expect(playEvents).toEqual([true, false]);
    expect(blockedEvents).toEqual([true]);
    expect(engine.getPositionUs()).toBe(0); // no fake wall-clock progress kept
  });

  it('a later play() with a working context clears blocked and stays playing', async () => {
    harness.ensureContextImpl = () => new Promise<void>(() => {});
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const blockedEvents: boolean[] = [];
    engine.blocked$.subscribe((v) => blockedEvents.push(v));

    engine.play();
    await vi.advanceTimersByTimeAsync(350);
    expect(blockedEvents).toEqual([true]);

    // User gesture arrived: the context can start now.
    harness.ensureContextImpl = () => Promise.resolve();
    engine.play();
    expect(blockedEvents).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(350);

    expect(engine.isPlaying()).toBe(true);
    expect(useEditorStore.getState().isPlaying).toBe(true);
  });

  it('a successful resume within the watchdog keeps playing (no rollback)', async () => {
    harness.ensureContextImpl = () => Promise.resolve();
    const engine = makeEngine();
    engine.load(docWithClip(10 * SEC), resolver);
    const blockedEvents: boolean[] = [];
    engine.blocked$.subscribe((v) => blockedEvents.push(v));

    engine.play();
    await vi.advanceTimersByTimeAsync(350);

    expect(engine.isPlaying()).toBe(true);
    expect(blockedEvents).toEqual([]);
  });
});
