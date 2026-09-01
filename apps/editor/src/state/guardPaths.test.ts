/**
 * guardPaths — "editör serbest bıraktı, derleyici 422 verdi" yollarının kapıları.
 *
 * Dışa aktarma derleyicisi (backend/src/VideoEdit.Media/Export/ExportCompiler.cs)
 * üç bileşimi TİPLİ HATA ile reddeder. Editör bunları kurdurabildiği sürece
 * kullanıcı gerekçeyi ancak dışa aktarımda görür — "yönlendir sonra reddet".
 * Bu dosya kapıların üçünü de op düzeyinde kanıtlar:
 *
 *  (a) transition-keyframes            — geçişli kesimin kliplerinde görsel keyframe
 *  (b) scale-keyframes-with-rotation   — ölçek animasyonu + dönme
 *  (c) "geçişli kliplerin yerleşimi aynı olmalı" — burada ENGEL değil YAYILIM
 *
 * SÖZLEŞME (her kapı için ayrı ayrı sınanır): `blockReason === null` ile
 * `op().ok` ASLA ayrışmaz. Ayrışsalardı ya menü reddedilecek bir eylemi teklif
 * ederdi (asıl kusur) ya da haklı bir düzenlemeyi haksız yere kapatırdı.
 *
 * Doküman her yazımdan sonra ŞEMANIN KENDİSİYLE doğrulanır: kapı eklerken
 * invariant bozmak, 422'yi başka bir kapıdan geri getirmek olurdu.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_LAYER_DIMENSION,
  clipTimelineDurationUs,
  intermediateCanvasLongSidePx,
  validateTimelineDoc,
  type Keyframe,
  type MediaClip,
  type Rational,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { useEditorStore } from './editorStore';
import {
  DEFAULT_TRANSFORM,
  REASON_KEYFRAME_NEEDS_NO_TRANSITION,
  REASON_ROTATION_NEEDS_STATIC_SCALE,
  REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
  REASON_TRANSITION_NEEDS_STATIC_CLIPS,
  SCALE_CLAMPED_BY_ROTATION,
  TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
  addTransition,
  addTransitionAtEdge,
  addTransitionBlockReason,
  clipEndUs,
  clipHasVisualKeyframes,
  deleteClips,
  knownAssetDurations,
  linkBlockReason,
  linkClips,
  resetClipTransform,
  rotationBlockReason,
  setClipTransform,
  transitionChainSiblings,
  unlinkBlockReason,
  unlinkClips,
  type OpResult,
} from './timelineOps';
import {
  KEYFRAME_CHANNELS,
  channelBlockReason,
  type KeyframeChannel,
} from '../features/keyframes/keyframeModel';
import {
  addKeyframe,
  addKeyframeBlockReason,
  applyTransformPatchToDraft,
  clearChannel,
  removeKeyframe,
  toggleKeyframe,
} from '../features/keyframes/keyframeOps';

const US = 1_000_000;
const FPS30: Rational = { num: 30, den: 1 };

const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET = '01890000-0000-7000-8000-00000000000a';
const V1 = '01890000-0000-7000-8000-000000000101';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const CLIP_C = '01890000-0000-7000-8000-000000000203';

const ASSET_DURATION_US = 60 * US;

const kf = (timeUs: number, value: number): Keyframe => ({
  timeUs,
  value,
  easing: { type: 'linear' },
});

interface ClipSpec {
  id: string;
  startUs: number;
  sourceInUs: number;
  sourceOutUs: number;
}

function mediaClip(spec: ClipSpec): MediaClip {
  return {
    id: spec.id,
    kind: 'video',
    assetId: ASSET,
    timelineStartUs: spec.startUs,
    timelineDurationUs: clipTimelineDurationUs(spec.sourceInUs, spec.sourceOutUs, 1),
    sourceInUs: spec.sourceInUs,
    sourceOutUs: spec.sourceOutUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { ...DEFAULT_TRANSFORM },
    keyframes: {},
    effects: [],
    opacity: 1,
  };
}

function docWith(clips: MediaClip[]): TimelineDoc {
  const track: Track = {
    id: V1,
    type: 'video',
    name: 'V1',
    muted: false,
    hidden: false,
    locked: false,
    clips,
  };
  return { ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings, fps: FPS30 }), tracks: [track] };
}

/**
 * Üç BİTİŞİK klip, hepsinde bol kaynak payı (geçiş D/2 payını her kesimde
 * bulur): A [0..6), B [6..12), C [12..18).
 */
function threeAdjacent(): TimelineDoc {
  return docWith([
    mediaClip({ id: CLIP_A, startUs: 0, sourceInUs: 10 * US, sourceOutUs: 16 * US }),
    mediaClip({ id: CLIP_B, startUs: 6 * US, sourceInUs: 20 * US, sourceOutUs: 26 * US }),
    mediaClip({ id: CLIP_C, startUs: 12 * US, sourceInUs: 30 * US, sourceOutUs: 36 * US }),
  ]);
}

