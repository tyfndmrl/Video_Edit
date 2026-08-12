/**
 * missingMedia — "bu klibin medyası artık YOK" bilgisinin tek kaynağı.
 *
 * Sorun: assetStore yalnız BİLİNEN asset'leri tutar; bir asset silindiğinde
 * kliplerin `assetId`'si dokümanda kalır (silme, timeline'ı DEĞİŞTİRMEZ —
 * kullanıcının dokümanına sunucu dokunmaz). Bu klipleri "eksik medya" diye
 * boyayabilmek için "haritada yok" yetmez: proje ilk açıldığında harita da
 * boştur ve her klip yanlışlıkla eksik görünürdü.
 *
 * Çözüm: sunucu asset listesi bir kez TAM olarak görüldüğünde (sayfalama
 * yoksa) o listedeki id'ler "bilinen" olarak damgalanır. Eksiklik iddiası
 * ANCAK bu damga varken kurulur. Damga proje bazlıdır; proje değişince düşer.
 *
 * Sahiplik: damgayı LibraryPanel'in asset yoklaması besler (adoptServerAssetList),
 * silme akışı tek bir asset'i düşürür (forgetAsset). Tüketiciler: timeline
 * boyayıcısı (render/drawTracks) ve Inspector uyarısı (MissingMediaNotice).
 */
import { create } from 'zustand';
import { useAssetStore, type AssetSummary } from '../../state/assetStore';

export interface AssetPresenceState {
  /** Tam listesi görülmüş projenin id'si; null = iddia kurulamaz (bilinmiyor). */
  syncedProjectId: string | null;
  /** O listede yer alan asset id'leri. */
  knownIds: ReadonlySet<string>;
}

export const useAssetPresence = create<AssetPresenceState>()(() => ({
  syncedProjectId: null,
  knownIds: new Set<string>(),
}));

/**
 * SAF karar: verilen presence damgası altında bu assetId eksik mi?
 *
 * - damga yoksa (syncedProjectId === null) ASLA eksik denmez,
 * - harita biliyorsa eksik değildir (yükleme sırasındaki yerel kayıtlar dahil),
 * - damga varsa ve id ne haritada ne listede ise: silinmiştir.
 */
export function isMissingAsset(
  assetId: string,
  assets: ReadonlyMap<string, AssetSummary>,
  presence: AssetPresenceState,
): boolean {
  if (presence.syncedProjectId === null) return false;
  if (assets.has(assetId)) return false;
  return !presence.knownIds.has(assetId);
}

/** Store'ları okuyan ince sarmalayıcı (boyayıcı ve bileşenler bunu çağırır). */
export function isAssetMissing(
  assetId: string,
  assets: ReadonlyMap<string, AssetSummary>,
): boolean {
  return isMissingAsset(assetId, assets, useAssetPresence.getState());
}

/**
 * Sunucu asset listesini presence damgası olarak benimser.
 *
 * `complete` false ise (liste sayfalanmış, tamamı elde değil) damga DÜŞÜRÜLÜR:
 * eksik bilgiyle "medya silinmiş" demek, ikinci sayfadaki her asset'i yalancı
 * kırmızıya boyamak olurdu.
 *
 * Aynı projenin ÖNCEKİ listesinde olup şimdi olmayan id'ler gerçekten
 * silinmiştir — assetStore'dan da düşürülürler (yoklama silinen medyayı
 * sonsuza kadar taşımasın).
 */
export function adoptServerAssetList(
  projectId: string,
  ids: readonly string[],
  complete: boolean,
): void {
  const previous = useAssetPresence.getState();
  if (!complete) {
    if (previous.syncedProjectId !== null) {
      useAssetPresence.setState({ syncedProjectId: null, knownIds: new Set<string>() });
    }
    return;
  }

  const knownIds = new Set(ids);
  const sameProject = previous.syncedProjectId === projectId;
  useAssetPresence.setState({ syncedProjectId: projectId, knownIds });

  const store = useAssetStore.getState();
  let removedAny = false;
  if (sameProject) {
    for (const id of previous.knownIds) {
      if (!knownIds.has(id) && store.assets.has(id)) {
        store.removeAsset(id);
        removedAny = true;
      }
    }
  }

  // Damganın İLK kez kurulduğu an: harita hiç değişmemiş olabilir (ör. tüm
  // medyası silinmiş bir proje), ama "eksik" kararı artık kurulabiliyor.
  // Timeline boyayıcısı assets haritasının KİMLİĞİNE abone olduğu için
  // haritayı kimliksel olarak tazeleyip yeniden çizim tetiklenir.
  if (!removedAny && !sameProject) {
    useAssetStore.setState((s) => ({ assets: new Map(s.assets) }));
  }
}

/** Silme sonrası: asset hem haritadan hem damgadan düşer (anında "eksik"). */
export function forgetAsset(assetId: string): void {
  const presence = useAssetPresence.getState();
  if (presence.knownIds.has(assetId)) {
    const knownIds = new Set(presence.knownIds);
    knownIds.delete(assetId);
    useAssetPresence.setState({ knownIds });
  }
  useAssetStore.getState().removeAsset(assetId);
}

/** Proje değişimi/kapanışı: damga başka bir projenin listesiyle konuşamaz. */
export function resetAssetPresence(): void {
  useAssetPresence.setState({ syncedProjectId: null, knownIds: new Set<string>() });
}
