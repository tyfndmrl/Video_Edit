/**
 * J/K/L shuttle — GERÇEK klavyeyle sessiz kademeli geri tarama (ozellik-5).
 *
 * Kanıtlanan davranış (dispatcher + shortcuts/shuttle):
 *  - J: playhead GERÇEKTEN geriye akar (iki örnekte kesin küçülme) ve oynatma
 *    BAŞLAMAZ (isPlaying false kalır — sessiz TARAMA kanıtı; motor paused,
 *    hiçbir element play() almaz). Rozet 'transport-shuttle-note' görünür ve
 *    sessizliği söyler.
 *  - K: tarama durur, playhead sabitlenir, rozet kalkar.
 *  - L: ileri oynatma başlar (isPlaying true + playhead artar).
 *  - BOF: başlangıca varınca TAM 0'da kendiliğinden durur, rozet kalkar.
 *
 * HIZ ÖLÇÜMÜ BURADA YAPILMAZ: duvar saatine bağlı bir e2e hız iddiası kırılgan
 * olur — hız dürüstlüğü birim testte fake timer'larla ölçülür
 * (src/features/shortcuts/shuttle.test.ts).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';

const SECOND_US = 1_000_000;

async function isPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { editor: { useEditorStore: { getState(): { isPlaying: boolean } } } };
    }).__ve;
    return bridge.editor.useEditorStore.getState().isPlaying;
  });
}

test.describe('J/K/L — sessiz geri tarama', () => {
  test('J playhead\'i geriletir (oynatma BAŞLAMAZ) + rozet; K sabitler; L ileri oynatır', async ({
    editor,
  }) => {
    const page = editor.page;
    const badge = page.getByTestId('transport-shuttle-note');

    // Başlangıç: playhead'i gerçek fareyle 12. saniyeye getir (geri tarama payı).
    await editor.timeline.scrubTo(12 * SECOND_US);
    const start = (await editor.state()).playheadUs;
    expect(start, 'Scrub 12 sn civarına oturmalıydı.').toBeGreaterThan(10 * SECOND_US);
    await expect(badge, 'Shuttle başlamadan rozet görünmemeli.').toBeHidden();

    // --- J: GERÇEK klavye ---
    await page.keyboard.press('j');
    await expect(badge, 'J sonrası geri tarama rozeti görünmeli.').toBeVisible();
    await expect(badge).toHaveText('Geri tarama 1x — ses kapalı');
    await expect(badge).toHaveAttribute('role', 'status');

    // İki örnekte KESİN küçülme (tek örnek, tek yazımlık bir sıçramayla da
    // yeşil olurdu — süreklilik iki ardışık düşüşle kanıtlanır).
    await expect
      .poll(async () => (await editor.state()).playheadUs, {
        message: 'J sonrası playhead GERİLEMİYOR.',
      })
      .toBeLessThan(start);
    const sample1 = (await editor.state()).playheadUs;
    await expect
      .poll(async () => (await editor.state()).playheadUs, {
        message: 'Geri tarama ilk düşüşten sonra durdu (süreklilik yok).',
      })
      .toBeLessThan(sample1);

    // Sessiz TARAMA kanıtı: geri akış oynatma DEĞİLDİR.
    expect(await isPlaying(page), 'J oynatma başlatmamalı (sessiz tarama).').toBe(false);

    // --- K: tarama durur, playhead sabitlenir, rozet kalkar ---
    await page.keyboard.press('k');
    await expect(badge, 'K sonrası rozet kalkmalı.').toBeHidden();
    const frozen = (await editor.state()).playheadUs;
    await page.waitForTimeout(400);
    expect(
      (await editor.state()).playheadUs,
      'K sonrası playhead hâlâ hareket ediyor.',
    ).toBe(frozen);
    expect(await isPlaying(page)).toBe(false);

    // --- L: ileri oynatma ---
    await page.keyboard.press('l');
    await expect
      .poll(() => isPlaying(page), { message: 'L oynatmayı başlatmadı.' })
      .toBe(true);
    await expect
      .poll(async () => (await editor.state()).playheadUs, {
        message: 'L sonrası playhead İLERLEMİYOR.',
      })
      .toBeGreaterThan(frozen);

    // Temiz bitiş: durdur.
    await page.keyboard.press('k');
    await expect.poll(() => isPlaying(page)).toBe(false);
  });

  test('BOF kelepçesi: J başlangıca varınca TAM 0\'da durur ve rozet kalkar', async ({
    editor,
  }) => {
    const page = editor.page;
    const badge = page.getByTestId('transport-shuttle-note');

    await editor.timeline.scrubTo(1.5 * SECOND_US);
    const start = (await editor.state()).playheadUs;
    expect(start).toBeGreaterThan(0);

    await page.keyboard.press('j');
    await expect(badge).toBeVisible();

    // 1x hızda ~1,5 sn sonra başlangıç: TAM 0 beklenir (kelepçe yazımı).
    await expect
      .poll(async () => (await editor.state()).playheadUs, {
        timeout: 10_000,
        message: 'Geri tarama başlangıca varmadı (BOF kelepçesi çalışmıyor).',
      })
      .toBe(0);
    await expect(badge, 'BOF\'ta shuttle kendiliğinden durmalı (rozet kalkar).').toBeHidden();
    expect(await isPlaying(page)).toBe(false);

    // Durduktan sonra playhead 0'da SABİT kalır (metronom gerçekten öldü).
    await page.waitForTimeout(300);
    expect((await editor.state()).playheadUs).toBe(0);
  });
});
