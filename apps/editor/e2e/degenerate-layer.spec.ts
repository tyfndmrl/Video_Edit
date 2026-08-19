/**
 * Dejenere katman — GERÇEK fare ve klavye ile, GERÇEK medya ve GERÇEK worker'la (review-gate §3).
 *
 * ---------------------------------------------------------------------------
 * BU DOSYA NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * Kaynağın en-boy oranı katmanın kutusundan çok büyük olduğunda ffmpeg'in `scale` filtresi
 * sığdırdığı ekseni 1 pikselin ALTINA indirir, o ekseni `0` hesaplar ve `0`'ı *"girdi boyutunu
 * koru"* diye yorumlar. 1920×100 afiş + ölçek `0.010` → kutu `19×11`, gerçek çıktı `18×100`:
 * önizlemenin çizdiği ~1 px yerine **100 kat** yüksek bir bant. Bu belge eskiden `POST /exports`
 * ile **202** alıyor, kuyruğa giriyor ve dakikalar sonra worker'da `ffmpeg -22` ile düşüyordu.
 *
 * Kural artık SENKRONDUR. Bu testin kapanma kriteri "kart Başarısız göstermedi" DEĞİLDİR —
 * o kriter işin kuyruğa girdiğini kabul ederdi. Kriter: **POST'un KENDİSİ 422 döner** ve
 * "Dışa Aktarmalar" listesinde HİÇ satır oluşmaz.
 *
 * Testin ikinci yarısı POZİTİF KONTROLdür: bir ızgara adımı yukarısı (`0.011`) kabul edilir ve
 * iş GERÇEKTEN render edilir. İkisi birlikte, kapının doğru yerde olduğunu gösterir — yalnız
 * reddi göstermek "her şeyi reddeden bir kapı"yla da yeşil kalırdı.
 *
 * `dispatchEvent`, sentetik PointerEvent ve doğrudan store çağrısı YOKTUR. Store yalnız
 * DOĞRULAMA için okunur (transform canvas'ta okunamaz; tek dürüst kaynak dokümandır).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { BANNER_VIDEO_SPEC, ensureBannerVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

/** Alanı GERÇEK fareyle odakla, GERÇEK klavyeyle yaz (guard-paths.spec.ts ile aynı desen). */
async function typeNumber(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await expect(el, `Alan ekranda yok: ${testId}`).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `Alanın kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(160);
}

/** Seçili klibin dokümandaki ölçeği (canvas'tan okunamaz). */
async function readScale(page: Page, clipId: string): Promise<number> {
  const scale = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): {
              doc: { tracks: { clips: { id: string; transform?: { scale: number } }[] }[] };
            };
          };
        };
      };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      const found = track.clips.find((c) => c.id === id);
      if (found) return found.transform?.scale ?? null;
    }
    return null;
  }, clipId);
  expect(scale, `Klip dokümanda yok: ${clipId}`).not.toBeNull();
  return scale as number;
}

test.describe('Dejenere katman: aşırı geniş kaynakta ölçek tabanı', () => {
  test(
    'afiş kaynakta ölçek 0.010 KUYRUĞA HİÇ GİRMEZ (POST 422), 0.011 render EDİLİR',
    async ({ page, account }) => {
      test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
      // Yükleme + worker işleme + gerçek ffmpeg render.
      test.setTimeout(480_000);

      // GERÇEK medya ŞART: kapı kaynağın ffprobe boyutundan besleniyor. Sahte assetId'li bir
      // doküman worker'da zaten kaynak bulamadan düşerdi ve kapı hiç koşmazdı.
      const banner = ensureBannerVideo();
      const project = await createEmptyProject(
        account.context.request,
        account.accessToken,
        'E2E dejenere katman',
      );

      const app = new EditorApp(page);
      await app.open(project.projectId, { email: account.email, password: account.password });

      const library = new LibraryPanelHarness(page);
      await library.pickFiles([banner.path]);
      await library.waitForReady(banner.fileName);
      await library.doubleClickAsset(banner.fileName);
      await expect
        .poll(async () => (await app.state()).clipCount, {
          timeout: 20_000,
          message: 'Kütüphaneden timeline\'a klip eklenemedi.',
        })
        .toBe(1);

      // --- Klibi GERÇEK fareyle seç (Inspector alanları ancak seçimle açılır) ---
      const st = await app.state();
      const clip = st.tracks.flatMap((t) => t.clips)[0]!;
      await app.timeline.click(await app.timeline.clipCenter(clip.id, st));

      // --- 1) Ölçeği GERÇEK KLAVYEYLE dejenere değere çek ---
      // Gizmoya bırakılMAZ: gizmo 3 ondalıklı KEYFİ bir değer yazar ve tam olarak tabanı
      // tutturamaz — kapı iddiası o zaman rastgele bir sayıya dayanırdı.
      await typeNumber(page, 'clip-scale', BANNER_VIDEO_SPEC.degenerateScale);
      expect(
        await readScale(page, clip.id),
        'Yazılan ölçek dokümana AYNEN geçmeliydi — kapı iddiasının taşıyıcısı bu değerdir. '
          + 'Editör bugün ölçeği kaynağa göre kısıtlamıyor (bilinçli kapsam kararı, docs/backlog.md).',
      ).toBe(Number(BANNER_VIDEO_SPEC.degenerateScale));

      // --- 2) GERÇEK dışa aktarma denemesi: POST'un KENDİSİ 422 dönmeli ---
      const rejected = page.waitForResponse(
        (r) => r.url().includes('/exports') && r.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Dışa aktar' }).click();

      const response = await rejected;
      expect(
        response.status(),
        'KAPANMA KRİTERİ: iş kuyruğa HİÇ girmemeli. 202 dönerse belge kuyruğa girmiş ve '
          + 'kural yine worker\'a kalmış demektir (eski davranış tam olarak buydu).',
      ).toBe(422);
      const problem = (await response.json()) as { detail?: string; feature?: string };
      expect(problem.feature, 'Makine-okur hata kodu.').toBe('degenerate-layer');
      expect(
        problem.detail ?? '',
        'Mesaj NEDENİ (kaynağın oranı) ve EYLEMİ (kesin bir sayı) taşımalı.',
      ).toContain('1920x100');
      expect(problem.detail ?? '').toContain(`en az ${BANNER_VIDEO_SPEC.acceptedScale}`);

      // Diyalog AÇIK kalır ve gerekçeyi kullanıcıya gösterir (sessiz başarısızlık yok).
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('alert'),
        'Kullanıcı 422\'nin gerekçesini ekranda görmeli.',
      ).toContainText(`en az ${BANNER_VIDEO_SPEC.acceptedScale}`);

      // Ve HİÇ iş kartı oluşmamalı — "kuyruğa girmedi"nin görünür kanıtı.
      const exportsSection = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
        .first();
      await expect(
        exportsSection.locator('li'),
        'Reddedilen belge için iş satırı oluşmamalı.',
      ).toHaveCount(0);

      // --- 3) POZİTİF KONTROL: bir ızgara adımı yukarısı kabul edilir ve RENDER edilir ---
      await dialog.getByRole('button', { name: 'Vazgeç' }).click();
      await expect(dialog).toBeHidden();
      await app.timeline.click(await app.timeline.clipCenter(clip.id, await app.state()));
      await typeNumber(page, 'clip-scale', BANNER_VIDEO_SPEC.acceptedScale);
      expect(await readScale(page, clip.id)).toBe(Number(BANNER_VIDEO_SPEC.acceptedScale));

      const accepted = page.waitForResponse(
        (r) => r.url().includes('/exports') && r.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
      expect(
        (await accepted).status(),
        'Eşiğin bir adım üstü kabul edilmeli — aksi halde 422 mesajının önerdiği sayı YALAN olurdu.',
      ).toBe(202);
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      // 202 YETMEZ: kapı doğru yerdeyse bu belge GERÇEKTEN render edilebilmelidir.
      const jobRow = exportsSection.locator('li').first();
      await expect(jobRow).toBeVisible({ timeout: 20_000 });
      await expect(
        jobRow.getByText('Tamamlandı', { exact: true }),
        `Ölçek ${BANNER_VIDEO_SPEC.acceptedScale} → kutu 21x12, gerçek çıktı 20x2. Bu belge `
          + 'derleme kapısını geçmeli ve render edilmelidir.',
      ).toBeVisible({ timeout: 300_000 });
      await expect(
        jobRow.locator('p.text-danger'),
        'Başarısız bir iş sessizce geçmemeli.',
      ).toHaveCount(0);
    },
  );
});
