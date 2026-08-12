/**
 * quotaModel — gösterge sayısı ve uyarı eşiği.
 *
 * Eşik davranışı kritik: %90 uyarıyı AÇAR, %100 "dolu"dur (sunucu artık
 * reddeder). Bir de sıfıra bölme yolu: maxBytes 0/eksik gelirse gösterge
 * NaN yazmamalı.
 */
import { describe, expect, it } from 'vitest';
import { quotaView } from './quotaModel';

function quota(usedBytes: number, maxBytes: number, assetCount = 3) {
  return { usedBytes, maxBytes, assetCount, maxConcurrentUploads: 5 };
}

describe('quotaView', () => {
  it('yüzde ve etiketi hesaplar', () => {
    const view = quotaView(quota(512 * 1024 * 1024, 1024 * 1024 * 1024));
    expect(view.percent).toBe(50);
    expect(view.level).toBe('ok');
    expect(view.usedLabel).toBe('512 MB / 1.00 GB');
    expect(view.remainingBytes).toBe(512 * 1024 * 1024);
  });

  it('%90 uyarı eşiğidir (89 değil)', () => {
    expect(quotaView(quota(89, 100)).level).toBe('ok');
    expect(quotaView(quota(90, 100)).level).toBe('warn');
    expect(quotaView(quota(99, 100)).level).toBe('warn');
  });

  it('kota dolduğunda "full" ve metin ne yapılacağını söyler', () => {
    const view = quotaView(quota(100, 100));
    expect(view.level).toBe('full');
    expect(view.percent).toBe(100);
    expect(view.remainingBytes).toBe(0);
    expect(view.title).toContain('dolu');
    expect(view.title).toContain('silin');
  });

  it('kotanın üstünde yüzde gerçeği söyler, çubuk 100\'de kalır', () => {
    const view = quotaView(quota(150, 100));
    expect(view.percent).toBe(150);
    expect(view.barPercent).toBe(100);
    expect(view.level).toBe('full');
  });

  it('maxBytes 0/negatifken NaN üretmez', () => {
    const view = quotaView(quota(1000, 0));
    expect(view.percent).toBe(0);
    expect(view.barPercent).toBe(0);
    expect(view.level).toBe('ok');
    expect(Number.isNaN(view.percent)).toBe(false);
  });

  it('negatif/bozuk kullanım sıfır sayılır', () => {
    const view = quotaView(quota(-5, 100));
    expect(view.percent).toBe(0);
    expect(view.remainingBytes).toBe(100);
  });
});
