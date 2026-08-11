/**
 * Geçiş testleri — rendering-semantics §5'in editör tarafındaki karşılığı.
 *
 * Üç katman:
 *  1. SAF matematik (çift-kare snap'i, üst sınırlar) — sınır değerleri ve
 *     29.97 gibi tam olmayan ızgaralar dahil.
 *  2. OP'lar gerçek store üzerinde: yazılan dokümanı ŞEMANIN KENDİSİYLE
 *     (`validateTimelineDoc` + varlık süreleri) doğrularız. Editörün ürettiği
 *     bir dokümanın kendi doğrulayıcısından geçmemesi export'ta 422 demektir.
 *  3. Kırpma/taşıma/bölme sonrası uzlaştırma: geçişin sessizce değil,
 *     BİLDİRİMLE kısalması/kaldırılması.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTimelineDurationUs,
  frameToUs,
  usToFrame,
  validateTimelineDoc,
  type MediaClip,
  type Rational,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from '../../state/docStore';
import { useEditorStore } from '../../state/editorStore';
import { useAssetStore } from '../../state/assetStore';
import {
  addTransition,
  addTransitionAtEdge,
  addTransitionBlockReason,
  deleteClips,
  evenFramesAtMost,
  evenFramesNearest,
  findTransitionCut,
  IMAGE_DEFAULT_DURATION_US,
  knownAssetDurations,
  moveClips,
  planTransitionDuration,
  removeTransition,
  removeTransitionBlockReason,
  setTransitionDuration,
  setTransitionType,
  splitClipAt,
  trimClip,
  TRANSITION_DROPPED,
  TRANSITION_SHORTENED_HANDLE,
  TRANSITION_SHORTENED_LENGTH,
} from '../../state/timelineOps';
import { buildTimelineMenu, type TimelineMenuEntry, type TimelineMenuItem } from './contextMenu';
import { resolveTransitionEdge } from './transitions';

const US = 1_000_000;
const FPS30: Rational = { num: 30, den: 1 };
const FPS2997: Rational = { num: 30000, den: 1001 };

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET = '01890000-0000-7000-8000-00000000000a';
const IMG_ASSET_1 = '01890000-0000-7000-8000-00000000000b';
const IMG_ASSET_2 = '01890000-0000-7000-8000-00000000000c';
const V1 = '01890000-0000-7000-8000-000000000101';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';

/** Kaynak süresi 60 sn olan varlık — kuyruk payı testleri için bol. */
const ASSET_DURATION_US = 60 * US;

interface ClipSpec {
  id: string;
  startUs: number;
  sourceInUs: number;
  sourceOutUs: number;
  rate?: number;
  kind?: 'video' | 'image';
  assetId?: string;
}

function mediaClip(spec: ClipSpec): MediaClip {
  const rate = spec.rate ?? 1;
  const kind = spec.kind ?? 'video';
  return {
    id: spec.id,
    kind,
    assetId: spec.assetId ?? ASSET,
    timelineStartUs: spec.startUs,
    timelineDurationUs: clipTimelineDurationUs(spec.sourceInUs, spec.sourceOutUs, rate),
    sourceInUs: spec.sourceInUs,
    sourceOutUs: spec.sourceOutUs,
    speed: { rate },
    audio: kind === 'image' ? null : { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

/**
 * `addClipFromAsset` bir GÖRSELİ tam olarak böyle üretir: sourceIn 0,
 * sourceOut = IMAGE_DEFAULT_DURATION_US (4 sn), hız 1, ses yok.
 */
function imageClip(id: string, startUs: number, assetId: string): MediaClip {
  return mediaClip({
    id,
    startUs,
    sourceInUs: 0,
    sourceOutUs: IMAGE_DEFAULT_DURATION_US,
    kind: 'image',
    assetId,
  });
}

function docWith(clips: MediaClip[], fps: Rational = FPS30): TimelineDoc {
  const track: Track = {
    id: V1,
    type: 'video',
    name: 'V1',
    muted: false,
    hidden: false,
    locked: false,
    clips,
  };
  return {
    ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings, fps }),
    tracks: [track],
  };
}

/**
 * İki BİTİŞİK klip, her ikisinde de bol kaynak payı:
 * A [0..6 sn) kaynak 10..16 sn (kuyruk payı 44 sn),
 * B [6..12 sn) kaynak 20..26 sn (baş payı 20 sn).
 */
function adjacentWithHandles(over: Partial<ClipSpec> = {}): TimelineDoc {
  return docWith([
    mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
    mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US, ...over }),
  ]);
}

