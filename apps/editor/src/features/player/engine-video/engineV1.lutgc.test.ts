/**
 * VideoPlaybackEngine — LUT dokusu YAŞAM DÖNGÜSÜ (GPU bellek sızıntısı bulgusu):
 *
 * Bir 3D LUT tablosu poster dokularından büyüklük SINIFI olarak farklıdır
 * (129³ RGBA16F ≈ 17 MB). Girdiler yalnız dispose()'ta temizlenseydi LUT
 * deneyip vazgeçen bir oturum GPU belleğini biriktirirdi. İki süpürge var:
 *
 *  1. load() (doc senkronu): dokümanda hiçbir lut efektinin referans vermediği
 *     girdiler silinir (pruneOverlayTextures'ın klip-bazlı deseninin asset-bazlısı).
 *  2. lutFor: dokümanda referansı DURAN ama artık çözülemeyen (kitaplıktan
 *     silinmiş) LUT'un girdisi ilk çizim denemesinde düşer.
 *
 * Aynı tezgâh: node ortamı, Compositor/AudioGraph modül-mock'lu (engineV1.preview
 * testleriyle aynı desen), fetch bilinçli olarak hiç çözülmez — girdi senkron yaratılır.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset } from '../engine';
import type { TimelineDoc } from '@videoedit/timeline-schema';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  deletedTextures: 0,
  createdLutTextures: 0,
}));

vi.mock('../compositor/compositor', () => ({
  Compositor: class {
    resize(): void {}
    render(): void {}
    createTexture(): object {
      return {};
    }
    createLutTexture(): object {
      harness.createdLutTextures++;
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
// Girdi, fetch ÇÖZÜLMEDEN senkron yaratılır (texImage3D verisi sonradan dolar) —
// GC testleri için indirmenin bitmesine gerek yok.
g['fetch'] = (): Promise<never> => new Promise<never>(() => {});

import { VideoPlaybackEngine } from './engineV1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEC = 1_000_000;
const LUT_ID = 'lut-asset-1';

function lutClipDoc(withLut: boolean): TimelineDoc {
  const clip = mkMediaClip({
    id: 'img',
    assetId: 'A',
    kind: 'image',
    startUs: 0,
    durationUs: 10 * SEC,
    audio: null,
  });
  if (withLut) {
    clip.effects = [
      { id: 'fx1', type: 'lut', enabled: true, params: { assetId: LUT_ID, intensity: 1 } },
    ];
  }
  return mkDoc([mkTrack('t0', [clip])]);
}

function makeResolver(lutAvailable: () => boolean) {
  return (assetId: string): PlayerAsset | null => {
    if (assetId === 'A') return { kind: 'image', url: 'https://cdn/poster.png' };
    if (assetId === LUT_ID && lutAvailable()) return { kind: 'lut', url: 'https://cdn/table.cube' };
    return null;
  };
}

function lutEntryCount(engine: VideoPlaybackEngine): number {
  return (engine as unknown as { lutTextures: Map<string, unknown> }).lutTextures.size;
}

let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

/** Doc'u yükler, poster decode'unu bitirir, bir kare çizdirir — LUT girdisi oluşur. */
function warmUpLutEntry(engine: VideoPlaybackEngine, lutAvailable: () => boolean): void {
  engine.load(lutClipDoc(true), makeResolver(lutAvailable));
  stepFrame();
  createdImages.at(-1)?.onload?.();
  stepFrame();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  createdImages.length = 0;
  rafCallbacks.length = 0;
  harness.deletedTextures = 0;
  harness.createdLutTextures = 0;
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

describe('lut texture GC', () => {
  it('doc senkronu, artık hiçbir lut efektinin referans vermediği dokuyu süpürür', () => {
    const engine = makeEngine();
    warmUpLutEntry(engine, () => true);
    expect(harness.createdLutTextures, 'çizim LUT doku slotunu yaratmış olmalı').toBeGreaterThan(0);
    expect(lutEntryCount(engine)).toBe(1);

    const deletesBefore = harness.deletedTextures;
    engine.load(lutClipDoc(false), makeResolver(() => true)); // efekt kaldırıldı
    expect(lutEntryCount(engine), 'referanssız girdi haritadan düşmeli').toBe(0);
    expect(harness.deletedTextures, 'GPU dokusu gerçekten serbest bırakılmalı').toBeGreaterThan(
      deletesBefore,
    );
  });

  it('referansı süren doku doc senkronunda YAŞAR (negatif kontrol)', () => {
    const engine = makeEngine();
    warmUpLutEntry(engine, () => true);
    expect(lutEntryCount(engine)).toBe(1);

    const deletesBefore = harness.deletedTextures;
    engine.load(lutClipDoc(true), makeResolver(() => true)); // aynı efekt duruyor
    expect(lutEntryCount(engine), 'referanslı girdi silinmemeli').toBe(1);
    expect(harness.deletedTextures, 'yaşayan doku için delete çağrılmamalı').toBe(deletesBefore);
  });

  it('kitaplıktan silinen (resolver null) LUT girdisi ilk çizim denemesinde düşer', () => {
    let available = true;
    const engine = makeEngine();
    warmUpLutEntry(engine, () => available);
    expect(lutEntryCount(engine)).toBe(1);

    available = false; // varlık silindi; doküman referansı DURUYOR
    const deletesBefore = harness.deletedTextures;
    stepFrame();
    expect(lutEntryCount(engine), 'çözülemeyen LUT girdisi haritada kalmamalı').toBe(0);
    expect(harness.deletedTextures).toBeGreaterThan(deletesBefore);

    // Varlık geri gelirse sıradan ilk-yükleme yolu yeniden açılır.
    available = true;
    stepFrame();
    expect(lutEntryCount(engine)).toBe(1);
  });
});
