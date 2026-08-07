/** playwright.config.ts ile fixture'ların paylaştığı sabitler (tek kaynak). */

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

/**
 * Viewport timeline geometrisini belirler: 1440 genişlikte canvas gövdesi
 * ~670 px olur (1440 − 280 kütüphane − 320 inspector − 170 track başlıkları),
 * seed projesindeki 82 saniyelik içerik sığdırıldığında klipler ~46 px genişler
 * — gerçek fare jestleri için rahat bir hedef.
 */
export const E2E_VIEWPORT = { width: 1440, height: 900 } as const;