function load(d: TimelineDoc, selection: string[] = []): void {
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(d);
  useEditorStore.getState().setSelection(selection);
  useEditorStore.getState().setPlayheadUs(3 * US);
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function clipById(id: string): MediaClip {
  for (const t of currentDoc().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c as MediaClip;
  }
  throw new Error(`klip yok: ${id}`);
}

/** Dokümanı ŞEMA + invariant'larla doğrula (varlık süreleri dahil). */
function expectDocValid(): void {
  const result = validateTimelineDoc(currentDoc(), knownAssetDurations());
  if (!result.success) {
    throw new Error(
      `Doküman invariant ihlali:\n  ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n  ')}`,
    );
  }
}

beforeEach(() => {
  useAssetStore.getState().setAssets([
    { id: ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: ASSET_DURATION_US },
  ]);
  load(adjacentWithHandles());
});

// ---------------------------------------------------------------------------
// 1. Saf matematik
// ---------------------------------------------------------------------------

describe('çift-kare snap (rendering-semantics §5.2)', () => {
  it('bir saniyeyi 30 fps ızgarasında 30 kareye oturtur', () => {
    expect(evenFramesNearest(US, FPS30)).toBe(30);
    expect(frameToUs(30, FPS30)).toBe(US);
  });

  it('tek kare sayısını EN YAKIN çift kareye yuvarlar', () => {
    expect(evenFramesNearest(frameToUs(7, FPS30), FPS30)).toBe(8);
    expect(evenFramesNearest(frameToUs(9, FPS30), FPS30)).toBe(10);
  });

  it('taban 2 karedir (D/2 tam kare olmak zorunda)', () => {
    expect(evenFramesNearest(1, FPS30)).toBe(2);
    expect(evenFramesNearest(0, FPS30)).toBe(2);
  });

  /**
   * `evenFramesAtMost` ÜST SINIR içindir: `usToFrame` half-up yuvarladığı için
   * sınırı aşan bir kare döndürebilir. Aşarsa "kısalttım" dediğimiz geçiş,
   * kısaltmanın amacı olan invariant'ı bir kare ihlal eder.
   */
  it('üst sınırı ASLA aşmaz — 29.97 dahil her ızgarada', () => {
    for (const fps of [FPS30, FPS2997, { num: 24000, den: 1001 }, { num: 60, den: 1 }]) {
      for (let us = 1; us < 2 * US; us += 7919) {
        const frames = evenFramesAtMost(us, fps);
        expect(frames % 2, `${us}us @${fps.num}/${fps.den}: çift olmalı`).toBe(0);
        if (frames > 0) {
          expect(frameToUs(frames, fps), `${us}us @${fps.num}/${fps.den}`).toBeLessThanOrEqual(us);
          expect(frameToUs(frames + 2, fps)).toBeGreaterThan(us);
        }
      }
    }
  });

  it('sıfır/negatif süre için 0 kare döner (geçiş yok demektir)', () => {
    expect(evenFramesAtMost(0, FPS30)).toBe(0);
    expect(evenFramesAtMost(-5, FPS30)).toBe(0);
  });
});

describe('planTransitionDuration', () => {
  const plan = (d: TimelineDoc, requestedUs: number) => {
    const cut = findTransitionCut(d, CLIP_A, 'out');
    expect(cut, 'test kurulumu: A|B kesimi olmalı').not.toBeNull();
    return planTransitionDuration(
      cut!.a,
      cut!.b,
      requestedUs,
      d.settings.fps,
      new Map([[ASSET, ASSET_DURATION_US]]),
    );
  };

  it('pay bolken istenen süreyi olduğu gibi verir', () => {
    expect(plan(adjacentWithHandles(), US)).toEqual({
      durationUs: US,
      frames: 30,
      limitedBy: null,
    });
  });

  it('kısa komşuya göre kısaltır ve gerekçesini söyler', () => {
    // B yalnız 1 sn: üst sınır D*2 <= 1 sn -> D <= 0.5 sn -> 14 kare (çift taban).
    const d = adjacentWithHandles({ sourceOutUs: 21 * US });
    const result = plan(d, US);
    expect(result?.limitedBy).toBe('length');
    expect(result!.frames % 2).toBe(0);
    expect(result!.durationUs * 2).toBeLessThanOrEqual(1 * US);
    expect(frameToUs(result!.frames + 2, FPS30) * 2).toBeGreaterThan(1 * US);
  });

  it('kaynak payına göre kısaltır ve gerekçesini söyler', () => {
    // B'nin baş payı 0.3 sn -> D <= 0.6 sn = 18 kare.
    const d = adjacentWithHandles({ sourceInUs: 300_000, sourceOutUs: 6 * US + 300_000 });
    const result = plan(d, US);
    expect(result).toEqual({ durationUs: 600_000, frames: 18, limitedBy: 'handle' });
  });

  it('baş payı hiç yoksa (sourceIn = 0) geçişi REDDEDER', () => {
    const d = adjacentWithHandles({ sourceInUs: 0, sourceOutUs: 6 * US });
    expect(plan(d, US)).toBeNull();
  });

  it('kuyruk payı bittiyse (sourceOut = varlık sonu) reddeder', () => {
    const d = docWith([
      mediaClip({
        id: CLIP_A,
        startUs: 0,
        sourceInUs: ASSET_DURATION_US - 6 * US,
        sourceOutUs: ASSET_DURATION_US,
      }),
      mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
    ]);
    expect(plan(d, US)).toBeNull();
  });

  /**
   * Pay KAYNAK alanındadır: hız 2x bir klipte D/2'lik timeline penceresi
   * kaynakta D kadar yer yer — yani aynı pay yarı uzunlukta geçişe yeter.
   */
  it('hızı (speed.rate) paya çevirirken hesaba katar', () => {
    const d = docWith([
      mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 22 * US, rate: 2 }),
      mediaClip({
        id: CLIP_B,
        startUs: 6 * US,
        sourceInUs: 600_000,
        sourceOutUs: 600_000 + 12 * US,
        rate: 2,
      }),
    ]);
    // availB = 0.6 sn kaynak, rate 2 -> timeline-domain D <= 2 * 0.6/2 = 0.6 sn.
    const result = plan(d, US);
    expect(result?.limitedBy).toBe('handle');
    expect(result!.durationUs).toBeLessThanOrEqual(600_000);
    // Ve şemanın kendi kuralı da geçmeli: sourceIn >= roundHalfUp((D/2)*rate).
    expect(Math.floor(result!.durationUs / 2) * 2).toBeLessThanOrEqual(600_000);
  });

  it('varlık süresi bilinmiyorsa kuyruk kısıtı uygulanmaz (invariant ile aynı)', () => {
    const cut = findTransitionCut(adjacentWithHandles(), CLIP_A, 'out')!;
    expect(planTransitionDuration(cut.a, cut.b, US, FPS30, new Map())).toEqual({
      durationUs: US,
      frames: 30,
      limitedBy: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Op'lar
// ---------------------------------------------------------------------------

describe('addTransition', () => {
  it('kesimin İKİ tarafına derin-eşit metadata yazar ve doküman geçerli kalır', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'crossfade', durationUs: US });
    expect(clipById(CLIP_B).transitionIn).toEqual({ type: 'crossfade', durationUs: US });
    // Aynı NESNE olmamalı (takma ad, undo yamalarını yanıltır).
    expect(clipById(CLIP_A).transitionOut).not.toBe(clipById(CLIP_B).transitionIn);
    expectDocValid();
  });

  it('süreyi çift kare ızgarasına oturtur (rastgele bir µs değeri verilse bile)', () => {
    addTransition(CLIP_A, CLIP_B, 'dissolve', 1_234_567);
    const d = clipById(CLIP_A).transitionOut!.durationUs;
    const frames = usToFrame(d, FPS30);
    expect(frameToUs(frames, FPS30)).toBe(d);
    expect(frames % 2).toBe(0);
    expectDocValid();
  });

  it('undo geçişi tamamen geri alır (tek history girdisi)', () => {
    const before = useDocStore.getState().history.length;
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(useDocStore.getState().history.length).toBe(before + 1);
    useDocStore.getState().undo();
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(clipById(CLIP_B).transitionIn).toBeUndefined();
    expectDocValid();
  });

  it('kaynak payı yetmiyorsa KISALTIR ve bunu notice ile bildirir', () => {
    load(adjacentWithHandles({ sourceInUs: 300_000, sourceOutUs: 6 * US + 300_000 }));
    const result = addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(result).toEqual({ ok: true, notice: TRANSITION_SHORTENED_HANDLE });
    expect(clipById(CLIP_A).transitionOut!.durationUs).toBe(600_000);
    expectDocValid();
  });

  it('komşu klip kısaysa kısaltır ve gerekçesi "uzunluk" olur', () => {
    load(adjacentWithHandles({ sourceOutUs: 21 * US }));
    const result = addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(result.ok && result.notice).toBe(TRANSITION_SHORTENED_LENGTH);
    expectDocValid();
  });

  it('hiç pay yoksa reddeder ve doküman DEĞİŞMEZ', () => {
    load(adjacentWithHandles({ sourceInUs: 0, sourceOutUs: 6 * US }));
    const history = useDocStore.getState().history.length;
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'no room for a transition',
    });
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(useDocStore.getState().history.length).toBe(history);
  });

  it('aralarında boşluk olan kliplere geçiş eklemez', () => {
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        mediaClip({ id: CLIP_B, startUs: 8 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'no adjacent clip at this cut',
    });
  });

  it('yanlış sıradaki çifti (B|A) reddeder', () => {
    expect(addTransition(CLIP_B, CLIP_A, 'crossfade', US).ok).toBe(false);
  });

  it('aynı kesime ikinci kez eklemez', () => {
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(addTransition(CLIP_A, CLIP_B, 'wipeLeft', US)).toEqual({
      ok: false,
      reason: 'a transition is already here',
    });
  });

  it('kilitli track\'te reddeder', () => {
    const d = adjacentWithHandles();
    d.tracks[0].locked = true;
    load(d);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'track is locked',
    });
  });

  it('kenar adresli sarmalayıcı aynı kesimi bulur (B\'nin "in" kenarı = A\'nın "out"u)', () => {
    expect(addTransitionAtEdge(CLIP_B, 'in', 'wipeRight', US).ok).toBe(true);
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'wipeRight', durationUs: US });
    expectDocValid();
  });
});

