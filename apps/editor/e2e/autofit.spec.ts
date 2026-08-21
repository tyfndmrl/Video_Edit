/**
 * KÖK NEDEN testi — proje açılışında içerik GÖRÜNÜR mü?
 *
 * Kullanıcı "hiçbir şey çalışmıyor" dedi; gerçek sebep timeline'ın boş
 * görünmesiydi: varsayılan pxPerUs=0.0001 ile yalnız ilk ~5 saniye ekrana
 * sığar, 60. saniyedeki klipler x≈6000 px'te kalır. Bu test tam olarak bunu
 * yakalar: seed projesinin klipleri 60 sn'de başlar, açılışta hiçbir düğmeye
 * BASILMADAN ilk klibin ekran x'i canvas genişliği içinde olmalıdır.
 */
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';

test.describe('Proje açılışı', () => {
  test('açılışta timeline içeriğe sığdırılır — ilk klip ekranda görünür', async ({
    editor,
    seed,
  }) => {
    const state = await editor.state();
    const wrap = await editor.timeline.wrapBox();
    const box = await editor.timeline.clipBox(seed.clipAId, state);
    const { clip } = findClip(state, seed.clipAId);

    const relLeft = box.x - wrap.x;
    const relRight = relLeft + box.width;

    expect(
      relLeft,
      `Klip canvas'ın solunda kaldı (x=${relLeft.toFixed(1)}px, pxPerUs=${state.pxPerUs}). ` +
        'Açılışta fit-to-content yapılmıyor olabilir.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      relRight,
      `Klip canvas'ın sağına taştı (sağ kenar=${relRight.toFixed(1)}px, canvas=${wrap.width.toFixed(1)}px, ` +
        `pxPerUs=${state.pxPerUs}). Klip ${clip.timelineStartUs / 1e6}. saniyede başlıyor; ` +
        'varsayılan zoom ile ekrana sığmaz — açılışta fit-to-content bekleniyor.',
    ).toBeLessThanOrEqual(wrap.width);

    // Kliplerin ölçülebilir bir genişliği olmalı (aşırı uzaklaştırma da "boş timeline" demektir).
    expect(box.width, 'Klip genişliği 4 px altında — pratikte görünmez.').toBeGreaterThan(4);
  });

  test('açılışta son klip de görünür alanda (tüm içerik sığdırılmış)', async ({ editor, seed }) => {
    const state = await editor.state();
    const wrap = await editor.timeline.wrapBox();
    const box = await editor.timeline.clipBox(seed.clipBId, state);
    expect(box.x - wrap.x).toBeGreaterThanOrEqual(0);
    expect(box.x - wrap.x + box.width).toBeLessThanOrEqual(wrap.width + 1);
  });

  /**
   * "Fit" düğmesi GERÇEK fareyle çalışır — ve ensureContentVisible'ın fit dalı
   * CANLIDIR. Harness bulgusu: EditorApp.fitButton /Sığdır/ arıyordu ama
   * düğmenin erişilebilir adı "Fit" (görünen metin; "Sığdır (Shift+Z)" yalnız
   * title). Locator hiçbir düğmeyle eşleşmediği için fit dalı HİÇ çalışmamış,
   * açılıştaki auto-fit her testte yettiği için fark edilmemişti. Bu test dalı
   * BİLEREK tetikler: derin zoom ile içeriği ekrandan çıkarır, yardımcının
   * düğmeye gerçekten basıp görünümü içeriğe oturttuğunu doğrular.
   */
  test('Fit düğmesi (gerçek tıklama) derin zoom sonrası içeriği ekrana geri getirir', async ({
    editor,
    seed,
  }) => {
    // Locator canlılığı iddianın kendisi: düğme TEKİL olarak bulunur.
    await expect(editor.fitButton).toHaveCount(1);

    // Derin zoom (gerçek Ctrl+tekerlek): klip A tam-görünür olmaktan çıkana
    // kadar yaklaş — fit dalının tetiklenme ön koşulu budur.
    let fullyVisible = true;
    for (let step = 0; step < 12 && fullyVisible; step++) {
      await editor.timeline.ctrlWheel(-360); // yaklaş
      const wrap = await editor.timeline.wrapBox();
      const box = await editor.timeline.clipBox(seed.clipAId);
      fullyVisible = box.x >= wrap.x && box.x + box.width <= wrap.x + wrap.width;
    }
    expect(
      fullyVisible,
      'Zoom içeriği ekrandan çıkaramadı — fit dalı tetiklenmeden test anlamsız.',
    ).toBe(false);

    // Fit dalı: içerik görünmediği için yardımcı GERÇEK tıklamayla Fit'e basar.
    await editor.ensureContentVisible(seed.clipAId);

    const wrap = await editor.timeline.wrapBox();
    for (const clipId of [seed.clipAId, seed.clipBId]) {
      const box = await editor.timeline.clipBox(clipId);
      expect(box.x - wrap.x, `Fit sonrası ${clipId} solda ekran dışında.`).toBeGreaterThanOrEqual(0);
      expect(
        box.x - wrap.x + box.width,
        `Fit sonrası ${clipId} sağda ekran dışında.`,
      ).toBeLessThanOrEqual(wrap.width + 1);
    }
  });
});
