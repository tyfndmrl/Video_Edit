/**
 * assetUsage — silme onayının metni. Sayılar KLİP bazında toplanır: "2 projede
 * 5 klipte" cümlesindeki 5, kullanıcının bozulacak blok sayısıdır.
 */
import { describe, expect, it } from 'vitest';
import { summarizeAssetUsage } from './assetUsage';

describe('summarizeAssetUsage', () => {
  it('kullanılmayan medya için uyarı YOKTUR', () => {
    const summary = summarizeAssetUsage({ projects: [] });
    expect(summary.used).toBe(false);
    expect(summary.warning).toBeNull();
    expect(summary.clipCount).toBe(0);
    expect(summary.projectLines).toEqual([]);
  });

  it('proje ve klip sayılarını toplar', () => {
    const summary = summarizeAssetUsage({
      projects: [
        { id: 'p1', name: 'Tanıtım', clipCount: 3 },
        { id: 'p2', name: 'Vlog', clipCount: 2 },
      ],
    });
    expect(summary.used).toBe(true);
    expect(summary.projectCount).toBe(2);
    expect(summary.clipCount).toBe(5);
    expect(summary.warning).toBe(
      'Bu medya 2 projede 5 klipte kullanılıyor — silinirse o klipler bozulur.',
    );
    expect(summary.projectLines).toEqual(['Tanıtım (3 klip)', 'Vlog (2 klip)']);
  });

  it('tek proje tek klip', () => {
    const summary = summarizeAssetUsage({ projects: [{ id: 'p1', name: 'Deneme', clipCount: 1 }] });
    expect(summary.warning).toBe(
      'Bu medya 1 projede 1 klipte kullanılıyor — silinirse o klipler bozulur.',
    );
  });

  it('clipCount 0 gelen proje sayılmaz (sunucu filtrelemese bile)', () => {
    const summary = summarizeAssetUsage({
      projects: [
        { id: 'p1', name: 'Boş', clipCount: 0 },
        { id: 'p2', name: 'Dolu', clipCount: 2 },
      ],
    });
    expect(summary.projectCount).toBe(1);
    expect(summary.clipCount).toBe(2);
    expect(summary.projectLines).toEqual(['Dolu (2 klip)']);
  });
});
