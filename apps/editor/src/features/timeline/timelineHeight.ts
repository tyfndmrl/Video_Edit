/**
 * timelineHeight — timeline satırının yüksekliği (sürüklenerek değiştirilir,
 * TARAYICIDA kalıcı; kullanıcı kararı 2026-09-02).
 *
 * ÜÇ ALAN, İKİ FARKLI ÖMÜR — bu ayrım bu modülün asıl sözleşmesidir:
 *  - `preferredPx`  KULLANICI NİYETİ. Yalnız tutamağı sürüklerken/klavyeyle
 *    değiştirdiğinde yazılır ve localStorage'a KOMMİT ANINDA kaydedilir.
 *  - `headerPx`     ÖLÇÜLEN panel başlığı yüksekliği (efemeral). Alt sınır
 *    buna bağlıdır: başlık + bir tam track satırı + yeni-track bölgesi HER
 *    ZAMAN görünür kalmalı.
 *  - `availablePx`  Grid'in oynatıcı+timeline'a bıraktığı yükseklik (efemeral;
 *    null = henüz ölçülmedi). Üst sınır buna bağlıdır.
 *
 * Pencere küçülünce EFEKTİF yükseklik kelepçelenir ama `preferredPx`e
 * DOKUNULMAZ: küçük bir pencerede geçen bir oturum, kullanıcının kalıcı
 * tercihini yok etmemelidir (pencere büyüyünce tercih geri gelir).
 *
 * Belgeye YAZILMAZ (kullanıcı kararı): yükseklik bir görünüm tercihidir,
 * timeline dokümanının parçası değildir — projeyi başka bir makinede açan
 * kullanıcı kendi ekranının tercihini görür.
 */
import { create } from 'zustand';
import { browserStorage } from '../../lib/browserStorage';
import { NEW_TRACK_ZONE_H, RULER_H, TRACK_GAP, TRACK_H } from './geometry';

/**
 * Depolama boşken kullanılan yükseklik. Bugünkü grid satırının (280px)
 * BİREBİR aynısı: özellik gelmeden önceki görünüm ve mevcut e2e zemini
 * değişmesin.
 */
export const DEFAULT_TIMELINE_H = 280;

/**
 * Timeline en fazla büyüdüğünde oynatıcıya kalan pay (kullanıcı kararı
 * 2026-09-02: "oynatıcıya ≥160 px bırak"). Oynatıcı hücresi sıfıra
 * inemez — sahne kaybolursa önizleme diye bir şey kalmaz.
 */
export const MIN_PLAYER_H = 160;

/**
 * Kullanılabilir alan HENÜZ ÖLÇÜLMEMİŞKEN (availablePx = null) üst sınır.
 * Ölçüm bir layout efektinde hemen gelir; bu yalnız o ilk karede sonsuz/absürt
 * bir değerin sızmasını engeller.
 */
export const SANE_MAX_TIMELINE_H = 4000;

/** localStorage anahtarı (v1 — şekli değişirse yeni anahtar, sessiz göç yok). */
export const TIMELINE_HEIGHT_STORAGE_KEY = 'videoedit.timelineHeight.v1';

export interface TimelineHeightState {
  /** Kullanıcı niyeti (kalıcı). */
  preferredPx: number;
  /** Ölçülen panel başlığı yüksekliği (efemeral). */
  headerPx: number;
  /** Grid'in oynatıcı+timeline'a bıraktığı yükseklik; null = ölçülmedi. */
  availablePx: number | null;
}

// ---------------------------------------------------------------------------
// Saf kelepçe
// ---------------------------------------------------------------------------

/**
 * En küçük yükseklik: panel başlığı + cetvel + BİR tam track satırı +
 * yeni-track bölgesi. Sabitler geometry'den gelir (ikinci bir düzen
 * aritmetiği yok): kullanıcı ne kadar küçültürse küçültsün bir satır ve
 * "buraya bırak" bölgesi erişilebilir kalır.
 */
export function minTimelineHeight(headerPx: number): number {
  const header = Number.isFinite(headerPx) ? Math.max(0, Math.round(headerPx)) : 0;
  return header + RULER_H + TRACK_H + TRACK_GAP + NEW_TRACK_ZONE_H;
}

/**
 * En büyük yükseklik: kullanılabilir alandan oynatıcı payı düşülür. Alan çok
 * darsa alt sınır kazanır (aralık ters dönmez); alan ölçülmemişse yalnız
 * makul bir tavan uygulanır.
 */
export function maxTimelineHeight(headerPx: number, availablePx: number | null): number {
  const min = minTimelineHeight(headerPx);
  if (availablePx === null || !Number.isFinite(availablePx)) {
    return Math.max(min, SANE_MAX_TIMELINE_H);
  }
  return Math.max(min, availablePx - MIN_PLAYER_H);
}

