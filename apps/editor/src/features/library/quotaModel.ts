/**
 * quotaModel — kitaplık başlığındaki kota göstergesinin SAF modeli.
 *
 * Sözleşme: gösterge, upload reddiyle AYNI sayıyı konuşur (GET /api/quota,
 * InitUpload'ın kota sorgusuyla birebir aynı tanım: silinmemiş tüm asset'ler).
 * Renk eşiği burada tektir — bileşen yalnız boyar.
 */
import type { QuotaSummaryDto } from '../../entities/assets';
import { formatBytes } from './format';

/** %90 ve üzeri uyarı, %100 ve üzeri dolu (yeni yükleme reddedilir). */
export const QUOTA_WARN_PERCENT = 90;

export type QuotaLevel = 'ok' | 'warn' | 'full';

export interface QuotaView {
  /** Yüzde, tam sayıya yuvarlanmış (0..∞ — 100'ün üstü de gösterilir). */
  percent: number;
  /** İlerleme çubuğu genişliği için 0..100 aralığına kırpılmış yüzde. */
  barPercent: number;
  level: QuotaLevel;
  /** "1,2 GB / 20 GB" */
  usedLabel: string;
  /** Ekran okuyucu ve tooltip metni. */
  title: string;
  /** Kalan bayt (negatif olmaz). */
  remainingBytes: number;
}

export function quotaView(quota: QuotaSummaryDto): QuotaView {
  const max = Number.isFinite(quota.maxBytes) && quota.maxBytes > 0 ? quota.maxBytes : 0;
  const used = Number.isFinite(quota.usedBytes) && quota.usedBytes > 0 ? quota.usedBytes : 0;
  const ratio = max > 0 ? used / max : 0;
  const percent = Math.round(ratio * 100);
  const level: QuotaLevel = ratio >= 1 ? 'full' : percent >= QUOTA_WARN_PERCENT ? 'warn' : 'ok';
  const remainingBytes = Math.max(0, max - used);

  return {
    percent,
    barPercent: Math.max(0, Math.min(100, percent)),
    level,
    usedLabel: `${formatBytes(used)} / ${formatBytes(max)}`,
    title:
      level === 'full'
        ? `Depolama kotası dolu (${formatBytes(used)} / ${formatBytes(max)}). ` +
          'Yeni yükleme için kullanılmayan medyayı silin.'
        : `Depolama: ${formatBytes(used)} / ${formatBytes(max)} kullanıldı ` +
          `(${quota.assetCount} medya, ${formatBytes(remainingBytes)} boş).`,
    remainingBytes,
  };
}
