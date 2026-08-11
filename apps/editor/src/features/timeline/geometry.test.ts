/**
 * geometry — zaman<->piksel dönüşümü ve track satır düzeni.
 *
 * NEDEN BU DOSYA VAR (M4 denetimi, yüksek bulgu): `xToTime` ve `trackIndexAtY`
 * hiçbir testle PİNLENMEMİŞTİ. İkisi de pointer yolunun ilk adımı:
 * `xToTime` yanlışsa her sürükleme/kırpma yanlış zamana yazar, `trackIndexAtY`
 * yanlışsa klipler yanlış katmana düşer. Her ikisi de E2E'de "yön" testleriyle
 * yakalanmaz (yanlış ama aynı yönde bir sonuç yine "arttı" der), bu yüzden
 * sınır değerleri burada birebir sabitlenir.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PX_PER_US,
  MIN_PX_PER_US,
  NEW_TRACK_ZONE_H,
  RULER_H,
  SNAP_THRESHOLD_PX,
  TRACK_GAP,
  TRACK_H,
  TRIM_HANDLE_W,
  clampPxPerUs,
  fitPxPerUs,
  timeToX,
  trackIndexAtY,
  trackTop,
  tracksContentHeight,
  visibleRangeUs,
  xToTime,
} from './geometry';

const US = 1_000_000;
const ROW = TRACK_H + TRACK_GAP;

describe('sabitler', () => {
  it('düzen sabitleri beklenen değerlerde (canvas çizimi + E2E harness aynı sayıları kullanır)', () => {
    expect(RULER_H).toBe(28);
    expect(TRACK_H).toBe(56);
    expect(TRACK_GAP).toBe(6);
    expect(NEW_TRACK_ZONE_H).toBe(44);
    expect(TRIM_HANDLE_W).toBe(8);
    expect(SNAP_THRESHOLD_PX).toBe(8);
    expect(ROW).toBe(62);
  });
});

describe('timeToX / xToTime', () => {
  it('xPx = (timeUs - scrollUs) * pxPerUs', () => {
    expect(timeToX(5 * US, 0, 0.0001)).toBe(500);
    expect(timeToX(5 * US, 2 * US, 0.0001)).toBe(300);
    expect(timeToX(0, 2 * US, 0.0001)).toBe(-200);
  });

  it('xToTime timeToX\'in tersidir (tam sayı zamanlar için birebir)', () => {
    for (const scrollUs of [0, 2 * US, 37_123_456]) {
      for (const pxPerUs of [0.0001, 0.00001, 0.002]) {
        for (const timeUs of [0, 1, 12_345_678, 90 * US]) {
          const back = xToTime(timeToX(timeUs, scrollUs, pxPerUs), scrollUs, pxPerUs);
          expect(back).toBe(Math.max(0, timeUs));
        }
      }
    }
  });

  it('SONUCU TAM SAYIYA yuvarlar (doküman zamanları tam sayı µs)', () => {
    // 0.5 px @ 0.0001 -> 5000 us; 0.55 px -> 5500 us -> yuvarlanır.
    expect(xToTime(0.55, 0, 0.0001)).toBe(5500);
    expect(xToTime(0.000055, 0, 0.0001)).toBe(1); // 0.55 us -> 1
    expect(xToTime(0.000044, 0, 0.0001)).toBe(0); // 0.44 us -> 0
    expect(Number.isInteger(xToTime(123.456, 7_777, 0.000123))).toBe(true);
  });

  it('NEGATİF zamanı 0\'a kırpar (timeline 0\'dan önce başlamaz)', () => {
    expect(xToTime(-500, 0, 0.0001)).toBe(0);
    expect(xToTime(-1, 100, 0.0001)).toBe(0);
    expect(xToTime(0, 0, 0.0001)).toBe(0);
  });

  it('scrollUs kadar ötelenmiş görünümde de doğru zamanı verir', () => {
    expect(xToTime(300, 2 * US, 0.0001)).toBe(5 * US);
  });
});

describe('clampPxPerUs', () => {
  it('zoom sınırlarını uygular', () => {
    expect(clampPxPerUs(MIN_PX_PER_US / 10)).toBe(MIN_PX_PER_US);
    expect(clampPxPerUs(MAX_PX_PER_US * 10)).toBe(MAX_PX_PER_US);
    expect(clampPxPerUs(0.0001)).toBe(0.0001);
    expect(clampPxPerUs(MIN_PX_PER_US)).toBe(MIN_PX_PER_US);
    expect(clampPxPerUs(MAX_PX_PER_US)).toBe(MAX_PX_PER_US);
  });

  it('sınırlar mantıklı (1 px/sn .. 5 px/ms)', () => {
    expect(MIN_PX_PER_US).toBe(0.000001);
    expect(MAX_PX_PER_US).toBe(0.005);
  });
});

describe('trackTop / tracksContentHeight', () => {
  it('satır üstleri satır yüksekliğinin katları', () => {
    expect(trackTop(0)).toBe(0);
    expect(trackTop(1)).toBe(ROW);
    expect(trackTop(3)).toBe(3 * ROW);
  });

  it('içerik yüksekliği satırlar + yeni track bölgesi', () => {
    expect(tracksContentHeight(0)).toBe(NEW_TRACK_ZONE_H);
    expect(tracksContentHeight(2)).toBe(2 * ROW + NEW_TRACK_ZONE_H);
  });
});

describe('trackIndexAtY', () => {
  it('satırın İÇİ satır indeksini verir', () => {
    expect(trackIndexAtY(0, 2)).toBe(0);
    expect(trackIndexAtY(1, 2)).toBe(0);
    expect(trackIndexAtY(TRACK_H / 2, 2)).toBe(0);
    expect(trackIndexAtY(ROW, 2)).toBe(1);
    expect(trackIndexAtY(ROW + TRACK_H / 2, 2)).toBe(1);
  });

  it('satırın ALT SINIRI dahil, boşluk null (klip yüksekliği 56, aralık 6)', () => {
    expect(trackIndexAtY(TRACK_H, 2), 'y === TRACK_H hâlâ satırın içi').toBe(0);
    expect(trackIndexAtY(TRACK_H + 0.01, 2), 'satırlar arası boşluk').toBeNull();
    expect(trackIndexAtY(ROW - 0.01, 2)).toBeNull();
    expect(trackIndexAtY(ROW + TRACK_H, 2)).toBe(1);
    expect(trackIndexAtY(ROW + TRACK_H + 0.01, 2)).toBeNull();
  });

  it('NEGATİF y (cetvel bölgesi) null döner', () => {
    expect(trackIndexAtY(-0.01, 2)).toBeNull();
    expect(trackIndexAtY(-100, 2)).toBeNull();
  });

  it('son satırın ALTI "new" (yeni track bırakma bölgesi), sonrası null', () => {
    const zoneTop = trackTop(2);
    expect(trackIndexAtY(zoneTop, 2)).toBe('new');
    expect(trackIndexAtY(zoneTop + NEW_TRACK_ZONE_H / 2, 2)).toBe('new');
    expect(trackIndexAtY(zoneTop + NEW_TRACK_ZONE_H, 2), 'bölge sınırı DAHİL').toBe('new');
    expect(trackIndexAtY(zoneTop + NEW_TRACK_ZONE_H + 0.01, 2)).toBeNull();
  });

  it('BOŞ dokümanda (0 track) tepe zaten "new" bölgesidir', () => {
    expect(trackIndexAtY(0, 0)).toBe('new');
    expect(trackIndexAtY(NEW_TRACK_ZONE_H, 0)).toBe('new');
    expect(trackIndexAtY(NEW_TRACK_ZONE_H + 0.01, 0)).toBeNull();
  });

  it('satır indeksi track sayısını AŞMAZ (var olmayan satıra klip düşmez)', () => {
    for (let count = 1; count <= 4; count++) {
      for (let y = 0; y < count * ROW + NEW_TRACK_ZONE_H + 20; y += 1) {
        const row = trackIndexAtY(y, count);
        if (typeof row === 'number') {
          expect(row).toBeGreaterThanOrEqual(0);
          expect(row).toBeLessThan(count);
        }
      }
    }
  });

  it('her satırın tam ortası kendi indeksini verir (kayma yok)', () => {
    const count = 5;
    for (let i = 0; i < count; i++) {
      expect(trackIndexAtY(trackTop(i) + TRACK_H / 2, count)).toBe(i);
    }
  });
});

describe('visibleRangeUs', () => {
  it('görünür pencereyi 64 px paylarla genişletir', () => {
    const pxPerUs = 0.0001; // 64 px = 640_000 us
    const { startUs, endUs } = visibleRangeUs(10 * US, pxPerUs, 800);
    expect(startUs).toBe(10 * US - 640_000);
    expect(endUs).toBe(10 * US + 8 * US + 640_000);
  });

  it('başlangıcı 0\'ın altına indirmez', () => {
    expect(visibleRangeUs(0, 0.0001, 800).startUs).toBe(0);
    expect(visibleRangeUs(100_000, 0.0001, 800).startUs).toBe(0);
  });

  it('tam sayı sınırlar döndürür', () => {
    const r = visibleRangeUs(1_234_567, 0.000123, 777);
    expect(Number.isInteger(r.startUs)).toBe(true);
    expect(Number.isInteger(r.endUs)).toBe(true);
    expect(r.endUs).toBeGreaterThan(r.startUs);
  });
});

describe('fitPxPerUs', () => {
  it('içeriği %5 payla viewport\'a sığdırır', () => {
    expect(fitPxPerUs(1000, 100 * US)).toBeCloseTo((1000 * 0.95) / (100 * US), 12);
    // Sığdırılmış görünümde içerik sonu viewport içinde kalır.
    expect(timeToX(100 * US, 0, fitPxPerUs(1000, 100 * US))).toBeCloseTo(950, 6);
  });

  it('içerik yoksa makul bir varsayılan verir', () => {
    expect(fitPxPerUs(1000, 0)).toBe(clampPxPerUs(0.0001));
    expect(fitPxPerUs(1000, -5)).toBe(clampPxPerUs(0.0001));
  });

  it('sonucu zoom sınırlarına kırpar', () => {
    expect(fitPxPerUs(1000, 1_000)).toBe(MAX_PX_PER_US); // çok kısa içerik
    expect(fitPxPerUs(10, 100_000 * US)).toBe(MIN_PX_PER_US); // çok uzun içerik
  });
});