/**
 * Efektif yükseklik: niyet + ölçümler -> ekrana yazılan piksel.
 *
 * Son adım `min(availablePx)`: alt sınır kullanılabilir alandan büyük olduğu
 * (pencere absürt kısa) durumda bile grid satırı alanı AŞAMAZ — aşsaydı
 * oynatıcı hücresi negatife düşer, düzen kayardı.
 */
export function clampTimelineHeight(state: TimelineHeightState): number {
  const preferred = Number.isFinite(state.preferredPx) ? state.preferredPx : DEFAULT_TIMELINE_H;
  const min = minTimelineHeight(state.headerPx);
  const max = maxTimelineHeight(state.headerPx, state.availablePx);
  const clamped = Math.min(max, Math.max(min, preferred));
  if (state.availablePx === null || !Number.isFinite(state.availablePx)) return clamped;
  return Math.min(clamped, Math.max(0, state.availablePx));
}

// ---------------------------------------------------------------------------
// localStorage (fontCatalogue.ts'teki browserStorage() sarmalayıcısının aynısı)
// ---------------------------------------------------------------------------


/**
 * Kayıtlı yükseklik ya da null. Bozuk/aralık dışı değer YOK SAYILIR: eksi,
 * NaN, absürt büyük ya da bir satırı bile gösteremeyecek kadar küçük bir
 * değer varsayılana döner (sessizce düzeltilmiş yanlış bir düzen yerine
 * bilinen iyi düzen).
 */
export function readStoredTimelineHeight(): number | null {
  const store = browserStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return null;
    // Alt sınır başlık ölçüsünden bağımsız MUTLAK taban (headerPx = 0 hâli);
    // gerçek kelepçe ölçüm gelince clampTimelineHeight'te uygulanır.
    if (value < minTimelineHeight(0) || value > SANE_MAX_TIMELINE_H) return null;
    return value;
  } catch {
    // Erişilemeyen depolama / bozuk kayıt — varsayılan yükseklik taşır.
    return null;
  }
}

/** Kullanıcı niyetini kaydeder. Yalnız KOMMİT anında çağrılır. */
export function writeStoredTimelineHeight(px: number): void {
  if (!Number.isFinite(px)) return;
  try {
    browserStorage()?.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(Math.round(px)));
  } catch {
    // Kota / gizli mod: kalıcılık bir kolaylıktır, sözleşme değil.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTimelineHeightStore = create<TimelineHeightState>()(() => ({
  // Depolama TEK KEZ, store kurulurken okunur: her render'da senkron I/O yok.
  preferredPx: readStoredTimelineHeight() ?? DEFAULT_TIMELINE_H,
  headerPx: 0,
  availablePx: null,
}));

/** Efektif yükseklik (px) — selector PRİMİTİF döndürür (zustand v5). */
export const selectTimelineHeightPx = (s: TimelineHeightState): number => clampTimelineHeight(s);
export const selectTimelineMinPx = (s: TimelineHeightState): number => minTimelineHeight(s.headerPx);
export const selectTimelineMaxPx = (s: TimelineHeightState): number =>
  maxTimelineHeight(s.headerPx, s.availablePx);

/** Ölçülen panel başlığı yüksekliği (ResizeObserver). */
export function setTimelineHeaderPx(px: number): void {
  const next = Number.isFinite(px) ? Math.max(0, px) : 0;
  if (useTimelineHeightStore.getState().headerPx === next) return;
  useTimelineHeightStore.setState({ headerPx: next });
}

/** Grid'in oynatıcı+timeline'a bıraktığı yükseklik (ResizeObserver). */
export function setTimelineAvailablePx(px: number | null): void {
  const next = px === null || !Number.isFinite(px) ? null : Math.max(0, px);
  if (useTimelineHeightStore.getState().availablePx === next) return;
  useTimelineHeightStore.setState({ availablePx: next });
}

/**
 * Kullanıcı niyetini yazar.
 *
 * `persist` YALNIZ commit anında (bırakma / klavye adımı) true olur:
 * sürükleme sırasında her karede senkron localStorage yazmak jesti
 * yavaşlatırdı. Çağıran taraf değeri o anki [min, max] aralığına oturtur —
 * niyet, kullanıcının GÖRDÜĞÜ yüksekliktir; pencere kelepçesi ise burayı
 * hiç yazmaz (tercih korunur).
 */
export function setPreferredTimelineHeight(px: number, options: { persist: boolean }): void {
  if (!Number.isFinite(px)) return;
  if (useTimelineHeightStore.getState().preferredPx !== px) {
    useTimelineHeightStore.setState({ preferredPx: px });
  }
  if (options.persist) writeStoredTimelineHeight(px);
}
