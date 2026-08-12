/**
 * assetUsage — "bu medya nerede kullanılıyor?" yanıtının kullanıcı metni.
 *
 * Silme onayının TEK ayrımı budur: kullanılmayan medya sıradan bir onayla,
 * kullanılan medya klip sayısını söyleyen bir UYARIYLA silinir. Sayıların
 * cümleye dönüşmesi saf ve test edilebilir kalsın diye burada durur.
 */
import type { AssetUsageDto } from '../../entities/assets';

export interface AssetUsageSummary {
  used: boolean;
  projectCount: number;
  clipCount: number;
  /** Kullanılıyorsa uyarı cümlesi, kullanılmıyorsa null. */
  warning: string | null;
  /** "A projesi (3 klip)" satırları — dialogda listelenir. */
  projectLines: string[];
}

export function summarizeAssetUsage(usage: AssetUsageDto): AssetUsageSummary {
  const projects = usage.projects.filter((p) => p.clipCount > 0);
  const clipCount = projects.reduce((sum, p) => sum + p.clipCount, 0);
  const projectCount = projects.length;

  return {
    used: projectCount > 0,
    projectCount,
    clipCount,
    warning:
      projectCount === 0
        ? null
        : `Bu medya ${projectCount} projede ${clipCount} klipte kullanılıyor — ` +
          'silinirse o klipler bozulur.',
    projectLines: projects.map((p) => `${p.name} (${p.clipCount} klip)`),
  };
}
