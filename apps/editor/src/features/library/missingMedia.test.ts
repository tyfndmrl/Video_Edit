/**
 * missingMedia — "medya silinmiş" kararının kuralları.
 *
 * Buradaki asıl tehlike YALANCI KIRMIZI: proje ilk açıldığında asset haritası
 * henüz boştur ve naif bir "haritada yok -> eksik" kuralı BÜTÜN klipleri
 * bozuk gösterirdi. Testler o yanlışı ve sayfalama/proje değişimi gibi
 * "listeyi tam bilmiyoruz" durumlarını çivilemek için var.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAssetStore, type AssetSummary } from '../../state/assetStore';
import {
  adoptServerAssetList,
  forgetAsset,
  isAssetMissing,
  isMissingAsset,
  resetAssetPresence,
  useAssetPresence,
} from './missingMedia';

const P1 = '01890000-0000-7000-8000-0000000000p1';
const P2 = '01890000-0000-7000-8000-0000000000p2';
const A1 = '01890000-0000-7000-8000-00000000000a';
const A2 = '01890000-0000-7000-8000-00000000000b';
const A3 = '01890000-0000-7000-8000-00000000000c';

function asset(id: string): AssetSummary {
  return { id, kind: 'video', name: `${id}.mp4`, status: 'ready' };
}

beforeEach(() => {
  useAssetStore.getState().setAssets([]);
  resetAssetPresence();
});

describe('isMissingAsset (saf karar)', () => {
  const empty = new Map<string, AssetSummary>();

  it('damga YOKKEN hiçbir asset eksik sayılmaz (proje açılışındaki boş harita)', () => {
    expect(isMissingAsset(A1, empty, { syncedProjectId: null, knownIds: new Set() })).toBe(false);
  });

  it('damga varken listede olmayan asset eksiktir', () => {
    expect(
      isMissingAsset(A1, empty, { syncedProjectId: P1, knownIds: new Set([A2]) }),
    ).toBe(true);
  });

  it('listedeki asset eksik değildir', () => {
    expect(
      isMissingAsset(A1, empty, { syncedProjectId: P1, knownIds: new Set([A1]) }),
    ).toBe(false);
  });

  it('harita biliyorsa (yüklenmekte olan yerel kayıt) eksik değildir', () => {
    const assets = new Map([[A1, asset(A1)]]);
    expect(isMissingAsset(A1, assets, { syncedProjectId: P1, knownIds: new Set() })).toBe(false);
  });
});

describe('adoptServerAssetList', () => {
  it('tam liste damgayı kurar ve eksiklik kararını açar', () => {
    adoptServerAssetList(P1, [A1], true);
    expect(useAssetPresence.getState().syncedProjectId).toBe(P1);
    expect(isAssetMissing(A2, new Map())).toBe(true);
    expect(isAssetMissing(A1, new Map())).toBe(false);
  });

  it('SAYFALANMIŞ liste damgayı kurmaz — ikinci sayfadaki asset\'ler yalancı kırmızı olmaz', () => {
    adoptServerAssetList(P1, [A1], false);
    expect(useAssetPresence.getState().syncedProjectId).toBeNull();
    expect(isAssetMissing(A3, new Map())).toBe(false);
  });

  it('sayfalanmış liste ÖNCEKİ damgayı da düşürür (bilgi artık eksik)', () => {
    adoptServerAssetList(P1, [A1, A2], true);
    expect(isAssetMissing(A3, new Map())).toBe(true);
    adoptServerAssetList(P1, [A1], false);
    expect(isAssetMissing(A3, new Map())).toBe(false);
  });

  it('aynı projede listeden düşen asset store\'dan da silinir', () => {
    useAssetStore.getState().setAssets([asset(A1), asset(A2)]);
    adoptServerAssetList(P1, [A1, A2], true);
    adoptServerAssetList(P1, [A1], true); // A2 sunucuda silindi

    expect(useAssetStore.getState().assets.has(A2)).toBe(false);
    expect(useAssetStore.getState().assets.has(A1)).toBe(true);
    expect(isAssetMissing(A2, useAssetStore.getState().assets)).toBe(true);
  });

  it('PROJE DEĞİŞİMİNDE eski projenin asset\'leri silinmez (liste karşılaştırması yapılmaz)', () => {
    useAssetStore.getState().setAssets([asset(A1)]);
    adoptServerAssetList(P1, [A1], true);
    adoptServerAssetList(P2, [A2], true);
    expect(useAssetStore.getState().assets.has(A1)).toBe(true);
  });

  it('damga ilk kez kurulduğunda assets haritası KİMLİK olarak tazelenir (yeniden çizim)', () => {
    // Timeline boyayıcısı haritanın kimliğine abonedir: hiçbir kayıt değişmese
    // bile "artık eksiklik kararı verebiliyorum" anı ekrana yansımalı.
    const before = useAssetStore.getState().assets;
    adoptServerAssetList(P1, [], true);
    expect(useAssetStore.getState().assets).not.toBe(before);
  });
});

describe('forgetAsset', () => {
  it('silinen asset hem haritadan hem damgadan düşer — anında eksik olur', () => {
    useAssetStore.getState().setAssets([asset(A1), asset(A2)]);
    adoptServerAssetList(P1, [A1, A2], true);

    forgetAsset(A2);

    expect(useAssetStore.getState().assets.has(A2)).toBe(false);
    expect(useAssetPresence.getState().knownIds.has(A2)).toBe(false);
    expect(isAssetMissing(A2, useAssetStore.getState().assets)).toBe(true);
    expect(isAssetMissing(A1, useAssetStore.getState().assets)).toBe(false);
  });
});

describe('resetAssetPresence', () => {
  it('damgayı düşürür (proje kapanışı) — eksiklik iddiası durur', () => {
    adoptServerAssetList(P1, [A1], true);
    expect(isAssetMissing(A2, new Map())).toBe(true);
    resetAssetPresence();
    expect(isAssetMissing(A2, new Map())).toBe(false);
  });
});