describe('removeTransition / setTransitionType / setTransitionDuration', () => {
  beforeEach(() => {
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
  });

  it('kaldırma İKİ tarafı da siler', () => {
    expect(removeTransition(CLIP_A, 'out')).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(clipById(CLIP_B).transitionIn).toBeUndefined();
    expectDocValid();
  });

  it('kaldırma "in" kenarından da aynı kesimi hedefler', () => {
    expect(removeTransition(CLIP_B, 'in').ok).toBe(true);
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
  });

  it('geçiş yokken kaldırma reddedilir', () => {
    removeTransition(CLIP_A, 'out');
    expect(removeTransition(CLIP_A, 'out')).toEqual({
      ok: false,
      reason: 'no transition at this cut',
    });
  });

  it('tip değişimi süreyi korur ve simetrik kalır', () => {
    expect(setTransitionType(CLIP_A, 'out', 'slideUp')).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'slideUp', durationUs: US });
    expect(clipById(CLIP_B).transitionIn).toEqual({ type: 'slideUp', durationUs: US });
    expectDocValid();
  });

  it('süre değişimi ızgaraya oturur ve tipi korur', () => {
    expect(setTransitionDuration(CLIP_A, 'out', 2 * US)).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'crossfade', durationUs: 2 * US });
    expect(clipById(CLIP_B).transitionIn!.durationUs).toBe(2 * US);
    expectDocValid();
  });

  it('sınırı aşan süre isteği KISALTILIR ve bildirilir (sessiz kabul yok)', () => {
    // Üst sınır: min(6 sn, 6 sn) / 2 = 3 sn.
    const result = setTransitionDuration(CLIP_A, 'out', 10 * US);
    expect(result.ok && result.notice).toBe(TRANSITION_SHORTENED_LENGTH);
    expect(clipById(CLIP_A).transitionOut!.durationUs).toBe(3 * US);
    expectDocValid();
  });

  it('geçersiz (0) süre geçişi silmez', () => {
    setTransitionDuration(CLIP_A, 'out', 0);
    // 0 -> taban 2 kare; geçiş DURUYOR olmalı.
    expect(clipById(CLIP_A).transitionOut).toBeDefined();
    expectDocValid();
  });
});

