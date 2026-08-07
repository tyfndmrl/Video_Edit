/**
 * autoFit — "proje açılışında görünümü içeriğe sığdır" kararı.
 *
 * KÖK NEDEN (kullanıcı şikayeti): varsayılan pxPerUs = 0.0001 ile ekranda
 * yalnız ilk ~5 saniye görünür. 60. saniyedeki klipler x≈6000px'te kaldığı
 * için proje açılınca BOŞ bir timeline görünür ve "hiçbir şey çalışmıyor"
 * izlenimi doğar. Proje ilk kez hazır olduğunda görünüm içeriğe sığdırılır.
 *
 * Karar SAF tutulur (store/DOM yok) ki iki hassas kural test edilebilsin:
 * 1. Kullanıcının kendi zoom'u EZİLMEZ — sığdırma proje oturumu başına yalnız
 *    BİR kez uygulanır ('alreadyApplied' -> skip), sonraki doküman
 *    değişimlerinde tekrarlanmaz.
 * 2. Canvas henüz ölçülmemişse (genişlik 0) karar 'wait' olur; çağıran ilk
 *    ölçüm/ResizeObserver geri çağrısından sonra tekrar sorar. Böylece 800px
 *    gibi uydurma bir genişlikle yanlış zoom'a kilitlenilmez (yarış yok).
 */
import type { MicroSec } from '@videoedit/timeline-schema';
import type { ProjectSessionStatus } from '../../state/projectSession';
import { fitPxPerUs } from './geometry';

export interface AutoFitInput {
  /** projectSession durumu — yalnız 'ready' iken sığdırma düşünülür. */
  sessionStatus: ProjectSessionStatus;
  /** projectEndUs(doc): içerik sonu; 0 => boş proje. */
  contentEndUs: MicroSec;
  /** Ölçülmüş canvas genişliği (px). 0 => henüz ölçülmedi. */
  viewportWidthPx: number;
  /** Bu proje oturumunda sığdırma zaten uygulandı mı? */
  alreadyApplied: boolean;
}

export type AutoFitDecision =
  /** Görünümü içeriğe sığdır. */
  | { kind: 'fit'; pxPerUs: number; scrollUs: MicroSec }
  /** Boş proje: varsayılan zoom kalsın (ama iş bitti, tekrar denenmesin). */
  | { kind: 'keep-default' }
  /** Canvas henüz ölçülmedi: ölçümden sonra tekrar sor. */
  | { kind: 'wait' }
  /** Yapılacak bir şey yok (hazır değil ya da zaten uygulandı). */
  | { kind: 'skip' };

export function decideAutoFit(input: AutoFitInput): AutoFitDecision {
  if (input.sessionStatus !== 'ready') return { kind: 'skip' };
  if (input.alreadyApplied) return { kind: 'skip' };
  if (!(input.contentEndUs > 0)) return { kind: 'keep-default' };
  if (!(input.viewportWidthPx > 0)) return { kind: 'wait' };
  return {
    kind: 'fit',
    pxPerUs: fitPxPerUs(input.viewportWidthPx, input.contentEndUs),
    scrollUs: 0,
  };
}

/**
 * Karar bu proje oturumu için otomatik sığdırmayı kapatıyor mu?
 * (Çağıran bunu 'alreadyApplied' bayrağına yazar.)
 */
export function autoFitSettled(decision: AutoFitDecision): boolean {
  return decision.kind === 'fit' || decision.kind === 'keep-default';
}
