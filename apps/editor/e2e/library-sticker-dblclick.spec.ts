/**
 * Kitaplık "Sticker" düğmesi — GERÇEK fare, GERÇEK medya.
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * Kitaplık satırının kendi `title`'ı "Çift tık: timeline'a ekle" diyerek çift
 * tık jestini DAVET ediyor ve görsel satırlarında "Sticker" düğmesi tam da
 * satırın orta ekseninde duruyor (bu ortamda ölçüldü: 255 px genişliğindeki
 * satırın ortası düğmenin kutusuna düşüyor). Çift tıkta tarayıcı İKİ ayrı
 * `click` üretir; düğmenin `onDoubleClick`'i yalnız yayılımı durdurduğu için
 * ikisi de `onClick`'e ulaşıyor ve İKİ çıkartma ekleniyordu (ölçüldü: Δ2,
 * üç ayrı jestte de tekrarlandı). Kullanıcı bunu geri almak için Ctrl+Z'ye
 * İKİ kez basmak zorunda kalıyordu.
 *
 * Doğru davranış: bir jest = bir çıkartma. Tek tık hâlâ ekler, satırın
 * SOLUNA çift tık hâlâ görseli video track'ine ekler.
 *
 * KURAL (docs/review-gate.md §3): yalnız page.mouse.*. Medya GERÇEK (ffmpeg
 * ile üretilir, gerçek yükleme + worker işlemesi) — "Sticker" düğmesi ancak
 * `kind === 'image'` VE `status === 'ready'` satırlarında var olduğu için sahte
 * bir asset ile bu düğmeye hiç ulaşılamaz.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import { FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

/** e2e/.artifacts/media — support/media.ts ile aynı klasör (gitignore). */
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/**
 * Düz macenta PNG. İçeriğin ne olduğu bu testin konusu değil (piksel iddiası
 * image-preview.spec.ts'te); burada önemli olan sunucunun onu GÖRSEL olarak
 * işleyip satıra "Sticker" düğmesini koyması.
 */
function ensureStickerImage(): { path: string; fileName: string } {
  const fileName = 'e2e-sticker-dblclick-320x240.png';
  const path = join(MEDIA_DIR, fileName);
  if (!existsSync(path)) {
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=magenta:s=320x240',
        '-frames:v',
        '1',
        path,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (res.status !== 0) throw new Error(`ffmpeg test görseli üretemedi: ${res.stderr}`);
  }
  return { path, fileName };
}

async function clipKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bridge = (
      window as unknown as {
        __ve: {
          doc: {
            useDocStore: {
              getState(): { doc: { tracks: { type: string; clips: { kind: string }[] }[] } };
            };
          };
        };
      }
    ).__ve;
    const out: string[] = [];
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) out.push(`${track.type}:${clip.kind}`);
    }
    return out.sort();
  });
}

test.describe('Kitaplık — bir jest, bir klip', () => {
  test('"Sticker" düğmesine çift tık TEK çıkartma ekler; tek tık ve satır çift tıkı bozulmaz', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    const image = ensureStickerImage();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E sticker çift tık',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([image.path]);
    await library.waitForReady(image.fileName);

    const row = library.row(image.fileName);
    const rowBox = await row.boundingBox();
    expect(rowBox, `Kitaplıkta "${image.fileName}" satırı yok.`).not.toBeNull();
    const button = row.getByTestId('asset-add-sticker');
    const buttonBox = await button.boundingBox();
    expect(buttonBox, 'Görsel satırında "Sticker" düğmesi yok.').not.toBeNull();

    // ÖN KOŞUL — bulgunun sebebi: satırın orta ekseni düğmenin ÜSTÜNE düşüyor,
    // yani satırın davet ettiği çift tık jesti düğmeye iniyor. Bu doğru
    // olmaktan çıkarsa test hâlâ anlamlıdır ama sebebi değişmiş demektir.
    const rowMidX = rowBox!.x + rowBox!.width / 2;
    expect(
      rowMidX >= buttonBox!.x && rowMidX <= buttonBox!.x + buttonBox!.width,
      `Satır ortası (${Math.round(rowMidX)}) artık "Sticker" düğmesinin ` +
        `(${Math.round(buttonBox!.x)}..${Math.round(buttonBox!.x + buttonBox!.width)}) üstünde değil.`,
    ).toBe(true);

    const center = { x: buttonBox!.x + buttonBox!.width / 2, y: buttonBox!.y + buttonBox!.height / 2 };

    // 1) TEK tık: bir çıkartma (bu yol bozulmamalı).
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(async () => (await clipKinds(page)).length, {
        timeout: 15_000,
        message: '"Sticker" düğmesine tek tık çıkartma eklemedi.',
      })
      .toBe(1);
    expect(await clipKinds(page)).toEqual(['overlay:sticker']);

    // 2) ÇİFT tık: bir jest = BİR çıkartma daha (iki değil).
    await page.mouse.dblclick(center.x, center.y);
    await page.waitForTimeout(800);
    expect(
      await clipKinds(page),
      'çift tık İKİ çıkartma ekledi — bir jest bir klip eklemeli',
    ).toEqual(['overlay:sticker', 'overlay:sticker']);

    // 3) Satırın SOLUNA çift tık: satırın kendi yolu (görsel video track'ine).
    await page.mouse.dblclick(rowBox!.x + 40, rowBox!.y + rowBox!.height / 2);
    await expect
      .poll(async () => (await clipKinds(page)).length, {
        timeout: 15_000,
        message: 'Satıra çift tık görseli timeline\'a eklemedi.',
      })
      .toBe(3);
    expect(
      await clipKinds(page),
      'satır çift tıkı hâlâ TEK bir görsel klip eklemeli',
    ).toEqual(['overlay:sticker', 'overlay:sticker', 'video:image']);
  });
});