// ---------------------------------------------------------------------------
// 2a. NTSC (29.97) — tam olmayan ızgarada uçtan uca
// ---------------------------------------------------------------------------

/**
 * Saf matematik testi `evenFramesAtMost`'un sınırı aşmadığını gösteriyor; burada
 * asıl soru OP'un ürettiği DOKÜMANIN 30000/1001 ızgarasında şemanın kendi
 * `frameToUs(usToFrame(D)) === D` kuralından geçip geçmediğidir. 29.97'de
 * frameToUs kesirlidir ve yuvarlama tek karelik bir kayma bırakabilir —
 * bırakırsa export 422 döner ("frame grid'inde değil").
 */
describe('NTSC (29.97) ızgarasında geçiş', () => {
  function loadNtsc(): void {
    load(
      docWith(
        [
          mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
          mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
        ],
        FPS2997,
      ),
    );
  }

  it('istenen 1 sn ÇİFT kareye oturur ve doküman geçerli kalır', () => {
    loadNtsc();
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    const d = clipById(CLIP_A).transitionOut!.durationUs;
    const frames = usToFrame(d, FPS2997);
    expect(frameToUs(frames, FPS2997), 'D tam olarak ızgarada olmalı').toBe(d);
    expect(frames % 2, 'D/2 tam kare olmalı').toBe(0);
    expectDocValid();
  });

  it('üst sınıra dayanan istek kısaltılır ve sınırı BİR KARE bile aşmaz', () => {
    loadNtsc();
    // Üst sınır: min(6 sn, 6 sn)/2 = 3 sn. 10 sn istenirse kısalır.
    const result = addTransition(CLIP_A, CLIP_B, 'crossfade', 10 * US);
    expect(result.ok && result.notice).toBe(TRANSITION_SHORTENED_LENGTH);
    const d = clipById(CLIP_A).transitionOut!.durationUs;
    expect(d * 2).toBeLessThanOrEqual(6 * US);
    expect(frameToUs(usToFrame(d, FPS2997) + 2, FPS2997) * 2).toBeGreaterThan(6 * US);
    expectDocValid();
  });

  it('süre değişimi de ızgarada kalır (rastgele bir µs isteğiyle)', () => {
    loadNtsc();
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(setTransitionDuration(CLIP_A, 'out', 1_234_567).ok).toBe(true);
    const d = clipById(CLIP_A).transitionOut!.durationUs;
    expect(frameToUs(usToFrame(d, FPS2997), FPS2997)).toBe(d);
    expect(usToFrame(d, FPS2997) % 2).toBe(0);
    expectDocValid();
  });
});

