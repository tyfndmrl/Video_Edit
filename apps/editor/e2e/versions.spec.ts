/**
 * Sürüm geçmişi (M6) — kullanıcının İLK gereksinim listesindeki "otomatik kayıt
 * + versiyon geçmişi"nin ikinci yarısı. Backend M2'den beri revizyon tutuyordu
 * (GET/POST /api/projects/{id}/revisions, POST /restore) ama arayüz yoktu.
 *
 * Buradaki her etkileşim GERÇEK girdidir: timeline mutasyonları page.mouse
 * sürüklemeleri (support/timeline.ts), panel etkileşimleri gerçek tıklama,
 * etiket gerçek klavye ile yazılır. Doğrulama tarafı store'u okur (canvas'ın
 * DOM'da okunabilir bir hali yok) — bkz. support/appBridge.ts.
 *
 * Kapsanan sözleşme:
 *  - TopBar "Sürümler" düğmesi paneli açar; liste otomatik kayıtları gösterir,
 *    sunucudaki güncel kayıt işaretlidir.
 *  - "Şu anki hali kaydet" ÖNCE autosave'i flush eder (kayıt noktası
 *    kullanıcının GÖRDÜĞÜ hali yakalasın), sonra checkpoint oluşturur.
 *  - "Bu sürüme dön" ONAY ister; onaysız hiçbir şey olmaz.
 *  - Onaylanan geri dönüş dokümanı değiştirir VE geri alma geçmişini temizler;
 *    dönüşten önceki hal listeye "Geri dönüş öncesi" olarak eklenir.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { findClip } from './support/appBridge';
import { SECOND_US } from './fixtures/seed';

const CHECKPOINT_LABEL = 'ilk kesim';

function overlay(page: Page) {
  return page.getByTestId('versions-overlay');
}

function rows(page: Page) {
  return page.getByTestId('versions-rows').locator('li');
}

/** TopBar'daki "Sürümler" düğmesine GERÇEK tıklama. */
async function openVersions(page: Page): Promise<void> {
  await page.getByTestId('versions-open').click();
  await expect(
    overlay(page),
    'TopBar "Sürümler" düğmesi sürüm panelini açmalı.',
  ).toBeVisible();
  // Liste ilk açılışta fetch edilir (refetchOnMount: always).
  await expect(page.getByTestId('versions-rows').or(page.getByTestId('versions-empty'))).toBeVisible();
}

async function closeVersions(page: Page): Promise<void> {
  await page.getByTestId('versions-close').click();
  await expect(overlay(page)).toHaveCount(0);
}

/** Etiketli kayıt noktası oluşturur (etiket GERÇEK klavyeyle yazılır). */
async function createCheckpoint(page: Page, label: string): Promise<void> {
  await page.getByTestId('versions-checkpoint-label').click();
  await page.keyboard.type(label);
  await expect(page.getByTestId('versions-checkpoint-label')).toHaveValue(label);
  await page.getByTestId('versions-checkpoint-submit').click();
  await expect(
    page.getByTestId('versions-notice'),
    'Kayıt noktası sonrası kullanıcıya bildirim gösterilmeli.',
  ).toContainText(/Kayıt noktası oluşturuldu/i);
}

