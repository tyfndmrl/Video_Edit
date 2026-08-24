/**
 * assetStore — asset metadata cache + upload/processing status.
 *
 * NOT subject to undo and NOT autosaved. Populated from the API (react-query)
 * and from upload progress events. Skeleton for M0; upload wiring lands in M1.
 */
import { create } from 'zustand';
import type { MicroSec, Uuid } from '@videoedit/timeline-schema';

/** Server-side asset state machine (05-chief-architect-review.md §1.d):
 *  uploading -> uploaded -> processing -> ready | failed
 *  ("expired" is represented as failed + errorCode 'expired'.) */
export type AssetStatus = 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';

/** 'lut' = .cube renk tablosu — medya değildir: klip olamaz, yalnız lut efektinin kaynağıdır. */
export type AssetKind = 'video' | 'audio' | 'image' | 'lut';

export interface AssetSummary {
  id: Uuid;
  kind: AssetKind;
  name: string;
  status: AssetStatus;
  /** 0..1, meaningful while uploading/processing. */
  progress?: number;
  durationUs?: MicroSec;
  width?: number;
  height?: number;
  /**
   * Kaynak dosyada ses akışı var mı (worker ffprobe olgusu; API yalnız READY
   * satırda döner). ÜÇ değerli okunur: true = ses var, false = KESİN yok
   * (sessiz video), undefined = henüz bilinmiyor. Ret kuralları yalnız kesin
   * `false` üzerinde engel kurar (`detachAudioBlockReason`) — bilinmeyeni
   * engellemek export'un kendi kapısıyla çelişen yanlış retler üretirdi.
   */
  hasAudio?: boolean;
  /** Presigned URLs (batch media-urls endpoint), present once status === 'ready'. */
  proxyUrl?: string;
  posterUrl?: string;
  /**
   * Orijinal dosyanın presigned URL'i. Önizlemenin .cube okuyucusu için gerekli:
   * bir LUT varlığının TÜREVİ yoktur (worker üretmez), shader ham .cube metnini
   * bu adresten çeker (engineV1 LUT dokusu yükleyicisi).
   */
  originalUrl?: string;
  /** First filmstrip sprite (single-sprite fallback when `sprites` is absent). */
  filmstripUrl?: string;
  filmstripManifestUrl?: string;
  waveformUrl?: string;
  /** Filmstrip sprite file name -> presigned URL (matches manifest sprites[]). */
  sprites?: Record<string, string>;
  /** Set when status === 'failed' (e.g. 'expired', 'probe_failed'). */
  errorCode?: string;
}

export interface AssetStore {
  assets: Map<Uuid, AssetSummary>;

  upsertAsset(asset: AssetSummary): void;
  updateAsset(id: Uuid, patch: Partial<Omit<AssetSummary, 'id'>>): void;
  removeAsset(id: Uuid): void;
  setAssets(assets: Iterable<AssetSummary>): void;
  getAsset(id: Uuid): AssetSummary | undefined;
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
  assets: new Map<Uuid, AssetSummary>(),

  upsertAsset: (asset) =>
    set((s) => {
      const next = new Map(s.assets);
      next.set(asset.id, asset);
      return { assets: next };
    }),
  updateAsset: (id, patch) =>
    set((s) => {
      const current = s.assets.get(id);
      if (!current) return s;
      const next = new Map(s.assets);
      next.set(id, { ...current, ...patch });
      return { assets: next };
    }),
  removeAsset: (id) =>
    set((s) => {
      if (!s.assets.has(id)) return s;
      const next = new Map(s.assets);
      next.delete(id);
      return { assets: next };
    }),
  setAssets: (assets) =>
    set(() => {
      const next = new Map<Uuid, AssetSummary>();
      for (const a of assets) next.set(a.id, a);
      return { assets: next };
    }),
  getAsset: (id) => get().assets.get(id),
}));