// ---------------------------------------------------------------------------
// 2b. GÖRSEL klipler: kaynağında zaman ekseni olmayan taraf pay ARAMAZ
// ---------------------------------------------------------------------------

/**
 * Denetim bulgusu (YÜKSEK): editör ve şema, D/2 kaynak payını HER medya klibine
 * uyguluyordu. Görsel klip `sourceIn = 0, sourceOut = 4 sn` ile doğar, yani payı
 * her zaman 0'dır → iki fotoğraf arasına geçiş "no room for a transition" ile
 * reddediliyordu. OYSA compiler görseli AÇIKÇA muaf tutuyor
 * (`ExportClipPlan.IsStillInput`, `!next.IsStillInput && next.SourceInUs < ...`):
 * görsel `-loop 1` ile açılır, pencerenin istediği kadar kare üretir. Üç katman
 * artık aynı yorumda — slayt gösterisi (geçişin en yaygın kullanımı) mümkün.
 */
describe('görsel kliplerde geçiş (slayt gösterisi)', () => {
  /** İki BİTİŞİK 4 sn'lik fotoğraf; ikisinde de sourceIn = 0. */
  function slideshow(): TimelineDoc {
    return docWith([
      imageClip(CLIP_A, 0, IMG_ASSET_1),
      imageClip(CLIP_B, IMAGE_DEFAULT_DURATION_US, IMG_ASSET_2),
    ]);
  }

  function loadSlideshow(imageDurationUs?: number): void {
    useAssetStore.getState().setAssets([
      { id: ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: ASSET_DURATION_US },
      { id: IMG_ASSET_1, kind: 'image', name: '1.jpg', status: 'ready', durationUs: imageDurationUs },
      { id: IMG_ASSET_2, kind: 'image', name: '2.jpg', status: 'ready', durationUs: imageDurationUs },
    ]);
    load(slideshow());
  }

  it('iki fotoğraf arasına crossfade EKLENEBİLİR ve doküman geçerli kalır', () => {
    loadSlideshow();
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'crossfade', durationUs: US });
    expect(clipById(CLIP_B).transitionIn).toEqual({ type: 'crossfade', durationUs: US });
    expectDocValid();
  });

  it('görsel varlığın süresi BİLİNSE bile kuyruk payı aranmaz', () => {
    // Bazı prob'lar görsele süre yazar; sourceOut o sürenin TAM sonunda olsa
    // dahi (kuyruk payı 0) geçiş kurulabilmeli — dosyada zaman ekseni yok.
    loadSlideshow(IMAGE_DEFAULT_DURATION_US);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expectDocValid();
  });

  it('sağ tık menüsünde "Geçiş ekle" AKTİF (gerekçe yok)', () => {
    loadSlideshow();
    const entries = buildTimelineMenu({
      target: { kind: 'clip', clipId: CLIP_A },
      doc: currentDoc(),
      selection: [CLIP_A],
      playheadUs: US,
      mutationAllowed: true,
    });
    const item = find(entries, 'addTransition');
    expect(item.disabled).toBe(false);
    expect(item.blockReason ?? null).toBeNull();
    expect(addTransitionBlockReason(currentDoc(), CLIP_A, 'out', knownAssetDurations())).toBeNull();
  });

  it('KLİP UZUNLUĞU sınırı görselde de geçerli (D*2 <= kısa komşu)', () => {
    loadSlideshow();
    // 4 sn'lik komşular -> D en fazla 2 sn. 3 sn istenirse KISALIR, kabul edilmez.
    const result = addTransition(CLIP_A, CLIP_B, 'crossfade', 3 * US);
    expect(result.ok && result.notice).toBe(TRANSITION_SHORTENED_LENGTH);
    expect(clipById(CLIP_A).transitionOut!.durationUs).toBe(2 * US);
    expectDocValid();
  });

  it('karışık kenarda YALNIZ video tarafının payı denetlenir (video GELEN taraf)', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: ASSET_DURATION_US },
      { id: IMG_ASSET_1, kind: 'image', name: '1.jpg', status: 'ready' },
    ]);
    // A = görsel (kuyruk payı yok), B = video sourceIn 0 (baş payı yok) -> RED.
    load(
      docWith([
        imageClip(CLIP_A, 0, IMG_ASSET_1),
        mediaClip({
          id: CLIP_B,
          startUs: IMAGE_DEFAULT_DURATION_US,
          sourceInUs: 0,
          sourceOutUs: 6 * US,
        }),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'no room for a transition',
    });

    // Videoya baş payı ver: görselin kuyruğu hâlâ 0 ama geçiş artık KURULUR.
    load(
      docWith([
        imageClip(CLIP_A, 0, IMG_ASSET_1),
        mediaClip({
          id: CLIP_B,
          startUs: IMAGE_DEFAULT_DURATION_US,
          sourceInUs: 2 * US,
          sourceOutUs: 8 * US,
        }),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expectDocValid();
  });

  it('karışık kenarda YALNIZ video tarafının payı denetlenir (video GİDEN taraf)', () => {
    useAssetStore.getState().setAssets([
      { id: ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: ASSET_DURATION_US },
      { id: IMG_ASSET_2, kind: 'image', name: '2.jpg', status: 'ready' },
    ]);
    // A = video, kaynağın TAM sonunda biter (kuyruk payı 0) -> RED.
    load(
      docWith([
        mediaClip({
          id: CLIP_A,
          startUs: 0,
          sourceInUs: ASSET_DURATION_US - 6 * US,
          sourceOutUs: ASSET_DURATION_US,
        }),
        imageClip(CLIP_B, 6 * US, IMG_ASSET_2),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'no room for a transition',
    });

    // Videoya kuyruk payı ver: görselin başı hâlâ 0 ama geçiş KURULUR.
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        imageClip(CLIP_B, 6 * US, IMG_ASSET_2),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expectDocValid();
  });

  it('geçişli görsel kesimi bozan taşıma yine BİLDİRİMLE temizlenir', () => {
    loadSlideshow();
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    const result = moveClips([CLIP_B], 2 * US);
    expect(result.ok && result.notice).toBe(TRANSITION_DROPPED);
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expectDocValid();
  });
});

// ---------------------------------------------------------------------------
// 3. Kırpma / taşıma / bölme etkileşimi
// ---------------------------------------------------------------------------

describe('düzenleme sonrası uzlaştırma', () => {
  beforeEach(() => {
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expectDocValid();
  });

  it('kesimi bozan taşıma geçişi kaldırır ve BİLDİRİR', () => {
    const result = moveClips([CLIP_B], 2 * US);
    expect(result.ok && result.notice).toBe(TRANSITION_DROPPED);
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(clipById(CLIP_B).transitionIn).toBeUndefined();
    expectDocValid();
  });

  /**
   * Baş payını yiyen tek jest ROLL'dür: kesimi sola kaydırmak B'yi sola
   * büyütür, yani `sourceIn`'ini azaltır. (Normal sol kırpma komşuyu geçemez —
   * `minStart = clipEndUs(prev)` — dolayısıyla payı tüketemez.)
   */
  it('kesimi sola yuvarlamak baş payını bitirir -> geçiş kaldırılır ve BİLDİRİLİR', () => {
    load(adjacentWithHandles({ sourceInUs: 400_000, sourceOutUs: 6 * US + 400_000 }));
    addTransition(CLIP_A, CLIP_B, 'crossfade', 800_000);
    expect(clipById(CLIP_B).transitionIn!.durationUs).toBe(800_000);

    const result = trimClip(CLIP_B, 'left', 5_600_000, 'roll');
    expect(clipById(CLIP_B).sourceInUs, 'roll baş payını tüketmeliydi').toBe(0);
    expect(
      clipById(CLIP_A).timelineStartUs + clipById(CLIP_A).timelineDurationUs,
      'roll kesimi korur',
    ).toBe(clipById(CLIP_B).timelineStartUs);
    expect(result.ok && result.notice).toBe(TRANSITION_DROPPED);
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(clipById(CLIP_B).transitionIn).toBeUndefined();
    expectDocValid();
  });

  /** Aynı jest, payın TAMAMI değil bir kısmı gidince: kaldırma değil KISALTMA. */
  it('kesimi biraz sola yuvarlamak geçişi KAYNAK PAYINA göre kısaltır', () => {
    load(adjacentWithHandles({ sourceInUs: 1_000_000, sourceOutUs: 7 * US }));
    addTransition(CLIP_A, CLIP_B, 'crossfade', 1_400_000);
    expect(clipById(CLIP_B).transitionIn!.durationUs).toBe(1_400_000);

    // Kesimi 0.8 sn sola al: baş payı 1.0 -> 0.2 sn, yani D <= 0.4 sn kalır.
    const result = trimClip(CLIP_B, 'left', 5_200_000, 'roll');
    expect(clipById(CLIP_B).sourceInUs).toBe(200_000);
    const kept = clipById(CLIP_A).transitionOut;
    expect(kept, 'pay hâlâ 2 kareye yetiyor -> kaldırma değil kısaltma').toBeDefined();
    expect(kept!.durationUs).toBeLessThanOrEqual(400_000);
    expect(result.ok && result.notice).toBe(TRANSITION_SHORTENED_HANDLE);
    expectDocValid();
  });

  it('klibi 2*D\'nin altına kırpmak geçişi kısaltır (kaldırmaz)', () => {
    // A 6 sn, D 1 sn. A'yı 1.2 sn'ye kırp: D <= 0.6 sn olmalı.
    const result = trimClip(CLIP_A, 'right', 1_200_000, 'normal');
    expect(result.ok).toBe(true);
    const transition = clipById(CLIP_A).transitionOut;
    // Kesim koptu mu? Sağ kenar kırpması boşluk açar -> geçiş kalkar.
    // Bu yüzden RIPPLE ile kırpıyoruz: komşu takip eder, kesim korunur.
    expect(transition).toBeUndefined();

    load(adjacentWithHandles());
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    const rippled = trimClip(CLIP_A, 'right', 1_200_000, 'ripple');
    expect(rippled.ok).toBe(true);
    const kept = clipById(CLIP_A).transitionOut;
    expect(kept, 'ripple kırpma kesimi korur -> geçiş yaşamalı').toBeDefined();
    expect(kept!.durationUs * 2).toBeLessThanOrEqual(clipById(CLIP_A).timelineDurationUs);
    // Sınırı KLİP UZUNLUĞU koydu (kaynak payı bol) — bildirim de onu söylemeli.
    expect(rippled.ok && rippled.notice).toBe(TRANSITION_SHORTENED_LENGTH);
    expectDocValid();
  });

  it('bölme, geçişli DIŞ kenarları bozmaz', () => {
    // A|B kesiminde geçiş var. B'yi ortadan böl: geçiş A ile B'nin İLK yarısı
    // arasında durmaya devam etmeli.
    const result = splitClipAt(CLIP_B, 9 * US);
    expect(result.ok).toBe(true);
    expect(clipById(CLIP_A).transitionOut, 'bölme kesimi bozmamalı').toEqual({
      type: 'crossfade',
      durationUs: US,
    });
    expect(clipById(CLIP_B).transitionIn).toEqual({ type: 'crossfade', durationUs: US });
    // Yeni yarıda geçiş metadata'sı OLMAMALI (yeni kesim geçişsiz doğar).
    const clips = currentDoc().tracks[0].clips as MediaClip[];
    expect(clips).toHaveLength(3);
    expect(clips[1].transitionOut).toBeUndefined();
    expect(clips[2].transitionIn).toBeUndefined();
    expectDocValid();
  });

  it('bölme sonrası yarım klip 2*D\'ye yetmiyorsa geçiş KISALIR', () => {
    // B'yi kesime çok yakın böl: ilk yarı 0.4 sn kalır, D 1 sn sığmaz.
    const result = splitClipAt(CLIP_B, 6 * US + 400_000);
    expect(result.ok).toBe(true);
    const transition = clipById(CLIP_A).transitionOut;
    expect(transition, 'geçiş kaldırılmak yerine kısaltılmalı').toBeDefined();
    expect(transition!.durationUs * 2).toBeLessThanOrEqual(400_000);
    expect(result.ok && result.notice).toBeDefined();
    expectDocValid();
  });

  /**
   * Denetim bulgusu (ripple/split sonrası ARTIK metadata): ortadaki klip ripple
   * ile silinince `A -crossfade- B -dissolve- C` dizisinde A'nın çıkış geçişi
   * ile C'nin giriş geçişi YENİ bir A|C kesiminde karşı karşıya kalır. İkisinden
   * yalnız biri yaşayabilir; öteki YOK OLUR. Eskiden bu sessizdi (`{ok:true}`,
   * bildirim yok) — kullanıcının kurduğu bir geçiş haber verilmeden siliniyordu.
   */
  it('ripple silme iki geçişi tek kesimde birleştirdiğinde KAYBI BİLDİRİR', () => {
    const CLIP_C = '01890000-0000-7000-8000-000000000203';
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
        mediaClip({ id: CLIP_C, startUs: 12 * US, sourceInUs: 30 * US, sourceOutUs: 36 * US }),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(addTransition(CLIP_B, CLIP_C, 'dissolve', US).ok).toBe(true);

    const result = deleteClips([CLIP_B], { ripple: true });
    expect(result.ok && result.notice, 'kayıp sessiz kalmamalı').toBe(TRANSITION_DROPPED);
    // Kesim yaşamaya devam eder ve SİMETRİKTİR — yalnız biri hayatta kalır.
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'crossfade', durationUs: US });
    expect(clipById(CLIP_C).transitionIn).toEqual({ type: 'crossfade', durationUs: US });
    expectDocValid();
  });

  /** Tek taraflı devir (öteki kesimde geçiş yoktu) bir KAYIP değildir: bildirim yok. */
  it('ripple silme tek geçişi yeni kesime taşırsa gereksiz bildirim ÜRETMEZ', () => {
    const CLIP_C = '01890000-0000-7000-8000-000000000203';
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
        mediaClip({ id: CLIP_C, startUs: 12 * US, sourceInUs: 30 * US, sourceOutUs: 36 * US }),
      ]),
    );
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);

    const result = deleteClips([CLIP_B], { ripple: true });
    expect(result).toEqual({ ok: true });
    expect(clipById(CLIP_A).transitionOut).toEqual({ type: 'crossfade', durationUs: US });
    expect(clipById(CLIP_C).transitionIn).toEqual({ type: 'crossfade', durationUs: US });
    expectDocValid();
  });

  it('klibi silmek karşı taraftaki metadata\'yı da temizler', () => {
    const result = deleteClips([CLIP_B]);
    expect(result.ok && result.notice).toBe(TRANSITION_DROPPED);
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expectDocValid();
  });
});

