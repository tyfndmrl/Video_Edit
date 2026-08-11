/**
 * hitTestClips — pointer -> klip eşlemesinin TEK karar noktası.
 *
 * NEDEN BU DOSYA VAR (M4 denetimi, yüksek bulgu): bu fonksiyonun hiç birim
 * testi yoktu. Yarım piksellik bir sınır hatası (`<` yerine `<=`), ters tarama
 * yönü ya da trim tutamağının yanlış genişliği tüm E2E jestlerini SESSİZCE
 * kaydırır: tıklama "çalışır" ama yanlış klibi/bölgeyi seçer, testler yine de
 * yeşil kalabilir çünkü E2E hep klip ORTASINI hedefler. Buradaki testler o
 * sınırları çivi gibi sabitler.
 *
 * İki katman:
 *  1. Saf fonksiyon sözleşmesi (yarı-açık aralık, en üstteki kazanır).
 *  2. Rect'leri ÜRETEN gerçek çizici (drawTracks) ile birlikte: tutamak
 *     genişliği, push sırası ve dpr bağımsızlığı — yani hitTest'in dayandığı
 *     varsayımların gerçekten sağlandığı.
 */
import { describe, expect, it } from 'vitest';
import type { MediaClip, TimelineDoc, Track, Uuid } from '@videoedit/timeline-schema';
import { hitTestClips, type ClipHitRect, type HitRegion } from './hitTest';
import { TRACK_H, TRIM_HANDLE_W, trackTop } from './geometry';
import { drawTracks, type BodyRenderState } from './render/drawTracks';
import { createEmptyDoc, defaultProjectSettings } from '../../state/docStore';

const US = 1_000_000;

function rect(over: Partial<ClipHitRect> = {}): ClipHitRect {
  return {
    clipId: 'c1' as Uuid,
    trackId: 't1' as Uuid,
    trackIndex: 0,
    region: 'body',
    x: 10,
    y: 20,
    w: 100,
    h: TRACK_H,
    ...over,
  };
}

