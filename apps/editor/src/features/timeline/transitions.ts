/**
 * transitions — geçiş UI'ının SAF modeli.
 *
 * Burada doküman mutasyonu YOKTUR: tip listesi/etiketleri, süre alanının
 * biçimlendirme-ayrıştırma çifti ve "hangi kesim kastediliyor?" kararı.
 * Mutasyonlar state/timelineOps.ts'teki geçiş op'larında; menü ve rozet aynı
 * kenar seçimini kullansın diye o karar TEK yerde (`resolveTransitionEdge`)
 * durur — menü bir kesimi gösterip op'un başka bir kesimi değiştirmesi
 * kullanıcı için "yanlış yere uyguladı" demektir.
 */
import type { MicroSec, TimelineDoc, TransitionType, Uuid } from '@videoedit/timeline-schema';
import {
  findTransitionCut,
  transitionAt,
  type TransitionEdge,
} from '../../state/timelineOps';

export interface TransitionTypeOption {
  type: TransitionType;
  label: string;
}

/**
 * Şemadaki `TransitionType` kümesinin TAMAMI, ffmpeg xfade karşılıklarıyla
 * aynı sırada (rendering-semantics §5.3 tablosu). Yeni bir tip şemaya
 * eklendiğinde bu liste derlenmez hale gelir (Record<TransitionType, string>
 * üzerinden türetildiği için) — sessizce eksik kalmaz.
 */
const TYPE_LABELS: Record<TransitionType, string> = {
  crossfade: 'Çapraz geçiş',
  fadeToBlack: 'Siyaha geçiş',
  wipeLeft: 'Sola silme',
  wipeRight: 'Sağa silme',
  slideUp: 'Yukarı kaydırma',
  dissolve: 'Erime',
};

export const TRANSITION_TYPE_OPTIONS: readonly TransitionTypeOption[] = (
  Object.keys(TYPE_LABELS) as TransitionType[]
).map((type) => ({ type, label: TYPE_LABELS[type] }));

/** Yeni eklenen geçişin varsayılan tipi (en yaygın kesim yumuşatması). */
export const DEFAULT_TRANSITION_TYPE: TransitionType = 'crossfade';

export function transitionTypeLabel(type: TransitionType): string {
  return TYPE_LABELS[type];
}

/** Kesim kenarının Türkçe adı (menü etiketleri, rozet ipucu). */
export function transitionEdgeLabel(edge: TransitionEdge): string {
  return edge === 'in' ? 'sol kesim' : 'sağ kesim';
}

/**
 * Menünün/rozetin üzerinde çalışacağı kesim.
 *
 * `timeUs` verilmişse (sağ tık noktasının zamanı) klibin İKİ kenarından
 * tıklanan yere YAKIN olanı seçilir — kullanıcı kesime yakın sağ tıkladığında
 * kastettiği kesim odur. Verilmemişse `prefer` sırası uygulanır.
 *
 * `require`:
 *  - 'cut'        -> yalnız gerçek bir kesim olan kenarlar (geçiş EKLEME)
 *  - 'transition' -> yalnız üzerinde geçiş OLAN kenarlar (geçiş KALDIRMA)
 *
 * Uygun kenar yoksa `prefer` sırasının ilki döner: blok gerekçesini op'un
 * kendi kuralı üretsin diye (menü "yok" demez, op'un gerekçesini gösterir).
 */
export function resolveTransitionEdge(
  d: TimelineDoc,
  clipId: Uuid,
  options: { timeUs?: MicroSec; require: 'cut' | 'transition' } = { require: 'cut' },
): TransitionEdge {
  const candidates = (['in', 'out'] as const).filter((edge) => {
    const cut = findTransitionCut(d, clipId, edge);
    if (cut === null) return false;
    return options.require === 'cut' || transitionAt(cut) !== undefined;
  });
  if (candidates.length === 0) return 'out';
  if (candidates.length === 1) return candidates[0];

  // İki kenar da uygun: tıklanan zamana yakın olan kazanır.
  const timeUs = options.timeUs;
  if (timeUs === undefined) return 'out';
  const cut = findTransitionCut(d, clipId, 'in');
  const clip = cut?.b;
  if (!clip) return 'out';
  const distanceToIn = Math.abs(timeUs - clip.timelineStartUs);
  const distanceToOut = Math.abs(clip.timelineStartUs + clip.timelineDurationUs - timeUs);
  return distanceToIn <= distanceToOut ? 'in' : 'out';
}

// ---------------------------------------------------------------------------
// Süre alanı (saniye <-> mikrosaniye)
// ---------------------------------------------------------------------------

/** Süre alanında gösterilen saniye metni (3 ondalık — 1 frame @1000fps'e kadar). */
export function formatTransitionSeconds(durationUs: MicroSec): string {
  return (durationUs / 1_000_000).toFixed(3);
}

/**
 * Süre alanının metnini mikrosaniyeye çevirir. Geçersiz/negatif girdi null
 * döner (op çağrılmaz — alan kırmızıya döner). Üst sınır op'un kendi kapağıdır;
 * burada kelepçelemek kullanıcıya "yazdığım sayı tutmadı" hissi verirdi ve
 * kısaltma bildirimini de bastırırdı.
 */
export function parseTransitionSeconds(text: string): MicroSec | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1_000_000);
}