test.describe('Sürüm geçmişi paneli', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('panel gerçek tıklamayla açılır, otomatik kayıtları listeler ve kapanır', async ({
    editor,
  }) => {
    const page = editor.page;
    await openVersions(page);

    // Seed projesi bir PUT ile kurulduğu için sunucuda en az bir Auto snapshot
    // vardır (SnapshotPolicy bootstrap kuralı).
    expect(await rows(page).count(), 'En az bir otomatik kayıt beklenir.').toBeGreaterThan(0);
    await expect(page.getByTestId('versions-rows')).toContainText(/Otomatik/);
    await expect(
      page.getByTestId('versions-rows'),
      'Sunucudaki güncel kayıt işaretlenmeli.',
    ).toContainText(/Güncel kayıt/);

    await closeVersions(page);
  });

  test('"Bu sürüme dön" onay ister; vazgeçildiğinde doküman ve geçmiş dokunulmadan kalır', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);

    const moved = await editor.state();
    const startAfterDrag = findClip(moved, seed.clipAId).clip.timelineStartUs;
    expect(moved.historyLabels.length).toBe(1);

    await openVersions(page);
    await rows(page).first().getByRole('button', { name: 'Bu sürüme dön' }).click();
    await expect(
      page.getByTestId('versions-restore-confirm'),
      'Geri dönüş doğrudan uygulanmamalı — önce onay istenmeli.',
    ).toBeVisible();

    await page.getByTestId('versions-restore-cancel').click();
    await expect(page.getByTestId('versions-restore-confirm')).toHaveCount(0);

    const after = await editor.state();
    expect(
      findClip(after, seed.clipAId).clip.timelineStartUs,
      'Vazgeçilen geri dönüş dokümanı değiştirmemeli.',
    ).toBe(startAfterDrag);
    expect(after.historyLabels.length, 'Vazgeçince geçmiş de silinmemeli.').toBe(1);
  });

  test('düzenle → kayıt noktası → düzenle → eski sürüme dön: doküman geri gelir, geri alma geçmişi temizlenir', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    const clipId = seed.clipAId;

    const before = await editor.state();
    const startInitial = findClip(before, clipId).clip.timelineStartUs;

    // 1) GERÇEK fareyle düzenleme.
    await editor.timeline.dragClipByTime(clipId, 8 * SECOND_US);
    const atCheckpoint = await editor.state();
    const startAtCheckpoint = findClip(atCheckpoint, clipId).clip.timelineStartUs;
    expect(startAtCheckpoint, 'İlk sürükleme klibi gerçekten taşımalı.').not.toBe(startInitial);

    // 2) Kayıt noktası — autosave'i flush edip SUNUCUDAKİ hali damgalar.
    await openVersions(page);
    await createCheckpoint(page, CHECKPOINT_LABEL);

    const checkpointRow = rows(page).filter({ hasText: CHECKPOINT_LABEL });
    await expect(checkpointRow, 'Etiketli kayıt noktası listede görünmeli.').toHaveCount(1);
    await expect(checkpointRow).toContainText(/Kayıt noktası/);
    await closeVersions(page);

    // 3) İkinci GERÇEK düzenleme — kayıt noktasından uzaklaş.
    await editor.timeline.dragClipByTime(clipId, -4 * SECOND_US);
    const drifted = await editor.state();
    const startDrifted = findClip(drifted, clipId).clip.timelineStartUs;
    expect(startDrifted, 'İkinci sürükleme klibi tekrar taşımalı.').not.toBe(startAtCheckpoint);
    expect(drifted.historyLabels.length, 'İki jest iki geçmiş girdisi bırakmalı.').toBe(2);

    // 4) Panelden kayıt noktasına dön (onaylı).
    await openVersions(page);
    const targetRow = rows(page).filter({ hasText: CHECKPOINT_LABEL });
    await expect(targetRow).toHaveCount(1);
    await targetRow.getByRole('button', { name: 'Bu sürüme dön' }).click();
    await page.getByTestId('versions-restore-confirm').click();
    await expect(
      page.getByTestId('versions-notice'),
      'Geri dönüş sonrası kullanıcıya bildirim gösterilmeli.',
    ).toContainText(/sürüme dönüldü/i);

    // 5) Doküman kayıt noktasındaki haline döndü.
    const restored = await editor.state();
    expect(
      findClip(restored, clipId).clip.timelineStartUs,
      'Geri dönüş klibi kayıt noktasındaki konumuna getirmeli.',
    ).toBe(startAtCheckpoint);

    // 6) Geri alma geçmişi TEMİZ (loadDoc semantiği) — panel de boş göstermeli.
    expect(restored.historyLabels, 'Geri dönüş undo geçmişini temizlemeli.').toEqual([]);
    expect(restored.cursor).toBe(0);
    await expect(editor.historyPanel).toContainText(/henüz işlem yok/i);

    // 7) Dönüşten önceki hal kurtarılabilir: "Geri dönüş öncesi" satırı eklendi.
    await expect(
      page.getByTestId('versions-rows'),
      'Restore öncesi durum PreRestore olarak listeye eklenmeli.',
    ).toContainText(/Geri dönüş öncesi/);

    // 8) Editör tekrar kullanılabilir: kilit kalkmış olmalı (gerçek sürükleme çalışır).
    await closeVersions(page);
    await editor.timeline.dragClipByTime(clipId, 2 * SECOND_US);
    const afterRestoreEdit = await editor.state();
    expect(
      findClip(afterRestoreEdit, clipId).clip.timelineStartUs,
      'Geri dönüşten sonra doküman yeniden düzenlenebilmeli (kilit kalkmalı).',
    ).not.toBe(startAtCheckpoint);
    expect(afterRestoreEdit.historyLabels.length).toBe(1);
  });
});