describe('hitTestClips — saf sözleşme', () => {
  it('boş listede null döner', () => {
    expect(hitTestClips([], 0, 0)).toBeNull();
  });

  it('rect içindeki noktayı bulur', () => {
    const r = rect();
    expect(hitTestClips([r], 50, 40)).toBe(r);
  });

  it('rect dışındaki noktada null döner', () => {
    const r = rect();
    expect(hitTestClips([r], 5, 40)).toBeNull();
    expect(hitTestClips([r], 50, 10)).toBeNull();
    expect(hitTestClips([r], 200, 40)).toBeNull();
    expect(hitTestClips([r], 50, 200)).toBeNull();
  });

  it('x aralığı YARI AÇIK: sol kenar dahil, sağ kenar hariç', () => {
    const r = rect({ x: 10, w: 100 });
    expect(hitTestClips([r], 10, 40), 'sol kenar (x === r.x) DAHİL').toBe(r);
    expect(hitTestClips([r], 109.999, 40)).toBe(r);
    expect(hitTestClips([r], 110, 40), 'sağ kenar (x === r.x + r.w) HARİÇ').toBeNull();
  });

  it('y aralığı YARI AÇIK: üst kenar dahil, alt kenar hariç', () => {
    const r = rect({ y: 20, h: 56 });
    expect(hitTestClips([r], 50, 20), 'üst kenar (y === r.y) DAHİL').toBe(r);
    expect(hitTestClips([r], 50, 75.999)).toBe(r);
    expect(hitTestClips([r], 50, 76), 'alt kenar (y === r.y + r.h) HARİÇ').toBeNull();
  });

  it('sıfır genişlikli/yükseklikli rect hiçbir zaman vurmaz (yarı açık aralık boş)', () => {
    expect(hitTestClips([rect({ w: 0 })], 10, 40)).toBeNull();
    expect(hitTestClips([rect({ h: 0 })], 50, 20)).toBeNull();
  });

  it('negatif koordinatlarda da çalışır (sola kaydırılmış görünüm)', () => {
    const r = rect({ x: -50, w: 100, y: -10, h: 30 });
    expect(hitTestClips([r], -50, -10)).toBe(r);
    expect(hitTestClips([r], -1, 19)).toBe(r);
    expect(hitTestClips([r], 50, 0)).toBeNull();
  });

  it('üst üste binen rect\'lerde SONRA eklenen (üstte çizilen) kazanır', () => {
    const under = rect({ clipId: 'alt' as Uuid });
    const over = rect({ clipId: 'ust' as Uuid });
    expect(hitTestClips([under, over], 50, 40)?.clipId).toBe('ust');
    expect(hitTestClips([over, under], 50, 40)?.clipId).toBe('alt');
  });

  it('trim tutamakları gövdeden SONRA eklendiği için kenarlarda onlar kazanır', () => {
    // drawTracks sırası: body, trimL, trimR.
    const body = rect({ region: 'body', x: 0, w: 90 });
    const trimL = rect({ region: 'trimL', x: 0, w: 8 });
    const trimR = rect({ region: 'trimR', x: 82, w: 8 });
    const rects = [body, trimL, trimR];
    expect(hitTestClips(rects, 0, 40)?.region).toBe('trimL');
    expect(hitTestClips(rects, 7.99, 40)?.region).toBe('trimL');
    expect(hitTestClips(rects, 8, 40)?.region, 'tutamak biter bitmez gövde').toBe('body');
    expect(hitTestClips(rects, 81.99, 40)?.region).toBe('body');
    expect(hitTestClips(rects, 82, 40)?.region).toBe('trimR');
    expect(hitTestClips(rects, 89.99, 40)?.region).toBe('trimR');
    expect(hitTestClips(rects, 90, 40), 'klibin sağ kenarı dışı').toBeNull();
  });

  it('farklı track satırları y ile ayrışır (track index doğru raporlanır)', () => {
    const row0 = rect({ trackIndex: 0, y: trackTop(0), h: TRACK_H });
    const row1 = rect({ trackIndex: 1, y: trackTop(1), h: TRACK_H });
    const rects = [row0, row1];
    expect(hitTestClips(rects, 50, trackTop(0))?.trackIndex).toBe(0);
    expect(hitTestClips(rects, 50, trackTop(0) + TRACK_H - 0.01)?.trackIndex).toBe(0);
    expect(hitTestClips(rects, 50, trackTop(1) - 1), 'satırlar arası boşluk').toBeNull();
    expect(hitTestClips(rects, 50, trackTop(1))?.trackIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rect'leri ÜRETEN taraf: drawTracks
// ---------------------------------------------------------------------------

/** Canvas 2D bağlamı yerine her çağrıyı yutan vekil (çizim değil, rect listesi test ediliyor). */
function stubCtx(): CanvasRenderingContext2D {
  const noop = (): undefined => undefined;
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get: (t, k) => (k in t ? t[k as string] : noop),
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function mediaClip(id: string, startUs: number, durationUs: number): MediaClip {
  return {
    id: id as Uuid,
    kind: 'video',
    assetId: '01890000-0000-7000-8000-00000000000a' as Uuid,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: null,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function docWith(tracks: { id: string; clips: MediaClip[] }[]): TimelineDoc {
  const built: Track[] = tracks.map((t) => ({
    id: t.id as Uuid,
    type: 'video',
    muted: false,
    hidden: false,
    locked: false,
    clips: t.clips,
  }));
  return {
    ...createEmptyDoc('01890000-0000-7000-8000-000000000001' as Uuid, { ...defaultProjectSettings }),
    tracks: built,
  };
}

function renderState(doc: TimelineDoc, over: Partial<BodyRenderState> = {}): BodyRenderState {
  return {
    doc,
    widthPx: 800,
    heightPx: 400,
    dpr: 1,
    scrollUs: 0,
    pxPerUs: 0.0001, // 100 px / s
    scrollY: 0,
    selection: new Set(),
    assets: new Map(),
    drag: null,
    ...over,
  };
}

function regionsOf(hits: ClipHitRect[], clipId: string): Record<HitRegion, ClipHitRect> {
  const out = {} as Record<HitRegion, ClipHitRect>;
  for (const h of hits) if (h.clipId === (clipId as Uuid)) out[h.region] = h;
  return out;
}

describe('drawTracks -> hitTestClips (rect üretimi + tüketimi birlikte)', () => {
  it('klip başına body/trimL/trimR üretir ve gövde zaman->piksel formülüne oturur', () => {
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 2 * US, 3 * US)] }]);
    const hits = drawTracks(stubCtx(), renderState(doc));

    expect(hits.map((h) => h.region)).toEqual(['body', 'trimL', 'trimR']);
    const r = regionsOf(hits, 'c1');
    // xPx = (timeUs - scrollUs) * pxPerUs -> 2s * 0.0001 = 200 px, genişlik 300 px.
    expect(r.body.x).toBe(200);
    expect(r.body.w).toBe(300);
    expect(r.body.y).toBe(trackTop(0));
    expect(r.body.h).toBe(TRACK_H);
    expect(r.trimL.x).toBe(200);
    expect(r.trimL.w).toBe(TRIM_HANDLE_W);
    expect(r.trimR.x).toBe(200 + 300 - TRIM_HANDLE_W);
    expect(r.trimR.w).toBe(TRIM_HANDLE_W);
  });

  it('scrollUs kaydırması rect\'leri birebir öteler', () => {
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 2 * US, 3 * US)] }]);
    const hits = drawTracks(stubCtx(), renderState(doc, { scrollUs: 1 * US }));
    expect(regionsOf(hits, 'c1').body.x).toBe(100);
  });

  it('DAR klipte tutamak genişliği w/3 ile sınırlanır (gövde asla yutulmaz)', () => {
    // 120 ms * 0.0001 px/us = 12 px genişlik -> handleW = min(8, 4) = 4.
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 0, 120_000)] }]);
    const hits = drawTracks(stubCtx(), renderState(doc));
    const r = regionsOf(hits, 'c1');
    expect(r.body.w).toBe(12);
    expect(r.trimL.w).toBe(4);
    expect(r.trimR.w).toBe(4);
    expect(r.trimR.x).toBe(8);

    // Ortadaki 4 px GÖVDE olarak kalmalı: aksi halde dar klipler taşınamaz.
    const y = trackTop(0) + TRACK_H / 2;
    expect(hitTestClips(hits, 3.99, y)?.region).toBe('trimL');
    expect(hitTestClips(hits, 4, y)?.region).toBe('body');
    expect(hitTestClips(hits, 7.99, y)?.region).toBe('body');
    expect(hitTestClips(hits, 8, y)?.region).toBe('trimR');
    expect(hitTestClips(hits, 11.99, y)?.region).toBe('trimR');
    expect(hitTestClips(hits, 12, y)).toBeNull();
  });

  it('dpr rect\'leri ETKİLEMEZ — hit test CSS pikselinde çalışır', () => {
    // Çizim ctx.scale(dpr, dpr) ile ölçeklenir; rect listesi ölçeklenmez.
    // Buraya bir dpr çarpanı sızarsa 2x ekranlarda her tıklama kayar.
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 2 * US, 3 * US)] }]);
    const at1 = drawTracks(stubCtx(), renderState(doc, { dpr: 1 }));
    const at2 = drawTracks(stubCtx(), renderState(doc, { dpr: 2 }));
    const at3 = drawTracks(stubCtx(), renderState(doc, { dpr: 2.5 }));
    expect(at2).toEqual(at1);
    expect(at3).toEqual(at1);
  });

  it('scrollY rect\'lere GİRMEZ — y içerik uzayında kalır (pointer da öyle çevirir)', () => {
    // TimelinePanel.localPoint: contentY = y - RULER_H + scrollY. Rect'ler
    // içerik uzayında olduğu için dikey kaydırma iki tarafta da bir kez uygulanır.
    const doc = docWith([
      { id: 't1', clips: [mediaClip('c1', 0, 3 * US)] },
      { id: 't2', clips: [mediaClip('c2', 0, 3 * US)] },
    ]);
    const plain = drawTracks(stubCtx(), renderState(doc));
    const scrolled = drawTracks(stubCtx(), renderState(doc, { scrollY: 40 }));
    expect(scrolled).toEqual(plain);
    expect(regionsOf(plain, 'c2').body.y).toBe(trackTop(1));
  });

  it('üst üste binen klipler: SONRAKİ track kazanır (çizim sırası = z sırası)', () => {
    const doc = docWith([
      { id: 't1', clips: [mediaClip('c1', 0, 3 * US)] },
      { id: 't2', clips: [mediaClip('c2', 0, 3 * US)] },
    ]);
    const hits = drawTracks(stubCtx(), renderState(doc));
    // Aynı x, farklı satır: satırlar çakışmaz ama liste sırası korunmalı.
    expect(hits.filter((h) => h.region === 'body').map((h) => h.clipId)).toEqual(['c1', 'c2']);
    expect(hitTestClips(hits, 100, trackTop(1) + 1)?.clipId).toBe('c2');
    expect(hitTestClips(hits, 100, trackTop(0) + 1)?.clipId).toBe('c1');
  });

  it('görünür aralık dışındaki klip için rect üretilmez (tıklanamaz da olmaz)', () => {
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 600 * US, 3 * US)] }]);
    const hits = drawTracks(stubCtx(), renderState(doc));
    expect(hits).toEqual([]);
    expect(hitTestClips(hits, 100, trackTop(0) + 1)).toBeNull();
  });

  it('çok kısa klip bile en az 2 px genişlikte tıklanabilir kalır', () => {
    const doc = docWith([{ id: 't1', clips: [mediaClip('c1', 0, 1_000)] }]); // 0.1 px
    const hits = drawTracks(stubCtx(), renderState(doc));
    expect(regionsOf(hits, 'c1').body.w).toBe(2);
    expect(hitTestClips(hits, 1, trackTop(0) + 1)?.clipId).toBe('c1');
  });
});
