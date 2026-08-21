/**
 * LUT (.cube) klip op'ları — rendering-semantics §4.2.
 *
 * İki iddia sınıfı:
 *  1. yazılan efekt invariant kural 6'nın lut dalına BİREBİR uyar
 *     ({assetId, intensity} — yabancı anahtar yok, aralık [0,1]) ve her vaka
 *     PAYLAŞILAN şemayla yeniden doğrulanır (422'ye dönüşemez);
 *  2. önizleme çözücüsü (lutOf) yazılan efekti export'un okuyacağı şekliyle
 *     okur (teklik, enabled, intensity 0'ın "efekt yok"a çökmesi).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  validateTimelineDoc,
  type Clip,
  type MediaClip,
  type TimelineDoc,
  type Track,
} from '@videoedit/timeline-schema';
import { createEmptyDoc, defaultProjectSettings, useDocStore } from './docStore';
import { useAssetStore } from './assetStore';
import { lutOf } from '../features/player/core/resolve';
import {
  LUT_DEDUPED,
  LUT_DEFAULT_INTENSITY,
  knownAssetDurations,
  lutEffectOf,
  removeClipLut,
  setClipLut,
  setClipLutEnabled,
  setClipLutIntensity,
} from './timelineOps';

const US = 1_000_000;
const PROJECT_ID = '01890000-0000-7000-8000-000000000001';
const ASSET_A = '01890000-0000-7000-8000-00000000000a';
const LUT_ASSET = '01890000-0000-7000-8000-00000000000b';
const LUT_ASSET_2 = '01890000-0000-7000-8000-00000000000c';
const V1 = '01890000-0000-7000-8000-000000000101';
const A1 = '01890000-0000-7000-8000-000000000102';
const CLIP_A = '01890000-0000-7000-8000-000000000201';
const CLIP_B = '01890000-0000-7000-8000-000000000202';
const EFFECT_1 = '01890000-0000-7000-8000-000000000301';
const EFFECT_2 = '01890000-0000-7000-8000-000000000302';

function videoClip(
  id: string,
  startUs: number,
  durationUs: number,
  overrides: Partial<MediaClip> = {},
): MediaClip {
  return {
    id,
    kind: 'video',
    assetId: ASSET_A,
    timelineStartUs: startUs,
    timelineDurationUs: durationUs,
    sourceInUs: 0,
    sourceOutUs: durationUs,
    speed: { rate: 1 },
    audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
    keyframes: {},
    effects: [],
    opacity: 1,
    ...overrides,
  };
}

function audioClip(id: string, startUs: number, durationUs: number): MediaClip {
  return { ...videoClip(id, startUs, durationUs), kind: 'audio' };
}

function track(id: string, type: Track['type'], clips: Clip[], flags: Partial<Track> = {}): Track {
  return { id, type, muted: false, hidden: false, locked: false, clips, ...flags };
}

function load(tracks: Track[]): void {
  useDocStore
    .getState()
    .loadDoc({ ...createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }), tracks });
}

function currentDoc(): TimelineDoc {
  return useDocStore.getState().doc;
}

function findClip(id: string): Clip {
  for (const t of currentDoc().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  throw new Error(`clip ${id} not found`);
}

function expectValid(): void {
  const result = validateTimelineDoc(currentDoc(), knownAssetDurations());
  expect(result.success, JSON.stringify(!result.success ? result.error.issues : null)).toBe(true);
}

function historyLength(): number {
  return useDocStore.getState().history.length;
}

beforeEach(() => {
  useDocStore.getState().loadDoc(createEmptyDoc(PROJECT_ID, { ...defaultProjectSettings }));
  useAssetStore.getState().setAssets([
    { id: ASSET_A, kind: 'video', name: 'a.mp4', status: 'ready', durationUs: 60 * US },
    { id: LUT_ASSET, kind: 'lut', name: 'teal.cube', status: 'ready' },
    { id: LUT_ASSET_2, kind: 'lut', name: 'warm.cube', status: 'ready' },
  ]);
});

describe('setClipLut — efekt yazımı (invariant kural 6 lut dalı)', () => {
  it('writes exactly {assetId, intensity} with default intensity 1, enabled', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipLut([CLIP_A], LUT_ASSET)).toEqual({ ok: true });

    const effect = lutEffectOf(findClip(CLIP_A));
    expect(effect).not.toBeNull();
    expect(effect!.type).toBe('lut');
    expect(effect!.enabled).toBe(true);
    expect(effect!.params).toEqual({ assetId: LUT_ASSET, intensity: LUT_DEFAULT_INTENSITY });
    expect(historyLength()).toBe(1);
    expectValid();
  });

  it('re-selecting another .cube swaps assetId but KEEPS the tuned intensity', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);
    setClipLutIntensity([CLIP_A], 0.4);

    expect(setClipLut([CLIP_A], LUT_ASSET_2).ok).toBe(true);

    expect(lutEffectOf(findClip(CLIP_A))!.params).toEqual({ assetId: LUT_ASSET_2, intensity: 0.4 });
    expectValid();
  });

  it('refuses a non-lut asset and a non-ready lut (the export would 422 later)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipLut([CLIP_A], ASSET_A).ok).toBe(false);

    useAssetStore.getState().updateAsset(LUT_ASSET, { status: 'processing' });
    expect(setClipLut([CLIP_A], LUT_ASSET).ok).toBe(false);
    expect(lutEffectOf(findClip(CLIP_A))).toBeNull();
    expect(historyLength()).toBe(0);
  });

  it('skips audio clips (nothing is drawn) and locked tracks', () => {
    load([
      track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)], { locked: true }),
      track(A1, 'audio', [audioClip(CLIP_B, 0, 10 * US)]),
    ]);

    expect(setClipLut([CLIP_A, CLIP_B], LUT_ASSET).ok).toBe(false);
    expect(lutEffectOf(findClip(CLIP_A))).toBeNull();
    expect(lutEffectOf(findClip(CLIP_B))).toBeNull();
  });

  it('normalizes duplicate lut effects down to the FIRST one (preview shows that one)', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          effects: [
            { id: EFFECT_1, type: 'lut', enabled: true, params: { assetId: LUT_ASSET, intensity: 0.9 } },
            { id: EFFECT_2, type: 'lut', enabled: true, params: { assetId: LUT_ASSET_2, intensity: 0.1 } },
          ],
        }),
      ]),
    ]);

    const result = setClipLutIntensity([CLIP_A], 0.5);
    expect(result).toEqual({ ok: true, notice: LUT_DEDUPED });

    const clip = findClip(CLIP_A);
    expect(clip.effects.filter((e) => e.type === 'lut')).toHaveLength(1);
    expect(lutEffectOf(clip)!.id).toBe(EFFECT_1);
    expect(lutEffectOf(clip)!.params).toEqual({ assetId: LUT_ASSET, intensity: 0.5 });
    expectValid();
  });
});

describe('setClipLutIntensity — [0,1] kelepçesi ve yalnız-mevcut-efekt kuralı', () => {
  it('clamps into [0,1] and rounds to 3 decimals', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);

    setClipLutIntensity([CLIP_A], 1.7);
    expect(lutEffectOf(findClip(CLIP_A))!.params.intensity).toBe(1);
    setClipLutIntensity([CLIP_A], -0.4);
    expect(lutEffectOf(findClip(CLIP_A))!.params.intensity).toBe(0);
    setClipLutIntensity([CLIP_A], 0.123456);
    expect(lutEffectOf(findClip(CLIP_A))!.params.intensity).toBe(0.123);
    expectValid();
  });

  it('cannot conjure an effect out of intensity alone (no assetId to point at)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);

    expect(setClipLutIntensity([CLIP_A], 0.5).ok).toBe(false);
    expect(lutEffectOf(findClip(CLIP_A))).toBeNull();
    expect(historyLength()).toBe(0);
  });

  it('touching the slider on a DISABLED lut re-enables it (visible result rule)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);
    setClipLutEnabled([CLIP_A], false);
    expect(lutEffectOf(findClip(CLIP_A))!.enabled).toBe(false);

    setClipLutIntensity([CLIP_A], 0.6);
    expect(lutEffectOf(findClip(CLIP_A))!.enabled).toBe(true);
    expectValid();
  });
});

describe('setClipLutEnabled / removeClipLut', () => {
  it('toggling off KEEPS the params (the user is comparing, not discarding)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);
    setClipLutIntensity([CLIP_A], 0.7);

    expect(setClipLutEnabled([CLIP_A], false)).toEqual({ ok: true });
    const effect = lutEffectOf(findClip(CLIP_A))!;
    expect(effect.enabled).toBe(false);
    expect(effect.params).toEqual({ assetId: LUT_ASSET, intensity: 0.7 });
    expectValid();
  });

  it('enabling with NO effect present fails (a lut has no identity value)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    expect(setClipLutEnabled([CLIP_A], true).ok).toBe(false);
    expect(historyLength()).toBe(0);
  });

  it('removeClipLut deletes the effect entirely and leaves other effects alone', () => {
    load([
      track(V1, 'video', [
        videoClip(CLIP_A, 0, 10 * US, {
          effects: [
            {
              id: EFFECT_1,
              type: 'colorAdjust',
              enabled: true,
              params: { brightness: 0.2, contrast: 0, saturation: 0, temperature: 0, tint: 0, exposure: 0 },
            },
            { id: EFFECT_2, type: 'lut', enabled: true, params: { assetId: LUT_ASSET, intensity: 1 } },
          ],
        }),
      ]),
    ]);

    expect(removeClipLut([CLIP_A])).toEqual({ ok: true });
    const clip = findClip(CLIP_A);
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0].type).toBe('colorAdjust');
    expectValid();
  });
});

describe('lutOf — önizleme çözücüsünün okuduğu şekil', () => {
  it('reads the first ENABLED lut with its intensity', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);
    setClipLutIntensity([CLIP_A], 0.75);

    expect(lutOf(findClip(CLIP_A))).toEqual({ assetId: LUT_ASSET, intensity: 0.75 });
  });

  it('returns null for disabled, removed, or zero-intensity luts (compiler parity)', () => {
    load([track(V1, 'video', [videoClip(CLIP_A, 0, 10 * US)])]);
    setClipLut([CLIP_A], LUT_ASSET);

    setClipLutEnabled([CLIP_A], false);
    expect(lutOf(findClip(CLIP_A))).toBeNull();

    setClipLutEnabled([CLIP_A], true);
    setClipLutIntensity([CLIP_A], 0);
    // intensity 0: derleyici filtre üretmez (§4.2) — önizleme de LUT'suz çizer.
    expect(lutOf(findClip(CLIP_A))).toBeNull();

    setClipLutIntensity([CLIP_A], 1);
    removeClipLut([CLIP_A]);
    expect(lutOf(findClip(CLIP_A))).toBeNull();
  });
});