function load(d: TimelineDoc): void {
  useDocStore.getState().setLocked(false);
  useDocStore.getState().loadDoc(d);
  useEditorStore.getState().clearSelection();
  useEditorStore.getState().setPlayheadUs(0);
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

/** Dokümanı yükler ve `mutate` ile (gerçek yolla) bir klibi düzenler. */
function editClip(clipId: string, fn: (c: MediaClip) => void): void {
  editClips((find) => fn(find(clipId)));
}

/**
 * Aynı `mutate` içinde BİRDEN ÇOK klibi düzenler.
 *
 * Neden gerekli: geçiş metadata'sı iki klibe birden yazılır ve simetrik OLMAK
 * ZORUNDADIR (invariant 5). İki ayrı `mutate` ile yazıldığında aradaki an
 * asimetriktir ve docStore'un taahhüt kapısı (assertDocGateDev) o yarım belgeyi
 * — haklı olarak — reddeder. Kurulum tek parça yazılır.
 */
function editClips(fn: (find: (clipId: string) => MediaClip) => void): void {
  useDocStore.getState().mutate('test', 'test kurulum', (d) => {
    fn((clipId) => {
      for (const t of d.tracks) {
        const c = t.clips.find((x) => x.id === clipId);
        if (c) return c as MediaClip;
      }
      throw new Error(`Test kurulumu: ${clipId} klibi dokümanda yok.`);
    });
  });
}

beforeEach(() => {
  useAssetStore.getState().setAssets([
    { id: ASSET, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: ASSET_DURATION_US },
  ]);
  load(threeAdjacent());
});

// ---------------------------------------------------------------------------
// (a) transition-keyframes — ExportCompiler.cs:~1498
// ---------------------------------------------------------------------------

describe('(a) geçiş + keyframe', () => {
  it('temiz kesimde geçiş serbesttir (kapı aşırı-kısıtlamıyor)', () => {
    expect(addTransitionBlockReason(currentDoc(), CLIP_A, 'out')).toBeNull();
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expectDocValid();
  });

  it.each([
    ['giden klipte (A)', CLIP_A],
    ['gelen klipte (B)', CLIP_B],
  ])('%s görsel keyframe varsa geçiş EKLENEMEZ — gerekçe op ile aynı', (_name, clipId) => {
    editClip(clipId, (c) => {
      c.keyframes.opacity = [kf(0, 1), kf(2 * US, 0)];
    });

    const reason = addTransitionBlockReason(currentDoc(), CLIP_A, 'out');
    expect(reason).toBe(REASON_TRANSITION_NEEDS_STATIC_CLIPS);
    // ⟺: menü kapalıysa op da reddeder, aynı gerekçeyle.
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: REASON_TRANSITION_NEEDS_STATIC_CLIPS,
    });
    expect(clipById(CLIP_A).transitionOut).toBeUndefined();
    expect(clipById(CLIP_B).transitionIn).toBeUndefined();
  });

  it.each(['x', 'y', 'scale', 'rotationDeg', 'opacity'] as const)(
    '%s kanalı geçişi kapatır (derleyicideki ClipAnimation.Any kümesi)',
    (channel) => {
      editClip(CLIP_A, (c) => {
        c.keyframes[channel] = [kf(0, channel === 'scale' ? 1 : 0)];
      });
      expect(clipHasVisualKeyframes(clipById(CLIP_A))).toBe(true);
      expect(addTransitionBlockReason(currentDoc(), CLIP_A, 'out')).toBe(
        REASON_TRANSITION_NEEDS_STATIC_CLIPS,
      );
    },
  );

  it('volume keyframe geçişi KAPATMAZ — ses zinciri xfade akışına girmez', () => {
    editClip(CLIP_A, (c) => {
      c.keyframes.volume = [kf(0, 1), kf(US, 0)];
    });
    expect(clipHasVisualKeyframes(clipById(CLIP_A))).toBe(false);
    expect(addTransitionBlockReason(currentDoc(), CLIP_A, 'out')).toBeNull();
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expectDocValid();
  });

  it('geçişli klipte GÖRSEL kanal açılamaz, volume açılabilir', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);

    for (const channel of ['x', 'y', 'scale', 'rotationDeg', 'opacity'] as const) {
      const reason = addKeyframeBlockReason(currentDoc(), CLIP_A, channel);
      expect(reason, `${channel} kapalı olmalı`).toBe(REASON_KEYFRAME_NEEDS_NO_TRANSITION);
      // ⟺
      expect(addKeyframe(CLIP_A, channel, 0)).toEqual({
        ok: false,
        reason: REASON_KEYFRAME_NEEDS_NO_TRANSITION,
      });
      expect(toggleKeyframe(CLIP_A, channel, 0).ok).toBe(false);
      expect(clipById(CLIP_A).keyframes[channel]).toBeUndefined();
    }

    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'volume')).toBeNull();
    expect(addKeyframe(CLIP_A, 'volume', 0).ok).toBe(true);
    expectDocValid();
  });

  it('kesimin ÖTE yanındaki klip (C) etkilenmez — kapı yalnız geçişli kliplere bakar', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(addKeyframeBlockReason(currentDoc(), CLIP_C, 'opacity')).toBeNull();
    expect(addKeyframe(CLIP_C, 'opacity', 0).ok).toBe(true);
  });

  it('ESKİ projeden gelen yasak bileşimden ÇIKIŞ yolu açık kalır (kaldır/temizle)', () => {
    // Kapı yokken kurulmuş bir doküman: hem geçiş hem keyframe. Geçişin iki
    // yarısı TEK yazımda kurulur (bkz. editClips): yarım yazılmış bir geçiş
    // simetri invariant'ını çiğner ve taahhüt kapısı belgeyi reddeder.
    editClips((find) => {
      const a = find(CLIP_A);
      a.keyframes.opacity = [kf(0, 1), kf(2 * US, 0)];
      a.transitionOut = { type: 'crossfade', durationUs: US };
      find(CLIP_B).transitionIn = { type: 'crossfade', durationUs: US };
    });

    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'opacity')).toBe(
      REASON_KEYFRAME_NEEDS_NO_TRANSITION,
    );
    // ...ama var olanı SİLMEK serbest, aksi halde kullanıcı çıkmazda kalırdı.
    expect(removeKeyframe(CLIP_A, 'opacity', 2 * US).ok).toBe(true);
    expect(clearChannel(CLIP_A, 'opacity').ok).toBe(true);
    expect(clipById(CLIP_A).keyframes.opacity).toBeUndefined();

    // Animasyon gitti ama GEÇİŞ duruyor: kanal hâlâ kapalı ve gerekçe artık
    // "bu klipte geçiş var"dır — kullanıcıya hangi tarafı çözeceğini söyler.
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'opacity')).toBe(
      REASON_KEYFRAME_NEEDS_NO_TRANSITION,
    );
    // Öbür yön de açıldı: keyframe kalmadığına göre geçiş artık meşru.
    expect(addTransitionBlockReason(currentDoc(), CLIP_A, 'out')).toBe('a transition is already here');
  });
});

