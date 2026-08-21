/**
 * Inspector-side op feedback (M5).
 *
 * Why this is not in features/timeline/feedback.ts: speed and colour are
 * reachable ONLY from this panel, and the panel shows its message inline (next
 * to the control that was refused) rather than in the timeline's bubble. The
 * shared table is still the first stop — a code both surfaces know must have
 * ONE translation, not two that drift.
 *
 * If the timeline ever grows a speed control (context menu, clip badge), move
 * these rows into features/timeline/feedback.ts and delete the local table.
 */
import { opFailureMessage, opNoticeMessage } from '../timeline/feedback';

/** Codes produced by the M5 ops (state/timelineOps: speed + colorAdjust). */
const M5_REASONS: Record<string, string> = {
  'invalid speed': 'Geçersiz hız değeri',
  'speed leaves less than one frame': 'Bu hızda klip bir kareden kısa kalıyor',
  'speed change overlaps the next clip':
    'Bu hızda klip sonraki klibe giriyor — "Sonrakileri kaydır" ile deneyin',
  'no video/audio clip in selection': 'Hız yalnız video/ses kliplerine uygulanır',
  'no visual clip in selection': 'Bu ayar yalnız görüntülenen kliplere uygulanır',
  'no audio clip in selection': 'Seçimde sesi olan klip yok',
  'before timeline start': 'Zaman çizelgesinin başından öncesine taşınamaz',
  // LUT bölümü (yalnız Inspector'dan ulaşılır).
  'no clip with a lut in selection': "Seçimde LUT'u olan klip yok",
  'not a ready lut asset': 'Seçilen dosya hazır bir LUT (.cube) değil',
};

const M5_NOTICES: Record<string, string> = {
  'keyframes merged by speed change':
    'Yeni süreye sığmayan keyframe’ler aynı ana denk geldi ve birleştirildi',
  'speed duration snapped to the frame grid':
    'Klip süresi tam kareye oturtuldu — bu hızda en yakın uygulanabilir uzunluk seçildi',
  'duplicate colorAdjust effects merged':
    'Klipte birden fazla renk düzeltme efekti vardı — ilki korundu',
  'duplicate lut effects merged': 'Klipte birden fazla LUT efekti vardı — ilki korundu',
};

/** OpResult.reason -> Turkish sentence (falls back to the shared table). */
export function inspectorFailureMessage(reason: string | null | undefined): string {
  if (!reason) return 'İşlem uygulanamadı';
  return M5_REASONS[reason] ?? opFailureMessage(reason);
}

/** OpResult.notice -> Turkish sentence, or null when there is nothing to say. */
export function inspectorNoticeMessage(notice: string | null | undefined): string | null {
  if (!notice) return null;
  return M5_NOTICES[notice] ?? opNoticeMessage(notice);
}
