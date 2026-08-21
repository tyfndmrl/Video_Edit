/**
 * LUT (.cube) — GERÇEK fare/klavye ile uçtan uca (rendering-semantics §4.2).
 *
 * review-gate kural 3: burada dispatchEvent/sentetik olay YOKTUR; dosya seçimi
 * gerçek tıklama + tarayıcının dosya seçicisiyle, efekt seçimi gerçek
 * <select>/slider/switch jestleriyle yapılır. Store yalnız DOĞRULAMA için okunur.
 *
 * Piksel iddiaları iki referansa oturur:
 *  - önizleme: engine.probePixel (çizimle aynı karede gl.readPixels) ↔ §4.2'nin
 *    CPU eşi (src/features/player/lut/cubeLut.sampleCubeLut) — BASE pikseli
 *    ölçülür, beklenen LUT'lu piksel ondan türetilir;
 *  - export: indirilen MP4'ün İLK karesi (ffmpeg rawvideo) ↔ önizlemenin AYNI
 *    karesi (probeFrameBase64) — §9.3 eşikleri: SSIM(gri, global) ≥ 0.98 +
 *    kanal başına fark raporu.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { validateTimelineDoc } from '@videoedit/timeline-schema';
import { parseCubeLut, sampleCubeLut, type CubeLut } from '../src/features/player/lut/cubeLut';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import {
  channelDiffStats,
  ensureBrokenCube,
  ensureGradientImage,
  ensureTealCube,
  extractFirstFrameRgba,
  ssimGray,
} from './support/lutMedia';
import { createEmptyProject } from './support/projects';

const ARTIFACTS = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

/** Kanal toleransı: 8-bit niceleme + JPEG poster + GPU float (±3 kod değeri). */
const CHANNEL_TOLERANCE = 3;

type Rgba = [number, number, number, number];

async function probePixel(page: Page, x: number, y: number): Promise<Rgba> {
  const value = await page.evaluate(
    async ([px, py]: [number, number]) => {
      const hook = (window as unknown as {
        __videoeditPlayer?: { version: number; probePixel(x: number, y: number): Promise<number[]> };
      }).__videoeditPlayer;
      if (!hook || hook.version !== 1) return null;
      return hook.probePixel(px, py);
    },
    [x, y] as [number, number],
  );
  expect(value, 'window.__videoeditPlayer yok (Vite DEV köprüsü kurulmadı).').not.toBeNull();
  return value as Rgba;
}

/** Önizlemenin TAM karesi (base64 RGBA -> Uint8Array). */
async function probeFrame(
  page: Page,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const value = await page.evaluate(async () => {
    const hook = (window as unknown as {
      __videoeditPlayer?: {
        version: number;
        probeFrameBase64?(): Promise<{ width: number; height: number; base64: string } | null>;
      };
    }).__videoeditPlayer;
    if (!hook?.probeFrameBase64) return null;
    return hook.probeFrameBase64();
  });
  expect(value, 'probeFrameBase64 köprüsü yok — motor tam-kare probu kurmadı.').not.toBeNull();
  const frame = value as { width: number; height: number; base64: string };
  // atob: Node 16+ global (Buffer'a şu yüzden gidilmiyor: e2e tsconfig'i @types/node
  // taşımaz — gerekçe node-shims.d.ts başlığında).
  const binary = atob(frame.base64);
  const pixels = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pixels[i] = binary.charCodeAt(i);
  return { width: frame.width, height: frame.height, pixels };
}