// ---------------------------------------------------------------------------
// 4. Menü entegrasyonu
// ---------------------------------------------------------------------------

function items(entries: TimelineMenuEntry[]): TimelineMenuItem[] {
  return entries.filter((e): e is TimelineMenuItem => e.kind === 'item');
}

function find(entries: TimelineMenuEntry[], id: string): TimelineMenuItem {
  const hit = items(entries).find((i) => i.id === id);
  if (!hit) throw new Error(`menü öğesi yok: ${id}`);
  return hit;
}

describe('sağ tık menüsü — geçiş öğeleri', () => {
  const menu = (clipId: string, timeUs?: number) =>
    buildTimelineMenu({
      target: { kind: 'clip', clipId, timeUs },
      doc: currentDoc(),
      selection: [clipId],
      playheadUs: 3 * US,
      mutationAllowed: true,
    });

  it('gerçek bir kesimde "Geçiş ekle" AKTİF, "Geçişi kaldır" gri', () => {
    expect(find(menu(CLIP_A), 'addTransition').disabled).toBe(false);
    expect(find(menu(CLIP_A), 'removeTransition').disabled).toBe(true);
  });

  it('geçiş eklendikten sonra roller yer değiştirir', () => {
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(find(menu(CLIP_A), 'addTransition').disabled).toBe(true);
    expect(find(menu(CLIP_A), 'removeTransition').disabled).toBe(false);
  });

  it('pay yoksa "Geçiş ekle" gri ve gerekçesi op ile aynı', () => {
    load(adjacentWithHandles({ sourceInUs: 0, sourceOutUs: 6 * US }));
    const item = find(menu(CLIP_A), 'addTransition');
    expect(item.disabled).toBe(true);
    expect(item.blockReason).toBe('no room for a transition');
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: 'no room for a transition',
    });
  });

  it('etiket, op\'un dokunacağı kesimi yazar (tıklanan noktaya en yakın kenar)', () => {
    // Üç klip: B'nin İKİ kenarında da kesim var.
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
        mediaClip({
          id: '01890000-0000-7000-8000-000000000203',
          startUs: 12 * US,
          sourceInUs: 30 * US,
          sourceOutUs: 36 * US,
        }),
      ]),
    );
    const d = currentDoc();
    // B [6..12 sn): 7. sn sol kesime yakın, 11. sn sağ kesime.
    expect(resolveTransitionEdge(d, CLIP_B, { timeUs: 7 * US, require: 'cut' })).toBe('in');
    expect(resolveTransitionEdge(d, CLIP_B, { timeUs: 11 * US, require: 'cut' })).toBe('out');
    expect(find(menu(CLIP_B, 7 * US), 'addTransition').label).toContain('sol kesim');
    expect(find(menu(CLIP_B, 11 * US), 'addTransition').label).toContain('sağ kesim');
  });

  it('"kaldır" yalnız geçiş OLAN kenarı hedefler', () => {
    load(
      docWith([
        mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
        mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
        mediaClip({
          id: '01890000-0000-7000-8000-000000000203',
          startUs: 12 * US,
          sourceInUs: 30 * US,
          sourceOutUs: 36 * US,
        }),
      ]),
    );
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    // Tık sağ kesime yakın olsa bile geçiş SOLDA: kaldır sol kesimi gösterir.
    expect(resolveTransitionEdge(currentDoc(), CLIP_B, { timeUs: 11 * US, require: 'transition' })).toBe(
      'in',
    );
    const item = find(menu(CLIP_B, 11 * US), 'removeTransition');
    expect(item.disabled).toBe(false);
    expect(item.label).toContain('sol kesim');
  });

  it('geçişi olmayan kenarda "kaldır" gri, gerekçesi op ile aynı', () => {
    const item = find(menu(CLIP_A), 'removeTransition');
    expect(item.blockReason).toBe('no transition at this cut');
    expect(removeTransitionBlockReason(currentDoc(), CLIP_A, 'out')).toBe(
      'no transition at this cut',
    );
  });

  it('blockReason ile op\'un gerekçesi hiçbir durumda ayrışmaz', () => {
    const d = currentDoc();
    for (const edge of ['in', 'out'] as const) {
      const reason = addTransitionBlockReason(d, CLIP_A, edge);
      const result = addTransitionAtEdge(CLIP_A, edge, 'crossfade', US);
      expect(result.ok, `${edge}: reason=${String(reason)}`).toBe(reason === null);
      if (result.ok) removeTransition(CLIP_A, edge);
    }
  });
});
