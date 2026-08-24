/**
 * assetUsage — "bu medya nerede kullanılıyor?" yanıtının kullanıcı metni.
 *
 * Silme onayının TEK ayrımı budur: kullanılmayan medya sıradan bir onayla,
 * kullanılan medya klip sayısını söyleyen bir UYARIYLA silinir. Sayıların
 * cümleye dönüşmesi saf ve test edilebilir kalsın diye burada durur.
 *
 * Cümle varlık TÜRÜNE göre seçilir (denetim bulgusu): medya klibin
 * KAYNAĞIDIR — silinince klip gerçekten bozulur; LUT ise klibe uygulanmış bir
 * EFEKTTİR — silinince klip bozulmaz, renk tablosu düşer ve dışa aktarma
 * 'asset-missing' ile reddedilir. Medya diliyle yazılmış tek cümle LUT için
 * yanlış bir vaatti.
 */
import type { AssetKindDto, AssetUsageDto } from '../../entities/assets';

export interface AssetUsageSummary {
  used: boolean;
  projectCount: number;
  clipCount: number;
  /** Kullanılıyorsa uyarı cümlesi, kullanılmıyorsa null. */
  warning: string | null;
  /** "A projesi (3 klip)" satırları — dialogda listelenir. */
  projectLines: string[];
}

export function summarizeAssetUsage(usage: AssetUsageDto, kind?: AssetKindDto): AssetUsageSummary {
  const projects = usage.projects.filter((p) => p.clipCount > 0);
  const clipCount = projects.reduce((sum, p) => sum + p.clipCount, 0);
  const projectCount = projects.length;

  const warning =
    projectCount === 0
      ? null
      : kind === 'lut'
        ? `Bu renk tablosu ${projectCount} projede ${clipCount} klipte kullanılıyor — ` +
          'silinirse LUT efekti o kliplerden düşer ve dışa aktarma reddedilir.'
        : `Bu medya ${projectCount} projede ${clipCount} klipte kullanılıyor — ` +
          'silinirse o klipler bozulur.';

  return {
    used: projectCount > 0,
    projectCount,
    clipCount,
    warning,
    projectLines: projects.map((p) => `${p.name} (${p.clipCount} klip)`),
  };
}
