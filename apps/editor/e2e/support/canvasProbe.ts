/**
 * canvasProbe — timeline gövde canvas'ından PİKSEL okuma.
 *
 * Neden gerekli: "filmstrip çizildi mi?" sorusunun store'da karşılığı yok.
 * Asset'in filmstrip URL'si dolu olabilir ama sprite indirilmemiş/çizilmemiş
 * olabilir (COEP/CORS, manifest hatası, cache anahtarı...). Tek dürüst kanıt,
 * klibin gövdesinde GERÇEKTEN renkli kareler olmasıdır: filmstrip yokken klip
 * düz bir dolgu rengiyle boyanır (drawTracks.ts — roundRect + fill), varken
 * kaynak karelerin renkleri düşer.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Klip gövdesinde isim çubuğunun altındaki içerik şeridinin üst payı.
 * drawTracks.ts: contentY = y + 2 + NAME_BAR_H, NAME_BAR_H = 15 (modül-özel
 * sabit). +2 pay: isim çubuğu kenarının antialias'ı örneğe karışmasın.
 */
const CONTENT_TOP_OFFSET = 2 + 15 + 2;
/** Alt pay: klip kenarlığı/yuvarlatması örneğe karışmasın. */
const CONTENT_BOTTOM_OFFSET = 5;

export interface ColorSample {
  /** Örneklenen piksel sayısı. */
  sampled: number;
  /** Farklı RGB değeri sayısı. */
  unique: number;
  /** En sık görülen rengin oranı (0..1) — düz blok ~1.0'a yakındır. */
  dominantRatio: number;
}

/**
 * Sayfa koordinatlarındaki bir dikdörtgenin içindeki renk çeşitliliği.
 * `box` klibin kutusudur (TimelineHarness.clipBox); örnekleme isim çubuğunun
 * ALTINDAKİ içerik şeridinde yapılır.
 */
export async function clipContentColors(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<ColorSample> {
  const sample = await page.evaluate(
    ({ rect, topOffset, bottomOffset }) => {
      const tagged = document.querySelector('[data-testid="timeline-canvas"]');
      const wrap =
        tagged ??
        [...document.querySelectorAll('div')].find(
          (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
        );
      if (!wrap) return null;
      // Canvas sırası: ruler, body, overlay (TimelinePanel render'ı).
      const body = wrap.querySelectorAll('canvas')[1] as HTMLCanvasElement | undefined;
      if (!body) return null;
      const r = body.getBoundingClientRect();
      const scaleX = body.width / r.width;
      const scaleY = body.height / r.height;
      const ctx = body.getContext('2d');
      if (!ctx) return null;

      const x0 = Math.round((rect.x - r.left + 2) * scaleX);
      const y0 = Math.round((rect.y - r.top + topOffset) * scaleY);
      const w = Math.round((rect.width - 4) * scaleX);
      const h = Math.round((rect.height - topOffset - bottomOffset) * scaleY);
      if (w <= 1 || h <= 1) return null;

      const data = ctx.getImageData(x0, y0, w, h).data;
      const counts = new Map<number, number>();
      // En çok 4000 piksel örnekle — kanıt için fazlasıyla yeter, hızlı kalır.
      const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
      let sampled = 0;
      for (let yy = 0; yy < h; yy += step) {
        for (let xx = 0; xx < w; xx += step) {
          const i = (yy * w + xx) * 4;
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
          sampled++;
        }
      }
      let dominant = 0;
      for (const c of counts.values()) dominant = Math.max(dominant, c);
      return { sampled, unique: counts.size, dominantRatio: sampled === 0 ? 1 : dominant / sampled };
    },
    { rect: box, topOffset: CONTENT_TOP_OFFSET, bottomOffset: CONTENT_BOTTOM_OFFSET },
  );

  expect(sample, 'Timeline gövde canvas\'ı okunamadı (piksel örneklemesi).').not.toBeNull();
  return sample as ColorSample;
}
