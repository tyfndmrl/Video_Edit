/**
 * MÜZİK EKLEMEK — kullanıcının GERÇEK yolu, uçtan uca (yükleme → çift tık → dışa
 * aktarma → indirilen dosyada GERÇEK ses).
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR (6. tur denetimi, N1 — KRİTİK)
 * ---------------------------------------------------------------------------
 * Ölçülen kusur: kitaplığa bir `.m4a` yüklemek ("Hazır"), karta çift tıklayıp ses
 * track'ine koymak ve "Dışa Aktar" demek — POST /exports **202** dönüyor, iş
 * dakikalar sonra worker'da `unsupported-media: source of asset <id> has no video
 * stream` ile **failed** oluyordu. Yani MÜZİK EKLEMEK EXPORT'U İMKÂNSIZ KILIYORDU.
 * Kök neden: worker'ın indirme döngüsü klip TÜRÜNE bakmadan HER varlıkta video
 * akışı arıyordu (LUT hariç).
 *
 * Neden bu test BURADA (birim testi neden yetmez): worker'ın birim testleri
 * `ExportAssetSource`'u doğrudan veriyor, yani indirme+ffprobe döngüsüne HİÇ
 * girmiyorlar — kusur tam olarak o döngüdeydi. Backend tarafında karşılığı
 * `ExportJobPipelineTests.Export_MusicOnAnAudioTrack_…` (gerçek MinIO + gerçek
 * ffmpeg). Bu dosya ise kullanıcının GÖRDÜĞÜ yolu koşar: gerçek dosya seçici,
 * gerçek fare çift tıkı, gerçek "Dışa Aktar" penceresi ve İNDİRİLEN MP4.
 *
 * KANIT ÇITASI: "iş Tamamlandı" YETMEZ ve "çıktıda ses stream'i var" da yetmez —
 * dijital sessizlik de bir stream'dir. İndirilen dosyanın ORTALAMA SEVİYESİ
 * ölçülür (ffmpeg volumedetect).
 *
 * KURAL (docs/review-gate.md §3): yalnız page.mouse.* / page.keyboard.*.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness } from './support/library';
import {
  FFMPEG_SKIP_REASON,
  ensureTestAudio,
  ffmpegVersion,
  probeMeanVolumeDb,
  probeStreamKinds,
} from './support/media';
import { createEmptyProject } from './support/projects';

/** e2e/.artifacts/media — support/media.ts ile aynı klasör (gitignore). */
const ARTIFACT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/** Dokümandaki klipler (kind + track türü) — salt okunur doğrulama. */
async function clipsOf(
  page: Page,
): Promise<{ id: string; kind: string; trackType: string; durationUs: number }[]> {
  return page.evaluate(() => {
    const bridge = (
      window as unknown as {
        __ve: {
          doc: {
            useDocStore: {
              getState(): {
                doc: {
                  tracks: {
                    type: string;
                    clips: { id: string; kind: string; timelineDurationUs: number }[];
                  }[];
                };
              };
            };
          };
        };
      }
    ).__ve;
    const out: { id: string; kind: string; trackType: string; durationUs: number }[] = [];
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        out.push({
          id: clip.id,
          kind: clip.kind,
          trackType: track.type,
          durationUs: clip.timelineDurationUs,
        });
      }
    }
    return out;
  });
}

async function doubleClickRow(
  page: Page,
  library: LibraryPanelHarness,
  fileName: string,
): Promise<void> {
  const box = await library.row(fileName).boundingBox();
  expect(box, `Kitaplıkta "${fileName}" satırı görünmüyor.`).not.toBeNull();
  const point = { x: box!.x + 40, y: box!.y + box!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
}

test.describe('Ses/müzik dışa aktarma — gerçek fare, gerçek medya, gerçek çıktı', () => {
  test('kitaplığa yüklenen müzik timeline\'a eklenir ve dışa aktarılan MP4\'te GERÇEKTEN duyulur', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    const music = ensureTestAudio();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E müzik dışa aktarma',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // --- 1. GERÇEK yükleme: "Dosya seç" düğmesine gerçek tık -> dosya seçici ---
    await library.pickFiles([music.path]);
    await library.waitForReady(music.fileName);

    // --- 2. GERÇEK çift tık: ses varlığı SES track'ine düşer (addToTimeline) ---
    await doubleClickRow(page, library, music.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 15_000,
        message: 'Çift tık müziği timeline\'a EKLEMEDİ.',
      })
      .toBe(1);

    const clips = await clipsOf(page);
    expect(clips[0].kind, 'Ses varlığından SES klibi doğmalı.').toBe('audio');
    expect(clips[0].trackType, 'Ses klibi ses track\'ine düşmeli.').toBe('audio');

    // --- 3. GERÇEK dışa aktarma penceresi ---
    const exportPost = page.waitForResponse(
      (r) => r.url().includes('/exports') && r.request().method() === 'POST',
      { timeout: 90_000 },
    );
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();

    const posted = await exportPost;
    expect(
      posted.status(),
      'Yalnız ses içeren belge kuyruğa girmeliydi (ön kapı bunu kabul eder).',
    ).toBe(202);
    const { jobId } = (await posted.json()) as { jobId: string };

    // --- 4. İş GERÇEKTEN tamamlanmalı (202 tek başına kanıt değil: kusur tam da
    //        "202 → dakikalar sonra failed" idi) ---
    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Ses klibi içeren belge worker\'da render edilmeliydi. Kart "Başarısız" gösteriyorsa '
        + 'kusur geri gelmiştir (worker klip türüne bakmadan video akışı arıyor).',
    ).toBeVisible({ timeout: 300_000 });

    // --- 5. İNDİRİLEN DOSYA: ses akışı VAR ve GERÇEKTEN duyuluyor ---
    const job = (await (
      await account.context.request.get(`/api/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      })
    ).json()) as { status: string; downloadUrl: string | null };
    expect(job.status, 'İş satırı da "succeeded" demeli.').toBe('succeeded');
    expect(job.downloadUrl, 'Başarılı export indirme bağlantısı üretmeli.').toBeTruthy();

    const download = await account.context.request.get(job.downloadUrl!);
    expect(download.ok(), 'Presigned indirme başarısız.').toBe(true);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const outputPath = join(ARTIFACT_DIR, `e2e-muzik-export-${jobId}.mp4`);
    writeFileSync(outputPath, await download.body());

    const kinds = probeStreamKinds(outputPath);
    expect(kinds, 'İndirilen MP4 hem görüntü hem SES akışı taşımalı.').toContain('audio');
    expect(kinds).toContain('video');

    const meanDb = probeMeanVolumeDb(outputPath);
    expect(
      meanDb !== null && meanDb > -50,
      `İndirilen MP4 sessiz (mean_volume=${String(meanDb)} dBFS): ses akışı var ama müzik `
        + 'mikse girmemiş — yalnız stream sayan bir kontrol bunu göremezdi.',
    ).toBe(true);
  });
});