// ---------------------------------------------------------------------------
// (b) scale-keyframes-with-rotation — ExportCompiler.cs:~1831
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (a2) transform-scale ara tuval tavanı — ExportCompiler.EnsureLayerCeiling
//
// Derleyicinin kapısı ÖLÇEK KUTUSUNU değil ARA TUVALİ ölçer: dönen katman
// köşegeni kadar kare bir tuval açar (LayerGeometry.Compute), merkez dışı çapa
// onu ayrıca pad'ler. Editörün ölçek tavanı bu dalgaya kadar dönmeyi hesaba
// katmıyordu — dönük klibe eski (dönmesiz) tavandan ölçek yazılabiliyor ve
// belge dışa aktarımda `transform-scale` (HTTP 422) ile geri dönüyordu.
// ---------------------------------------------------------------------------

describe('(a2) dönme ara tuvali büyütür — ölçek tavanı dönme farkındalıklı', () => {
  /** Derleyicinin kapı yüklemi, editör tarafındaki ikiziyle (invariants.ts). */
  function ledgerLongSide(clipId: string): number {
    const c = clipById(clipId);
    const { width, height } = currentDoc().settings;
    const rhu = (v: number): number => Math.floor(v + 0.5);
    return intermediateCanvasLongSidePx(
      rhu(width * c.transform.scale),
      rhu(height * c.transform.scale),
      c.transform,
    );
  }

  it('dönmesiz tavan değişmedi: 1080p ölçek 4.266 ya kelepçelenir', () => {
    const r = setClipTransform([CLIP_A], { scale: 9 });
    expect(r.ok).toBe(true);
    expect(clipById(CLIP_A).transform.scale).toBe(4.266);
    expect(ledgerLongSide(CLIP_A)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
  });

  it('dönük klipte ölçek YAZIMI köşegen tavanına kelepçelenir (1080p 45° -> 3.718)', () => {
    expect(setClipTransform([CLIP_A], { rotationDeg: 45 }).ok).toBe(true);
    const r = setClipTransform([CLIP_A], { scale: 4.2 });
    expect(r.ok).toBe(true);
    expect(clipById(CLIP_A).transform.scale).toBe(3.718);
    expect(ledgerLongSide(CLIP_A)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectDocValid();
  });

  it('dönme yazımı mevcut ölçeği tavanın üstünde bırakırsa ölçek İNER ve bu SÖYLENİR', () => {
    expect(setClipTransform([CLIP_A], { scale: 4.266 }).ok).toBe(true);
    const r = setClipTransform([CLIP_A], { rotationDeg: 45 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.notice).toBe(SCALE_CLAMPED_BY_ROTATION);
    expect(clipById(CLIP_A).transform.rotationDeg).toBe(45);
    expect(clipById(CLIP_A).transform.scale).toBe(3.718);
    expect(ledgerLongSide(CLIP_A)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectDocValid();
  });

  it('aynı patch te dönme + ölçek: ölçek YENİ (dönük) tavana göre kelepçelenir', () => {
    const r = setClipTransform([CLIP_A], { rotationDeg: 45, scale: 4.2 });
    expect(r.ok).toBe(true);
    expect(clipById(CLIP_A).transform.scale).toBe(3.718);
    expect(ledgerLongSide(CLIP_A)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
  });

  it('360 ın katları dönme sayılmaz: tavan dönmesiz kalır (derleyicideki % 360)', () => {
    expect(setClipTransform([CLIP_A], { rotationDeg: 360 }).ok).toBe(true);
    expect(setClipTransform([CLIP_A], { scale: 4.266 }).ok).toBe(true);
    expect(clipById(CLIP_A).transform.scale).toBe(4.266);
  });

  it('merkez dışı çapa tavanı ayrıca düşürür (çapa pad i — 90° + çapa(0,0) -> 1.859)', () => {
    editClip(CLIP_A, (c) => {
      c.transform.anchorX = 0;
      c.transform.anchorY = 0;
      c.transform.rotationDeg = 90;
    });
    expect(setClipTransform([CLIP_A], { scale: 3 }).ok).toBe(true);
    expect(clipById(CLIP_A).transform.scale).toBe(1.859);
    expect(ledgerLongSide(CLIP_A)).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
  });

  it('EDITÖR ARTIK ÜRETEMEZ: taranan her (ölçek, dönme) yazımı derleyici yüklemini tutar', () => {
    for (const rotationDeg of [0, 15, 45, 90, 179, 359]) {
      for (const scale of [0.5, 2, 4.266, 7, 10]) {
        load(threeAdjacent());
        const r = setClipTransform([CLIP_A], { rotationDeg, scale });
        expect(r.ok).toBe(true);
        expect(
          ledgerLongSide(CLIP_A),
          `rot=${rotationDeg} scale=${scale} -> yazılan ${clipById(CLIP_A).transform.scale}`,
        ).toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
        expectDocValid();
      }
    }
  });
});

describe('(b) ölçek animasyonu + dönme', () => {
  it('dönme 0 iken ölçek kanalı serbesttir', () => {
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'scale')).toBeNull();
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);
    expectDocValid();
  });

  it('taban dönme 0 DEĞİLKEN ölçek keyframe i açılamaz', () => {
    expect(setClipTransform([CLIP_A], { rotationDeg: 30 }).ok).toBe(true);
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'scale')).toBe(
      REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
    );
    // ⟺
    expect(addKeyframe(CLIP_A, 'scale', 0)).toEqual({
      ok: false,
      reason: REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
    });
    expect(clipById(CLIP_A).keyframes.scale).toBeUndefined();
  });

  it('360 nin katları dönme SAYILMAZ (derleyicideki % 360 kuralı birebir)', () => {
    expect(setClipTransform([CLIP_A], { rotationDeg: 360 }).ok).toBe(true);
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'scale')).toBeNull();
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);
  });

  it('dönme ANİMASYONLUYKEN de ölçek keyframe i açılamaz', () => {
    expect(addKeyframe(CLIP_A, 'rotationDeg', 0).ok).toBe(true);
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'scale')).toBe(
      REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
    );
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(false);
  });

  it('ölçek ANİMASYONLUYKEN dönme kanalı da kapanır (bileşimin öbür yönü)', () => {
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);
    expect(addKeyframeBlockReason(currentDoc(), CLIP_A, 'rotationDeg')).toBe(
      REASON_SCALE_KEYFRAMES_NEED_NO_ROTATION,
    );
    expect(addKeyframe(CLIP_A, 'rotationDeg', 0).ok).toBe(false);
  });

  it('ölçek ANİMASYONLUYKEN taban dönme YAZILAMAZ — panel alanı da bu gerekçeyle kilitlenir', () => {
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);

    expect(rotationBlockReason(currentDoc(), [CLIP_A])).toBe(REASON_ROTATION_NEEDS_STATIC_SCALE);
    // ⟺
    expect(setClipTransform([CLIP_A], { rotationDeg: 45 })).toEqual({
      ok: false,
      reason: REASON_ROTATION_NEEDS_STATIC_SCALE,
    });
    expect(clipById(CLIP_A).transform.rotationDeg).toBe(0);

    // Ret TÜM patch'i kapsar: yarısı yazılmış bir dönüşüm bırakmayız.
    expect(setClipTransform([CLIP_A], { x: 0.2, rotationDeg: 45 }).ok).toBe(false);
    expect(clipById(CLIP_A).transform.x).toBe(0);

    // Dönme DIŞINDAKİ alanlar etkilenmez.
    expect(setClipTransform([CLIP_A], { x: 0.2 }).ok).toBe(true);
    expect(clipById(CLIP_A).transform.x).toBe(0.2);
    expectDocValid();
  });

  it('GİZMO yolu (applyTransformPatchToDraft) da aynı reddi verir — sessiz "hiçbir şey olmadı" yok', () => {
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);
    let result: OpResult = { ok: true };
    useDocStore.getState().mutate('clipTransform', 'gizmo dönme', (d) => {
      result = applyTransformPatchToDraft(d, CLIP_A, { rotationDeg: 45 }, 0);
    });
    expect(result).toEqual({ ok: false, reason: REASON_ROTATION_NEEDS_STATIC_SCALE });
    expect(clipById(CLIP_A).transform.rotationDeg).toBe(0);

    // Aynı yolun dönme DIŞINDAKİ yarısı çalışmaya devam eder (kapı geniş değil).
    useDocStore.getState().mutate('clipTransform', 'gizmo taşıma', (d) => {
      result = applyTransformPatchToDraft(d, CLIP_A, { x: 0.1 }, 0);
    });
    expect(result.ok).toBe(true);
    expect(clipById(CLIP_A).transform.x).toBe(0.1);
  });

  it('ölçek animasyonu temizlenince dönme yeniden yazılabilir', () => {
    expect(addKeyframe(CLIP_A, 'scale', 0).ok).toBe(true);
    expect(rotationBlockReason(currentDoc(), [CLIP_A])).not.toBeNull();
    expect(clearChannel(CLIP_A, 'scale').ok).toBe(true);
    expect(rotationBlockReason(currentDoc(), [CLIP_A])).toBeNull();
    expect(setClipTransform([CLIP_A], { rotationDeg: 45 }).ok).toBe(true);
  });

  it('kapı SEÇİMDEKİ her klibe bakar — bir tanesi bile ölçek animasyonluysa kapanır', () => {
    expect(addKeyframe(CLIP_C, 'scale', 0).ok).toBe(true);
    expect(rotationBlockReason(currentDoc(), [CLIP_A, CLIP_C])).toBe(
      REASON_ROTATION_NEEDS_STATIC_SCALE,
    );
    expect(setClipTransform([CLIP_A, CLIP_C], { rotationDeg: 10 }).ok).toBe(false);
    expect(clipById(CLIP_A).transform.rotationDeg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) geçişli kliplerin yerleşimi — ENGEL değil YAYILIM
// ---------------------------------------------------------------------------

describe('(c) geçişli kliplerin yerleşimi aynı kalır', () => {
  it('geçiş yoksa komşu klibe DOKUNULMAZ', () => {
    expect(transitionChainSiblings(currentDoc(), CLIP_A)).toEqual([]);
    expect(setClipTransform([CLIP_A], { scale: 1.5 })).toEqual({ ok: true });
    expect(clipById(CLIP_B).transform.scale).toBe(1);
  });

  it('geçişli kesimde yerleşim İKİ klibe birden yazılır ve bu SESSİZ değildir', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(transitionChainSiblings(currentDoc(), CLIP_A)).toEqual([CLIP_B]);

    const result = setClipTransform([CLIP_A], { scale: 1.5, x: 0.25 });
    expect(result).toEqual({ ok: true, notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN });
    expect(clipById(CLIP_B).transform).toEqual(clipById(CLIP_A).transform);
    expect(clipById(CLIP_B).transform.scale).toBe(1.5);
    // Zincir DIŞINDAKİ klip yerinde durur.
    expect(clipById(CLIP_C).transform.scale).toBe(1);
    expectDocValid();
  });

  it('zincir GEÇİŞLİDİR: A—B—C zincirinde ortadaki klibi düzenlemek üçünü de eşitler', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(addTransition(CLIP_B, CLIP_C, 'crossfade', US).ok).toBe(true);
    expect(transitionChainSiblings(currentDoc(), CLIP_B).sort()).toEqual([CLIP_A, CLIP_C].sort());

    expect(setClipTransform([CLIP_B], { y: -0.3 }).ok).toBe(true);
    expect(clipById(CLIP_A).transform).toEqual(clipById(CLIP_B).transform);
    expect(clipById(CLIP_C).transform).toEqual(clipById(CLIP_B).transform);
    expectDocValid();
  });

  it('"Sıfırla" da zincire yayılır (yoksa sıfırlanan klip komşusundan ayrışırdı)', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(setClipTransform([CLIP_A], { scale: 2 }).ok).toBe(true);
    expect(clipById(CLIP_B).transform.scale).toBe(2);

    expect(resetClipTransform([CLIP_A])).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    expect(clipById(CLIP_A).transform).toEqual(DEFAULT_TRANSFORM);
    expect(clipById(CLIP_B).transform).toEqual(DEFAULT_TRANSFORM);
    expectDocValid();
  });

  it('geçiş kaldırılınca yayılım da biter', () => {
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(setClipTransform([CLIP_A], { scale: 1.5 }).ok).toBe(true);

    useDocStore.getState().mutate('test', 'geçişi kaldır', (d) => {
      const clips = d.tracks[0].clips as MediaClip[];
      delete clips[0].transitionOut;
      delete clips[1].transitionIn;
    });

    expect(setClipTransform([CLIP_A], { scale: 2 })).toEqual({ ok: true });
    expect(clipById(CLIP_B).transform.scale).toBe(1.5);
  });

  it('zaten eşit olan zincirde bildirim ÇIKMAZ (olmamış bir komşu düzenlemesi haber verilmez)', () => {
    // Yayılım "kopyaladım" değil "komşu GERÇEKTEN değişti" der. İki klip de
    // varsayılan dönüşümdeyken geçiş eklemek olağan haldir; burada bildirim
    // çıkarsa kullanıcı her geçiş ekleyişinde olmamış bir düzenleme okur.
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({ ok: true });
    expect(setClipTransform([CLIP_A], { scale: 1.5 })).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    // Aynı değeri bir kez daha yazmak komşuyu kımıldatmaz -> bildirim yok.
    expect(setClipTransform([CLIP_A], { scale: 1.5 })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// (c2) TERS SIRA: önce yerleşim, SONRA geçiş
//
// (c)'nin tamamı geçişi ÖNCE ekleyip yerleşimi SONRA yazıyordu; ters sıra hiç
// denenmemişti ve tam olarak orada açık vardı. Yayılım yalnız yerleşim YAZAN
// op'larda çağrılıyordu (setClipTransform / resetClipTransform), geçiş EKLEYEN
// op'ta çağrılmıyordu — oysa geçiş eklemek de bir yerleşim olayıdır: iki klip
// o an tek xfade akışına girer. Kullanıcı yolu tamamen normaldi (klibi böl ->
// gizmo/Inspector ile ölçekle -> kesim rozetinden geçiş ekle), kapı SESSİZ
// kalıyordu, PUT 200 / POST /exports 202 dönüyordu ve iş worker'da
// "geçişli kliplerin yerleşimi aynı olmalıdır" ile DÜŞÜYORDU.
// ---------------------------------------------------------------------------

describe('(c2) yerleşim ÖNCE yazıldıysa geçiş eklemek zinciri eşitler', () => {
  it('Inspector yolu: A ölçeklenip SONRA geçiş eklenirse B de eşitlenir', () => {
    // Geçiş YOKKEN ölçeklemek serbesttir ve komşuya dokunmaz (yayılacak zincir
    // yok) — hatanın ön koşulu tam olarak budur.
    expect(setClipTransform([CLIP_A], { scale: 2 })).toEqual({ ok: true });
    expect(clipById(CLIP_B).transform.scale).toBe(1);

    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    expect(clipById(CLIP_B).transform).toEqual(clipById(CLIP_A).transform);
    expect(clipById(CLIP_B).transform.scale).toBe(2);
    expectDocValid();
  });

  it('GİZMO yolu: sürüklemeyle yazılan yerleşim de geçiş eklenince eşitlenir', () => {
    // Gizmo doğrudan applyTransformPatchToDraft'a yazar (TransformGizmo.tsx
    // -> tx.update). Inspector'dan farklı bir giriş noktasıdır; kapı orada da
    // kapanmalı, yoksa "fareyle ölçekleyip geçiş ekle" yolu açık kalırdı.
    useDocStore.getState().mutate('clipTransform', 'gizmo ölçek', (d) => {
      expect(applyTransformPatchToDraft(d, CLIP_A, { scale: 1.75, x: 0.2 }, 0).ok).toBe(true);
    });
    expect(clipById(CLIP_B).transform.scale).toBe(1);

    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    expect(clipById(CLIP_B).transform).toEqual(clipById(CLIP_A).transform);
    expect(clipById(CLIP_B).transform.scale).toBe(1.75);
    expect(clipById(CLIP_B).transform.x).toBe(0.2);
    expectDocValid();
  });

  it('GELEN klip ölçeklenmişse de eşitlenir (fark hangi tarafta olursa olsun)', () => {
    expect(setClipTransform([CLIP_B], { scale: 2, y: -0.1 })).toEqual({ ok: true });

    const result = addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    expect(result).toEqual({ ok: true, notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN });
    // Zincir GİDEN klipten yayılır (kesimde her yerde kazanan taraf o), yani
    // burada eşitlenen B'dir; iddia edilen şey EŞİTLİK, kimin kazandığı değil.
    expect(clipById(CLIP_B).transform).toEqual(clipById(CLIP_A).transform);
    expectDocValid();
  });

  it('rozet yolu (addTransitionAtEdge, "in" kenarı) da eşitler', () => {
    // Kullanıcı kesim rozetine B'nin SOL kenarından basmış olabilir; op aynı
    // kesme çözülür ama giriş noktası farklıdır.
    expect(setClipTransform([CLIP_A], { rotationDeg: 45 })).toEqual({ ok: true });

    expect(addTransitionAtEdge(CLIP_B, 'in', 'crossfade', US)).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    expect(clipById(CLIP_B).transform).toEqual(clipById(CLIP_A).transform);
    expect(clipById(CLIP_B).transform.rotationDeg).toBe(45);
    expectDocValid();
  });

  it('ZİNCİRİ BÜYÜTMEK: A—B varken C eklenirse üçü birden eşitlenir', () => {
    expect(setClipTransform([CLIP_A], { scale: 2 }).ok).toBe(true);
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(clipById(CLIP_B).transform.scale).toBe(2);
    // C zincirin DIŞINDA: kendi yerleşimini serbestçe alır.
    expect(setClipTransform([CLIP_C], { scale: 3 })).toEqual({ ok: true });

    expect(addTransition(CLIP_B, CLIP_C, 'crossfade', US)).toEqual({
      ok: true,
      notice: TRANSFORM_APPLIED_TO_TRANSITION_CHAIN,
    });
    expect(clipById(CLIP_C).transform).toEqual(clipById(CLIP_B).transform);
    expect(clipById(CLIP_A).transform).toEqual(clipById(CLIP_B).transform);
    expect(clipById(CLIP_C).transform.scale).toBe(2);
    expectDocValid();
  });

  it('geçiş EKLENEMEDİĞİNDE komşunun yerleşimine dokunulmaz', () => {
    // Reddedilen bir op'un yan etkisi olamaz: kapı kapalıyken zincir de kurulmaz.
    editClip(CLIP_B, (c) => {
      c.keyframes.opacity = [kf(0, 1), kf(2 * US, 0)];
    });
    expect(setClipTransform([CLIP_A], { scale: 2 }).ok).toBe(true);

    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US)).toEqual({
      ok: false,
      reason: REASON_TRANSITION_NEEDS_STATIC_CLIPS,
    });
    expect(clipById(CLIP_B).transform.scale, 'Ret, komşuyu ELLEMEMELİ.').toBe(1);
    expectDocValid();
  });

  it('YENİDEN BİTİŞEN kesim: ripple silme geçişi taşıdığında yerleşim de taşınır', () => {
    // Geçiş metadata'sı yeni bir kesime "miras" kalabilir: A—B geçişliyken B
    // ripple ile silinince A'nın transitionOut'u BAMBAŞKA bir klibin (C)
    // karşısına düşer ve reconcile onu benimser (giden taraf kazanır). O iki
    // klibin yerleşimi hiçbir zaman eşit olmak zorunda DEĞİLDİ — yani bu, aynı
    // sözleşme ihlaline giden İKİNCİ yol.
    expect(addTransition(CLIP_A, CLIP_B, 'crossfade', US).ok).toBe(true);
    expect(setClipTransform([CLIP_C], { scale: 3 }).ok).toBe(true);

    const result = deleteClips([CLIP_B], { ripple: true });
    expect(result.ok).toBe(true);

    const a = clipById(CLIP_A);
    const c = clipById(CLIP_C);
    expect(clipEndUs(a), 'Ripple silme A|C kesimini bitiştirmeliydi (ön koşul).').toBe(
      c.timelineStartUs,
    );
    expect(a.transitionOut, 'Geçiş yeni kesime taşındı (ön koşul).').toBeDefined();
    expect(c.transitionIn).toBeDefined();
    expect(c.transform, 'Devralınan kesimde yerleşim de eşitlenmeli.').toEqual(a.transform);
    expect(result.ok && result.notice).toBe(TRANSFORM_APPLIED_TO_TRANSITION_CHAIN);
    expectDocValid();
  });

  it('doküman KAPISI ayrışmayı yakalar — yeni bir yol açılırsa yazımda patlar', () => {
    // Yayılım bir DÜZELTME'dir; invariant ise KANIT. Bu ikisi ayrı olmalı:
    // yarın geçiş metadata'sı yazan yeni bir yol eklenir ve yayılımı çağırmayı
    // unutursa, hata dışa aktarımda değil TAM O YAZIMDA görünsün.
    expect(setClipTransform([CLIP_A], { scale: 2 }).ok).toBe(true);
    expect(() => {
      editClips((find) => {
        find(CLIP_A).transitionOut = { type: 'crossfade', durationUs: US };
        find(CLIP_B).transitionIn = { type: 'crossfade', durationUs: US };
      });
    }).toThrow(/transition placement violated/);
  });
});

// ---------------------------------------------------------------------------
// Sözleşme: blockReason === null  ⟺  op.ok  (kanal x klip matrisi)
// ---------------------------------------------------------------------------

describe('blockReason ile op sonucu hiçbir durumda ayrışmaz', () => {
  interface Case {
    name: string;
    setup(): void;
  }

  const cases: Case[] = [
    { name: 'temiz doküman', setup: () => {} },
    {
      name: 'A—B geçişli',
      setup: () => void addTransition(CLIP_A, CLIP_B, 'crossfade', US),
    },
    {
      name: 'A dönük (30°)',
      setup: () => void setClipTransform([CLIP_A], { rotationDeg: 30 }),
    },
    {
      name: 'A ölçek animasyonlu',
      setup: () => void addKeyframe(CLIP_A, 'scale', 0),
    },
    {
      name: 'A dönme animasyonlu',
      setup: () => void addKeyframe(CLIP_A, 'rotationDeg', 0),
    },
    {
      name: 'A opaklık animasyonlu',
      setup: () => void addKeyframe(CLIP_A, 'opacity', 0),
    },
    {
      name: 'track kilitli',
      setup: () => {
        useDocStore.getState().mutate('test', 'kilitle', (d) => {
          d.tracks[0].locked = true;
        });
      },
    },
  ];

  it.each(cases)('$name — keyframe EKLEME kapısı', ({ setup }) => {
    setup();
    for (const channel of KEYFRAME_CHANNELS as readonly KeyframeChannel[]) {
      for (const clipId of [CLIP_A, CLIP_B, CLIP_C]) {
        const reason = addKeyframeBlockReason(currentDoc(), clipId, channel);
        // Zamanı 3 sn: her klip 6 sn, yani hepsinin İÇİNDE bir an.
        const result = addKeyframe(clipId, channel, 3 * US);
        expect(result.ok, `${clipId}/${channel}: reason=${String(reason)}`).toBe(reason === null);
        if (!result.ok) expect(result.reason).toBe(reason);
      }
    }
    expectDocValid();
  });

  it.each(cases)('$name — geçiş EKLEME kapısı', ({ setup }) => {
    setup();
    for (const clipId of [CLIP_A, CLIP_B, CLIP_C]) {
      for (const edge of ['in', 'out'] as const) {
        const reason = addTransitionBlockReason(currentDoc(), clipId, edge);
        const cutBefore = clipById(clipId);
        const hasCut =
          edge === 'out' ? clipId !== CLIP_C : clipId !== CLIP_A;
        if (!hasCut) {
          expect(reason).not.toBeNull();
          continue;
        }
        const [aId, bId] =
          edge === 'out'
            ? [clipId, clipId === CLIP_A ? CLIP_B : CLIP_C]
            : [clipId === CLIP_B ? CLIP_A : CLIP_B, clipId];
        const result = addTransition(aId, bId, 'crossfade', US);
        expect(
          result.ok,
          `${clipId}/${edge}: reason=${String(reason)} (${String(cutBefore.id)})`,
        ).toBe(reason === null);
        if (!result.ok) expect(result.reason).toBe(reason);
        expectDocValid();
      }
    }
  });

  it('channelBlockReason ile addKeyframeBlockReason aynı kuralı söyler', () => {
    addTransition(CLIP_A, CLIP_B, 'crossfade', US);
    setClipTransform([CLIP_C], { rotationDeg: 30 });
    for (const channel of KEYFRAME_CHANNELS as readonly KeyframeChannel[]) {
      for (const clipId of [CLIP_A, CLIP_B, CLIP_C]) {
        expect(channelBlockReason(clipById(clipId), channel)).toBe(
          addKeyframeBlockReason(currentDoc(), clipId, channel),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (d) AV bağı (ozellik-2): linkClips/unlinkClips — aynı ayrışmazlık sözleşmesi
// ---------------------------------------------------------------------------

describe('(d) AV bağı: linkBlockReason/unlinkBlockReason ile op ayrışmaz', () => {
  const A_TRACK = '01890000-0000-7000-8000-000000000901';
  const AUD_CLIP = '01890000-0000-7000-8000-000000000902';
  const LINK_ID = '01890000-0000-7000-8000-000000000903';

  /** V1 [A, B, C] (threeAdjacent) + ses track'i [tek ses klibi 0..6 sn]. */
  function withAudioLane(over?: { locked?: boolean; linkAWithAudio?: boolean }): TimelineDoc {
    const d = threeAdjacent();
    const aud: MediaClip = {
      ...mediaClip({ id: AUD_CLIP, startUs: 0, sourceInUs: 0, sourceOutUs: 6 * US }),
      kind: 'audio',
    };
    if (over?.linkAWithAudio === true) {
      aud.linkId = LINK_ID;
      (d.tracks[0].clips[0] as MediaClip).linkId = LINK_ID;
    }
    d.tracks.push({
      id: A_TRACK,
      type: 'audio',
      muted: false,
      hidden: false,
      locked: over?.locked === true,
      clips: [aud],
    });
    return d;
  }

  interface LinkCase {
    name: string;
    doc(): TimelineDoc;
    selection: string[];
    /** Beklenen ret kodu (null = op kabul etmeli). */
    link: string | null;
    unlink: string | null;
  }

  const cases: LinkCase[] = [
    {
      name: 'video + ses serbest -> bağla kabul, kaldır ret',
      doc: () => withAudioLane(),
      selection: [CLIP_A, AUD_CLIP],
      link: null,
      unlink: 'no linked clip in selection',
    },
    {
      name: 'iki video -> çift şekli tutmuyor',
      doc: () => withAudioLane(),
      selection: [CLIP_A, CLIP_B],
      link: 'select a video and an audio clip to link',
      unlink: 'no linked clip in selection',
    },
    {
      name: 'bağlı çiftin tek yarısı -> bağla "zaten bağlı", kaldır kabul',
      doc: () => withAudioLane({ linkAWithAudio: true }),
      selection: [CLIP_A],
      link: 'clip is already linked',
      unlink: null,
    },
    {
      name: 'kilitli ses track\'inde bağlı çift -> bağla "zaten bağlı", kaldır kilidi söyler',
      doc: () => withAudioLane({ locked: true, linkAWithAudio: true }),
      selection: [CLIP_A, AUD_CLIP],
      // Ret sırası: çift şekli -> zaten bağlı -> grup -> kilit. Bağlı çiftte
      // "zaten bağlı" kilitten önce konuşur (çözüm yolu unlink'tir, o da
      // kilidi ayrıca söyleyecek).
      link: 'clip is already linked',
      unlink: 'track is locked',
    },
    {
      name: 'kilitli ses track\'i, bağsız klipler -> bağla da kilidi söyler',
      doc: () => withAudioLane({ locked: true }),
      selection: [CLIP_A, AUD_CLIP],
      link: 'track is locked',
      unlink: 'no linked clip in selection',
    },
  ];

  it.each(cases)('$name', ({ doc, selection, link, unlink }) => {
    // linkClips yarısı.
    load(doc());
    const linkReason = linkBlockReason(currentDoc(), selection);
    const linkResult = linkClips(selection);
    expect(linkResult.ok, `link: reason=${String(linkReason)}`).toBe(linkReason === null);
    if (!linkResult.ok) expect(linkResult.reason).toBe(linkReason);
    expect(linkReason).toBe(link);
    expectDocValid();

    // unlinkClips yarısı (taze doküman — link yarısı zemin kaydırmasın).
    load(doc());
    const unlinkReason = unlinkBlockReason(currentDoc(), selection);
    const unlinkResult = unlinkClips(selection);
    expect(unlinkResult.ok, `unlink: reason=${String(unlinkReason)}`).toBe(unlinkReason === null);
    if (!unlinkResult.ok) expect(unlinkResult.reason).toBe(unlinkReason);
    expect(unlinkReason).toBe(unlink);
    expectDocValid();
  });
});
