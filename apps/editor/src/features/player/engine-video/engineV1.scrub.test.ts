/**
 * VideoPlaybackEngine — scrub DIP-COVER + upload FRESHNESS pins (J-shuttle
 * "yabancı kare" düzeltmesi, 2026-09-02 canlı ölçümün birim damıtması).
 *
 * Ölçülen kusur: her scrub seek'i elementin readyState'ini 62-86 ms boyunca
 * HAVE_CURRENT_DATA altına düşürür (Chromium, gerçek proxy); eski çizim yolu o
 * pencerede klibi HİÇ çizmeyip arka planı (çok katmanlıda alt katmanı)
 * basıyordu — sürekli geri taramada ~160 ms'de bir siyah flaş. Pinler:
 *
 * 1. DIP-COVER: readyState çukurunda slotun SON YÜKLENEN karesi çizilmeye
 *    devam eder (sahiplik: aynı clipId + aynı pool epoch).
 * 2. FOREIGN-FRAME GUARD: slot el değiştirdiyse çukurda HİÇBİR ŞEY çizilmez —
 *    bayat doku başka klibin karesi olarak asla görünmez (kısa arka plan,
 *    yanlış içerikten iyidir).
 * 3. UPLOAD FRESHNESS (one-behind): currentTime seek başlar başlamaz HEDEFİ
 *    okur, bu yüzden set-anı damgası taze kareyi "zaten yüklü" sanıp atlar;
 *    'seeked' damgayı düşürür ve taze kare bir SONRAKİ rAF'ta yüklenir.
 * 4. BOUNDARY BASELINE: sınırda ısınmış (geriye-preload) element aktifleşirken
 *    kendi kaynak penceresindeki mevcut karesi seek'ten ÖNCE taban olarak
 *    yakalanır — ilk aktivasyon çukuru da örtülüdür.
 *
 * engineV1.seek.test.ts harness ailesi: node ortamı, Compositor/AudioGraph
 * modül-mock'lu, GERÇEK VideoPool sahte <video> elementleriyle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../../state/docStore';
import { useEditorStore } from '../../../state/editorStore';
import { mkDoc, mkMediaClip, mkTrack } from '../core/testFixtures';
import type { PlayerAsset } from '../engine';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

interface RenderedItem {
  texture: { id: number };
  srcW: number;
  srcH: number;
  kind?: string;
}

const harness = vi.hoisted(() => ({
  lastRender: [] as RenderedItem[],
  uploads: 0,
}));

vi.mock('../compositor/compositor', () => ({
  Compositor: class {
    private nextTextureId = 1;
    resize(): void {}
    render(items: RenderedItem[]): void {
      harness.lastRender = items;
    }
    createTexture(): object {
      return { id: this.nextTextureId++ };
    }
    upload(): void {
      harness.uploads++;
    }
    deleteTexture(): void {}
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
  /**
   * Gerçek tarayıcı davranışının damıtması: currentTime ATANINCA readyState bu
   * değere düşer (seek çukuru). null = düşmez (varsayılan; eski testlerle aynı).
   */
  dropOnSeek: number | null = null;
  private _currentTime = 0;
  private listeners = new Map<string, Set<(ev?: unknown) => void>>();

  get currentTime(): number {
    return this._currentTime;
  }
  set currentTime(value: number) {
    this._currentTime = value;
    if (this.dropOnSeek !== null) this.readyState = this.dropOnSeek;
  }

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
  requestVideoFrameCallback(): number {
    return 0;
  }
  cancelVideoFrameCallback(): void {}
  /** Decoder seek'i bitirdi: kare sunulabilir + 'seeked' yayınlanır. */
  finishSeek(): void {
    this.readyState = 4;
    this.dispatchEvent('seeked');
  }
}

const rafCallbacks: Array<() => void> = [];

function stepFrame(): void {
  const cbs = [...rafCallbacks];
  rafCallbacks.length = 0;
  for (const cb of cbs) cb();
}

const g = globalThis as Record<string, unknown>;
g['document'] = { createElement: (): FakeVideoElement => new FakeVideoElement() };
g['HTMLMediaElement'] = { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 };
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

const videoAsset = (): PlayerAsset => ({ kind: 'video', url: 'blob:x' });