/** Gerçek fare tıklaması: öğenin kutusunun ortasına (speed-color ile aynı desen). */
async function clickReal(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.scrollIntoViewIfNeeded();
  await expect(el, `Öğe ekranda yok: ${testId}`).toBeVisible();
  const box = await el.boundingBox();
  expect(box, `Öğenin kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/** Bir range input'unu GERÇEK fareyle kutu oranına sürükler. */
async function dragSlider(page: Page, testId: string, toRatio: number): Promise<void> {
  const slider = page.getByTestId(testId);
  await slider.scrollIntoViewIfNeeded();
  await expect(slider, `Slider görünmüyor: ${testId}`).toBeVisible();
  const box = await slider.boundingBox();
  expect(box, `Slider kutusu okunamadı: ${testId}`).not.toBeNull();
  const y = box!.y + box!.height / 2;
  const fromX = box!.x + box!.width / 2;
  const toX = box!.x + box!.width * toRatio;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(fromX + Math.sign(toX - fromX || 1) * 4, y, { steps: 2 });
  await page.mouse.move(toX, y, { steps: 12 });
  await page.mouse.move(toX, y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

interface LutEffectProbe {
  type: string;
  enabled: boolean;
  params: { assetId?: string; intensity?: number };
}

/** Seçili tek klibin efekt listesi (yalnız doğrulama). */
async function readClipEffects(page: Page, clipId: string): Promise<LutEffectProbe[]> {
  const effects = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): { doc: { tracks: { clips: { id: string; effects: unknown[] }[] }[] } };
          };
        };
      };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === id) return JSON.parse(JSON.stringify(clip.effects)) as unknown[];
      }
    }
    return null;
  }, clipId);
  expect(effects, `Klip bulunamadı: ${clipId}`).not.toBeNull();
  return effects as LutEffectProbe[];
}

async function readDoc(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    return JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as unknown;
  });
}

function expectDocValid(doc: unknown, context: string): void {
  const result = validateTimelineDoc(doc);
  const issues = result.success
    ? ''
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  expect(result.success, `${context} — sözleşme ihlali:\n${issues}`).toBe(true);
}

function channelsClose(actual: readonly number[], expected: readonly number[], tol: number): boolean {
  return [0, 1, 2].every((i) => Math.abs(actual[i] - expected[i]) <= tol);
}

/** CPU referansı: 8-bit BASE pikselinden §4.2 formülüyle beklenen 8-bit piksel. */
function referencePixel(lut: CubeLut, base: Rgba, intensity: number): [number, number, number] {
  const out = sampleCubeLut(lut, { r: base[0] / 255, g: base[1] / 255, b: base[2] / 255 }, intensity);
  const to8 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [to8(out.r), to8(out.g), to8(out.b)];
}

test.describe('LUT (.cube) — kitaplık + Inspector + önizleme + export', () => {
  test('yükle -> Hazır -> uygula -> piksel §4.2 referansına oturur -> export karesi parite tutar', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    const gradientPath = ensureGradientImage();
    const cubePath = ensureTealCube();
    const cubeText = readFileSync(cubePath, 'utf8');
    const parsedCube = parseCubeLut(cubeText);
    expect(parsedCube.ok, 'e2e .cube fixture kendi ayrıştırıcımızdan geçmeli').toBe(true);
    const lut = (parsedCube as { ok: true; lut: CubeLut }).lut;

    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E LUT',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // ── 1) .CUBE ALIMI: gerçek dosya seçici, worker doğrulaması, "Hazır" rozeti.
    await library.pickFiles([gradientPath, cubePath]);
    await library.waitForReady('e2e-lut-gradient.png');
    await library.waitForReady('e2e-teal-17.cube');

    // Kitaplık satırı: LUT rozeti + "3D LUT" meta + görsel satırından farklı title.
    const lutRow = library.row('e2e-teal-17.cube');
    await expect(lutRow.getByText('LUT', { exact: true })).toBeVisible();
    await expect(lutRow.getByText(/3D LUT/)).toBeVisible();

    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const cubeAsset = assets.find((a) => a.fileName === 'e2e-teal-17.cube');
    const imageAsset = assets.find((a) => a.fileName === 'e2e-lut-gradient.png');
    expect(cubeAsset, 'cube asset listede yok').toBeTruthy();
    expect(imageAsset, 'görsel asset listede yok').toBeTruthy();

    // ── NEGATİF (gerçek çift tık): LUT satırı timeline'a KLİP olarak giremez.
    await library.doubleClickAsset('e2e-teal-17.cube');
    expect((await app.state()).clipCount, 'LUT çift tıkla klip OLMAMALI').toBe(0);

    // ── 2) görseli timeline'a koy (gerçek çift tık) ve seç.
    await library.doubleClickAsset('e2e-lut-gradient.png');
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 15_000 })
      .toBe(1);
    const stateAfterAdd = await app.state();
    const clipId = stateAfterAdd.tracks.flatMap((t) => t.clips)[0]!.id;
    if (stateAfterAdd.selection[0] !== clipId) {
      await app.ensureContentVisible(clipId);
      await app.timeline.click(await app.timeline.clipCenter(clipId));
    }
    expect((await app.state()).selection).toEqual([clipId]);

    // Önizleme kareyi çizene kadar bekle (poster decode async). Alfa her zaman
    // 255'tir (arka plan opak) — kanıt, prob noktasının SİYAH arka plandan
    // degradeye dönmesidir.
    //
    // PROB NOKTASI BİLİNÇLİ MERKEZ DEĞİL: tealMap (0.5, 0.5, 0.5) civarında
    // neredeyse sabit noktadır (ölçüldü — merkezde LUT'lu piksel base'in ±1
    // koduna düşüyor ve "piksel değişti" iddiası kanıtsız kalıyordu). Burada
    // degrade ≈ (0.8, 0.25, 0.5) verir; harita onu (0.74, 0.275, 0.59)'a taşır
    // (Δ ≈ −15/+6/+23 kod) — toleransın çok dışında, yön iki kanalda ters.
    const cx = 1536;
    const cy = 270;
    await expect
      .poll(
        async () => {
          const px = await probePixel(page, cx, cy);
          return px[0] > 100;
        },
        { timeout: 15_000, message: 'Önizleme görsel klibi çizmedi (prob noktası siyah kaldı).' },
      )
      .toBe(true);
    const base = await probePixel(page, cx, cy);

    // ── 3) Inspector LUT bölümü: bir .cube seç (gerçek <select> etkileşimi).
    const lutSection = page.getByTestId('clip-inspector-lut');
    await lutSection.scrollIntoViewIfNeeded();
    await expect(lutSection).toBeVisible();

    // Seçici YALNIZ .cube varlıklarını listeler (görsel asset seçenek DEĞİL).
    const optionValues = await page
      .getByTestId('clip-lut-select')
      .locator('option')
      .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    expect(optionValues).toContain(cubeAsset!.id);
    expect(optionValues).not.toContain(imageAsset!.id);

    await page.getByTestId('clip-lut-select').selectOption(cubeAsset!.id);

    // Belge: tek lut efekti, şemaya uygun, intensity 1.
    const effects = await readClipEffects(page, clipId);
    const lutEffects = effects.filter((e) => e.type === 'lut');
    expect(lutEffects).toHaveLength(1);
    expect(lutEffects[0].enabled).toBe(true);
    expect(lutEffects[0].params).toEqual({ assetId: cubeAsset!.id, intensity: 1 });
    expectDocValid(await readDoc(page), 'LUT seçimi sonrası');

    // ── ÖNİZLEME PİKSELİ DEĞİŞTİ ve §4.2 CPU referansına oturuyor.
    const expectedFull = referencePixel(lut, base, 1);
    await expect
      .poll(
        async () => {
          const px = await probePixel(page, cx, cy);
          return channelsClose(px, expectedFull, CHANNEL_TOLERANCE);
        },
        {
          timeout: 15_000,
          message: `Önizleme pikseli LUT referansına oturmadı. base=${base.join(',')} beklenen=${expectedFull.join(',')}`,
        },
      )
      .toBe(true);
    const lutted = await probePixel(page, cx, cy);
    expect(
      channelsClose(lutted, [base[0], base[1], base[2]], CHANNEL_TOLERANCE),
      `LUT pikseli DEĞİŞTİRMEDİ: ${lutted.join(',')} ≈ ${base.join(',')}`,
    ).toBe(false);

    // ── 4) YOĞUNLUK: slider'ı gerçek fareyle ~0.5'e çek; formül mix(base, lut, I).
    await dragSlider(page, 'clip-lut-intensity', 0.5);
    const midEffects = await readClipEffects(page, clipId);
    const midIntensity = midEffects.find((e) => e.type === 'lut')!.params.intensity!;
    expect(midIntensity).toBeGreaterThan(0.2);
    expect(midIntensity).toBeLessThan(0.8);
    const expectedMid = referencePixel(lut, base, midIntensity);
    await expect
      .poll(
        async () => channelsClose(await probePixel(page, cx, cy), expectedMid, CHANNEL_TOLERANCE),
        {
          timeout: 10_000,
          message: `Yoğunluk ${midIntensity} karışımı §4.2 formülüne oturmadı (beklenen ${expectedMid.join(',')}).`,
        },
      )
      .toBe(true);

    // ── 5) NEGATİF KONTROL (gerçek fare): LUT'u kapat -> piksel BASE'e döner.
    await clickReal(page, 'clip-lut-enabled');
    expect((await readClipEffects(page, clipId)).find((e) => e.type === 'lut')!.enabled).toBe(false);
    await expect
      .poll(
        async () =>
          channelsClose(await probePixel(page, cx, cy), [base[0], base[1], base[2]], CHANNEL_TOLERANCE),
        { timeout: 10_000, message: 'LUT kapatıldı ama piksel base görüntüye dönmedi.' },
      )
      .toBe(true);

    // Tekrar aç + tam yoğunluk (export bacağının bilinen durumu).
    await clickReal(page, 'clip-lut-enabled');
    await dragSlider(page, 'clip-lut-intensity', 1);
    const finalEffects = await readClipEffects(page, clipId);
    expect(finalEffects.find((e) => e.type === 'lut')!.params.intensity).toBe(1);
    await expect
      .poll(
        async () => channelsClose(await probePixel(page, cx, cy), expectedFull, CHANNEL_TOLERANCE),
        { timeout: 10_000 },
      )
      .toBe(true);
    expectDocValid(await readDoc(page), 'export öncesi');

    // Önizlemenin TAM karesi (parite ölçümünün sol yarısı) — playhead t=0, duraklatılmış.
    const previewFrame = await probeFrame(page);
    expect(previewFrame.width).toBe(1920);
    expect(previewFrame.height).toBe(1080);

    // ── 6) EXPORT: 202 -> Tamamlandı -> indir (export-flow ile aynı sözleşme).
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const exportsSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
      .first();
    const jobRow = exportsSection.locator('li').first();
    await expect(jobRow).toBeVisible({ timeout: 20_000 });
    await expect(
      jobRow.getByText('Tamamlandı', { exact: true }),
      'Export işi tamamlanmadı. Worker + ffmpeg ayakta mı?',
    ).toBeVisible({ timeout: 300_000 });
    await expect(jobRow.locator('p.text-danger')).toHaveCount(0);

    const download = jobRow.getByRole('link', { name: 'İndir' });
    const href = await download.getAttribute('href');
    expect(href).toBeTruthy();
    const res = await account.context.request.get(href!);
    expect(res.status()).toBe(200);
    const body = await res.body();
    mkdirSync(ARTIFACTS, { recursive: true });
    const mp4Path = join(ARTIFACTS, 'lut-export.mp4');
    writeFileSync(mp4Path, body);

    // ── 7) İNDİRİLEN DOSYADA LUT GERÇEKTEN VAR: ilk karenin merkezi §4.2
    //      referansındadır ve base'ten uzaktır (kanal takas değil, ölç!).
    const exportFrame = extractFirstFrameRgba(mp4Path, 'lut-export-frame.rgba');
    expect(exportFrame.width).toBe(1920);
    expect(exportFrame.height).toBe(1080);
    const at = (x: number, y: number): Rgba => {
      const i = (y * exportFrame.width + x) * 4;
      return [
        exportFrame.pixels[i],
        exportFrame.pixels[i + 1],
        exportFrame.pixels[i + 2],
        exportFrame.pixels[i + 3],
      ];
    };
    const exportCentre = at(cx, cy);
    expect(
      channelsClose(exportCentre, expectedFull, CHANNEL_TOLERANCE + 2),
      `Export karesi LUT referansına oturmadı: ölçülen ${exportCentre.join(',')}, beklenen ${expectedFull.join(',')} (±${CHANNEL_TOLERANCE + 2})`,
    ).toBe(true);
    expect(
      channelsClose(exportCentre, [base[0], base[1], base[2]], CHANNEL_TOLERANCE),
      'Export karesi LUT uygulanmamış görünüyor (base ile aynı).',
    ).toBe(false);

    // ── 8) PARİTE (§9.3): önizleme karesi ↔ export karesi.
    const ssim = ssimGray(previewFrame, exportFrame);
    const stats = channelDiffStats(previewFrame.pixels, exportFrame.pixels);
    // Rapor daima yazılır — eşik geçse de sayılar görünür kalsın.
    console.log(
      `[LUT PARITE] SSIM(gri,global)=${ssim.toFixed(5)} ` +
        `kanal|fark| ort=${stats.meanAbs.toFixed(3)} p99=${stats.p99} max=${stats.max}`,
    );
    expect(ssim, `SSIM ${ssim.toFixed(5)} < 0.98 (§9.3 statik/efekt eşiği)`).toBeGreaterThanOrEqual(
      0.98,
    );
    expect(
      stats.meanAbs,
      `Ortalama kanal farkı ${stats.meanAbs.toFixed(3)} > 2.0 kod değeri`,
    ).toBeLessThanOrEqual(2.0);
  });

  test('bozuk .cube "Başarısız" düşer (invalid-lut) — worker doğrulama kapısı', async ({
    page,
    account,
  }) => {
    test.setTimeout(180_000);
    const brokenPath = ensureBrokenCube();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E LUT bozuk',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([brokenPath]);

    // "Hazır" ASLA gelmemeli; "Başarısız" + tipli neden görünmeli.
    const row = library.row('e2e-broken.cube');
    await expect(row.getByText('Başarısız', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(row.getByText(/invalid-lut/)).toBeVisible();
    await expect(row.getByText('Hazır', { exact: true })).toHaveCount(0);
  });
});