function singleClipDoc() {
  return mkDoc([
    mkTrack('t0', [
      mkMediaClip({
        id: 'c1',
        assetId: 'A',
        startUs: 0,
        durationUs: 10 * SEC,
        sourceInUs: 0,
        sourceOutUs: 10 * SEC,
      }),
    ]),
  ]);
}

/** A=[0,10 s) + B=[10,20 s) bitişik, FARKLI asset'ler (sınır senaryosu). */
function twoClipDoc() {
  return mkDoc([
    mkTrack('t0', [
      mkMediaClip({
        id: 'a',
        assetId: 'A',
        startUs: 0,
        durationUs: 10 * SEC,
        sourceInUs: 0,
        sourceOutUs: 10 * SEC,
      }),
      mkMediaClip({
        id: 'b',
        assetId: 'B',
        startUs: 10 * SEC,
        durationUs: 10 * SEC,
        sourceInUs: 0,
        sourceOutUs: 10 * SEC,
      }),
    ]),
  ]);
}

let engines: VideoPlaybackEngine[] = [];

function makeEngine(): VideoPlaybackEngine {
  const engine = new VideoPlaybackEngine({} as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}

function elementOf(engine: VideoPlaybackEngine, clipId: string): FakeVideoElement {
  const slot = engine['pool'].slotForClip(clipId);
  expect(slot, `${clipId} bir pool slotuna sahip olmalı`).not.toBeNull();
  return slot!.video as unknown as FakeVideoElement;
}

/** Paused scrub: applyScrub senkron koşar ve kareyi yeniden çizer. */
function scrubTo(engine: VideoPlaybackEngine, tUs: number): void {
  void engine.seek(tUs, { precise: false });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rafCallbacks.length = 0;
  harness.lastRender = [];
  harness.uploads = 0;
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
// 1. Dip-cover: the mid-seek readyState dip must not drop the layer
// ---------------------------------------------------------------------------

describe('scrub dip-cover (son iyi kare)', () => {
  it('readyState çukurunda son yüklenen kare çizilmeye DEVAM eder', () => {
    const engine = makeEngine();
    engine.load(singleClipDoc(), videoAsset);
    stepFrame();
    expect(harness.lastRender, 'ısınma karesi çizilmeli').toHaveLength(1);
    const baselineTexture = harness.lastRender[0]!.texture;

    // Scrub seek'i: currentTime atanır atanmaz decoder çukuru açılır.
    const video = elementOf(engine, 'c1');
    video.dropOnSeek = 1; // < HAVE_CURRENT_DATA
    scrubTo(engine, 3 * SEC);

    // ESKİ yol burada [] basıyordu (katman arka plana düşer) — kusurun kendisi.
    expect(
      harness.lastRender,
      'seek çukurunda katman DÜŞMEMELİ: son iyi kare çizilmeli',
    ).toHaveLength(1);
    expect(harness.lastRender[0]!.texture).toBe(baselineTexture);
    expect(harness.lastRender[0]).toMatchObject({ srcW: 640, srcH: 360 });

    // Paused rAF döngüsü çukur boyunca aynı örtüyü basmaya devam eder.
    stepFrame();
    expect(harness.lastRender).toHaveLength(1);

    // Çukur kapanınca taze kare gelir, örtü biter.
    video.finishSeek();
    stepFrame();
    expect(harness.lastRender).toHaveLength(1);
  });

  it('sahiplik el değiştirdiyse çukurda HİÇBİR ŞEY çizilmez (yabancı kare bekçisi)', () => {
    const engine = makeEngine();
    engine.load(singleClipDoc(), videoAsset);
    stepFrame();
    expect(harness.lastRender).toHaveLength(1); // c1'in karesi dokuda

    // Aynı slot BAŞKA bir klibe geçer (yeni doküman: c1 yok, c2 var).
    const doc2 = mkDoc([
      mkTrack('t0', [
        mkMediaClip({
          id: 'c2',
          assetId: 'A',
          startUs: 0,
          durationUs: 10 * SEC,
          sourceInUs: 0,
          sourceOutUs: 10 * SEC,
        }),
      ]),
    ]);
    engine.load(doc2, videoAsset);
    const video = elementOf(engine, 'c2');
    video.readyState = 0; // c2'nin İLK karesi henüz yok (gerçekte src swap sonrası)

    stepFrame();
    expect(
      harness.lastRender,
      'dokuda duran c1 karesi c2 adına ASLA çizilmemeli — kısa arka plan yanlış içerikten iyidir',
    ).toHaveLength(0);

    // c2'nin kendi ilk karesi gelince normal yol devreye girer.
    video.readyState = 4;
    stepFrame();
    expect(harness.lastRender).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Upload freshness: 'seeked' invalidates the paused-upload stamp
// ---------------------------------------------------------------------------

describe('paused upload guard (one-behind düzeltmesi)', () => {
  it("'seeked' sonrası taze kare bir SONRAKİ rAF'ta yüklenir", () => {
    const engine = makeEngine();
    engine.load(singleClipDoc(), videoAsset);
    stepFrame();
    const afterWarmup = harness.uploads;
    expect(afterWarmup).toBeGreaterThan(0);

    // Scrub: currentTime HEDEFİ okur; render eski kareyi yeni damgayla yükler.
    scrubTo(engine, 3 * SEC);
    const afterScrub = harness.uploads;
    expect(afterScrub).toBeGreaterThan(afterWarmup);

    // Damga artık hedefle eşit: ek rAF'lar yükleme YAPMAZ (redundant-skip).
    stepFrame();
    stepFrame();
    expect(harness.uploads).toBe(afterScrub);

    // Decoder GERÇEK kareyi sundu (currentTime değişmedi!). Eski damga onu
    // "zaten yüklü" sanırdı — one-behind kusuru buydu.
    elementOf(engine, 'c1').finishSeek();
    stepFrame();
    expect(
      harness.uploads,
      "'seeked' sonrası taze kare yüklenmeli (önizleme bir adım geride kalmamalı)",
    ).toBe(afterScrub + 1);

    // Tazelik geri geldi: yükleme fırtınası yok.
    stepFrame();
    expect(harness.uploads).toBe(afterScrub + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Boundary: warm backward preload + pre-seek baseline capture
// ---------------------------------------------------------------------------

describe('sınırda geriye tarama (geriye-preload + taban yakalama)', () => {
  it('B içindeyken A geriye-preload ile ısınır; A aktifleşirken ilk çukur da örtülüdür', () => {
    const engine = makeEngine();
    engine.load(twoClipDoc(), videoAsset);

    // Önce B'nin DERİNİNE git: A lookbehind dışında kalır ve slotunu bırakır
    // (gerçek geri tarama senaryosu — A'ya uzaktan geri dönülür).
    scrubTo(engine, 15 * SEC);
    vi.advanceTimersByTime(100); // scrub throttle boşalsın
    stepFrame();
    expect(engine['pool'].slotForClip('a'), 'uzaktayken A istenmez').toBeNull();

    // B içinde sınıra yaklaş: B aktif, A (0,5 sn önce bitti) geriye-preload.
    scrubTo(engine, 10_500_000);
    vi.advanceTimersByTime(100);
    stepFrame();
    expect(harness.lastRender, 'B çizilmeli').toHaveLength(1);
    const a = elementOf(engine, 'a'); // geriye-preload YOKSA burada patlar
    expect(a.paused, 'preload elementi asla oynamaz').toBe(true);
    expect(a.currentTime, 'A kendi SONUNDA ısıtılır (geri giriş noktası)').toBeCloseTo(10, 3);

    // Sınırı GERİYE geç: A aktifleşir; ilk scrub seek'i çukur açar.
    a.dropOnSeek = 1;
    scrubTo(engine, 9_500_000);
    expect(
      harness.lastRender,
      'A’nın ısınmış karesi seek’ten ÖNCE taban alınmalı — sınır flaşsız',
    ).toHaveLength(1);
    expect(harness.lastRender[0]).toMatchObject({ srcW: 640, srcH: 360 });
    expect(a.currentTime).toBeCloseTo(9.5, 3);

    // Çukur kapanınca gerçek kare akışı sürer.
    a.finishSeek();
    stepFrame();
    expect(harness.lastRender).toHaveLength(1);
  });
});
