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
 *
 * Export İKİ bacaktır ve ikisi bilinçli olarak FARKLI ffmpeg yollarına düşer
 * (ClipEffects.LutBlendFilter xmldoc'u): intensity=1 bacağı düz lut3d üretir
 * (split/blend HİÇ kurulmaz), dyadik olmayan ~0.8 bacağı ise yerli blend'in
 * (all_mode=normal) canlı yolunu zorlar — o yol yalnız intensity<1'de var olur
 * ve ±1 LSB yuvarlama sınıfı tam da dyadik olmayan yoğunluklarda tetiklenir.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, Page } from '@playwright/test';
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

/**
 * Kısmî-yoğunluk bacağının yama yarı-boyu: 16×16 piksel — çift boyut yuv420'nin
 * 2×2 kroma bloklarıyla hizalıdır; ortalama, tek pikselde ±4-5 koda çıkabilen
 * kodlama gürültüsünü ~1 kodun altına indirir (degrade düz olduğundan yama
 * içeriği ortalamayı bozmaz).
 */
const PATCH_HALF = 8;
/**
 * Yama ORTALAMASI toleransı (kod değeri). ÖLÇÜLDÜ (2026-08-25, ilk koşum; sayılar
 * her koşumda [LUT KISMI] satırlarına yazılır): |ölçülen − kısmî-ref| iki yama ×
 * RGB'de 0,99-2,95 kod, tümü aynı yönde — kaynak x264'ün düz bölgelerdeki DC
 * nicemleme kayması; BLOK-korelasyonlu olduğundan yama ortalaması onu süzemez
 * (JPEG poster + yuv420 + ±1 LSB blend alt kümesi bunun içinde kalır). Ölçülen
 * 2,95'e ~1 kod koşumlar-arası pay.
 */
const PATCH_MEAN_TOLERANCE = 4.0;
/**
 * Kodlama yanlılığının üst bandı (yukarıdaki ölçümün zarfı): kısmîlik iddiasının
 * ayrıştırma-gücü muhafızında kullanılır — tam↔kısmî referans aralığı en az
 * PARTIAL_MARGIN + bu band olmalı ki "tam LUT" bir kodlama kayması ile kısmî
 * taklidi yapamasın (ve tersi: meşru kısmî kare tam'a yapışmış görünmesin).
 */
const ENCODE_BIAS_BOUND = 3.0;
/**
 * Kısmîlik payı: ölçülen yama ortalaması hem ham'dan hem tam LUT'tan en az bu
 * kadar uzak olmalı — "yoğunluk yok sayıldı" (tam) ve "LUT hiç inmedi" (ham)
 * gerilemelerinin ikisini de kırmızıya çevirir. YALNIZ B kanalında iddia edilir:
 * fixture'ın en güçlü kanalı odur (tealMap 0.3r+0.7b → |ΔB| ≈ 34-36 kod; R'de
 * ~23-24 kod, 0.8 yoğunlukta tam'a mesafe ~4,3 kod kalır ve ölçülen kodlama
 * yanlılığıyla ayırt edilemez). B'nin işareti iki yamada AYNALIDIR (sağda +,
 * solda −), dolayısıyla tek yönlü bir kodlama kayması kısmîliği iki yamada
 * birden taklit edemez; R ve G'yi oturma + zarf iddiaları sınırlamaya devam eder.
 */
const PARTIAL_MARGIN = 2.5;

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

/**
 * Export akışı (export-flow ile aynı sözleşme): dialog -> 202 -> "Tamamlandı" ->
 * İndir -> MP4'ü artefakt klasörüne yaz. İki export bacağının ortak gövdesi;
 * adımlar bacaklar arasında bire bir aynıdır ki fark YALNIZ yoğunluk olsun.
 */
async function exportAndDownload(
  page: Page,
  request: APIRequestContext,
  mp4Name: string,
): Promise<string> {
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
  const res = await request.get(href!);
  expect(res.status()).toBe(200);
  const body = await res.body();
  mkdirSync(ARTIFACTS, { recursive: true });
  const mp4Path = join(ARTIFACTS, mp4Name);
  writeFileSync(mp4Path, body);
  return mp4Path;
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

/** (cx,cy) merkezli 2H×2H yamanın kanal ortalamaları (alfa hariç). */
function patchMean(
  frame: { width: number; height: number; pixels: Uint8Array },
  cx: number,
  cy: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = cy - PATCH_HALF; y < cy + PATCH_HALF; y++) {
    for (let x = cx - PATCH_HALF; x < cx + PATCH_HALF; x++) {
      const i = (y * frame.width + x) * 4;
      r += frame.pixels[i];
      g += frame.pixels[i + 1];
      b += frame.pixels[i + 2];
    }
  }
  const n = 2 * PATCH_HALF * (2 * PATCH_HALF);
  return [r / n, g / n, b / n];
}

/**
 * Yamanın §4.2 CPU referans ortalaması: LUT'suz BASE karesinin her pikseli formülden
 * geçirilir (önce piksel başına 8-bit niceleme, sonra ortalama — ölçülen export
 * yamasına uygulanan sırayla aynı).
 */
function referencePatchMean(
  lut: CubeLut,
  baseFrame: { width: number; height: number; pixels: Uint8Array },
  cx: number,
  cy: number,
  intensity: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = cy - PATCH_HALF; y < cy + PATCH_HALF; y++) {
    for (let x = cx - PATCH_HALF; x < cx + PATCH_HALF; x++) {
      const i = (y * baseFrame.width + x) * 4;
      const [rr, gg, bb] = referencePixel(
        lut,
        [baseFrame.pixels[i], baseFrame.pixels[i + 1], baseFrame.pixels[i + 2], 255],
        intensity,
      );
      r += rr;
      g += gg;
      b += bb;
    }
  }
  const n = 2 * PATCH_HALF * (2 * PATCH_HALF);
  return [r / n, g / n, b / n];
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
    const mp4Path = await exportAndDownload(page, account.context.request, 'lut-export.mp4');

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

  test('yoğunluk ~0.8 (dyadik DEĞİL) -> export karesi KISMÎ LUT taşır: ham ile tam arasında, §4.2 karışımına oturur', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(420_000);

    // İlk bacaktan farkı SADECE yoğunluktur ve bu fark başka bir ffmpeg yoludur:
    // intensity=1 export'u düz lut3d üretir (split/blend hiç kurulmaz), dyadik
    // olmayan ~0.8 ise worker'ın YERLİ blend yolunu (ClipEffects.LutBlendFilter,
    // all_opacity=1-I) gerçekten kurdurur. Bu bacak olmadan o canlı yol hiçbir
    // e2e'de koşmuyordu.
    const gradientPath = ensureGradientImage();
    const cubePath = ensureTealCube();
    const parsedCube = parseCubeLut(readFileSync(cubePath, 'utf8'));
    expect(parsedCube.ok, 'e2e .cube fixture kendi ayrıştırıcımızdan geçmeli').toBe(true);
    const lut = (parsedCube as { ok: true; lut: CubeLut }).lut;

    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E LUT yoğunluk',
    );
    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    await library.pickFiles([gradientPath, cubePath]);
    await library.waitForReady('e2e-lut-gradient.png');
    await library.waitForReady('e2e-teal-17.cube');
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const cubeAsset = assets.find((a) => a.fileName === 'e2e-teal-17.cube');
    expect(cubeAsset, 'cube asset listede yok').toBeTruthy();

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

    // ÖLÇÜM NOKTALARI: degrade yatayda r'yi tarar; tealMap'in deltası kenarlara
    // doğru büyür (ΔR=0.2(b−r), ΔB=0.3(r−b); b sabit ≈0.502). Sağ yamada ΔB≈+36,
    // solda ≈−34 kod — bandın üst ucunda bile "tam LUT'tan uzaklık" (1−I)·|ΔB| ≥
    // ~6,5 kod, ölçülen kodlama yanlılığı bandının (≤3 kod, PATCH_MEAN_TOLERANCE
    // başlığı) güvenle üzerinde. y=54 bilinçli üst satır: g≈0.05 → ΔG≈+11 kod,
    // G kanalının zarf kontrolü de anlamlı kalır (merkez satırda ΔG ≈ +6 koddu).
    const RIGHT: [number, number] = [1872, 54];
    const LEFT: [number, number] = [96, 54];

    await expect
      .poll(
        async () => {
          const px = await probePixel(page, RIGHT[0], RIGHT[1]);
          return px[0] > 200;
        },
        {
          timeout: 15_000,
          message: 'Önizleme görsel klibi çizmedi (sağ yama noktası koyu kaldı).',
        },
      )
      .toBe(true);

    // LUT'suz TAM taban karesi: ham/tam/kısmî yama referanslarının tek kaynağı.
    const baseFrame = await probeFrame(page);
    expect(baseFrame.width).toBe(1920);
    expect(baseFrame.height).toBe(1080);
    const baseAt = (x: number, y: number): Rgba => {
      const i = (y * baseFrame.width + x) * 4;
      return [
        baseFrame.pixels[i],
        baseFrame.pixels[i + 1],
        baseFrame.pixels[i + 2],
        baseFrame.pixels[i + 3],
      ];
    };
    const basePx = baseAt(RIGHT[0], RIGHT[1]);

    // LUT'u seç (gerçek <select>) ve önizleme TAM LUT'a otursun — yoğunluk jesti
    // bilinen bir durumdan başlasın.
    await page.getByTestId('clip-lut-select').selectOption(cubeAsset!.id);
    const expectedFull = referencePixel(lut, basePx, 1);
    await expect
      .poll(
        async () =>
          channelsClose(await probePixel(page, RIGHT[0], RIGHT[1]), expectedFull, CHANNEL_TOLERANCE),
        {
          timeout: 15_000,
          message: `Önizleme tam LUT'a oturmadı (beklenen ${expectedFull.join(',')}).`,
        },
      )
      .toBe(true);

    // ── YOĞUNLUK: gerçek fareyle ~0.8'e sürükle. Thumb yarım-genişliği inişi
    // ±0.02 kaydırabildiğinden [0.77, 0.81] bandına gerçek KLAVYE oklarıyla
    // (adım 0.01; ok tuşları da ürün yoludur — PropertyFields: jest açmadan düz
    // op'a düşerler) çekilir. Banttaki 0.01 adımlı hiçbir değer dyadik değildir.
    // Üst sınır 0.81 bilinçli (ilk koşum 0.82'ye indi ve ölçtürdü): tam'a mesafe
    // (1−I)·|Δ| kodlama yanlılığı bandını yeterince aşacak kadar kalmalı.
    await dragSlider(page, 'clip-lut-intensity', 0.8);
    const readIntensity = async (): Promise<number> =>
      (await readClipEffects(page, clipId)).find((e) => e.type === 'lut')!.params.intensity!;
    let intensity = await readIntensity();
    for (let i = 0; i < 8 && (intensity < 0.77 || intensity > 0.81); i++) {
      await page
        .getByTestId('clip-lut-intensity')
        .press(intensity < 0.77 ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForTimeout(80);
      intensity = await readIntensity();
    }
    expect(intensity, 'yoğunluk yazımı hedef banda inmedi').toBeGreaterThanOrEqual(0.77);
    expect(intensity, 'yoğunluk yazımı hedef banda inmedi').toBeLessThanOrEqual(0.81);
    // Dyadik muhafızı: I·64 tam sayı olsaydı (0.75, 0.8125…) yerli blend'in ±1 LSB
    // yuvarlama sınıfı hiç tetiklenmez, bacak amacını kaybederdi — slider adımı ya
    // da band ileride değişirse sessizce dyadiğe düşmeyelim.
    expect(
      Number.isInteger(intensity * 64),
      `yoğunluk ${intensity} dyadik — dyadik olmayan bacak anlamını yitirir`,
    ).toBe(false);
    expectDocValid(await readDoc(page), 'yoğunluk yazımı sonrası');

    // Önizleme kısmî karışıma oturuyor (mix'in canlı GPU yolu).
    const expectedMid = referencePixel(lut, basePx, intensity);
    await expect
      .poll(
        async () =>
          channelsClose(await probePixel(page, RIGHT[0], RIGHT[1]), expectedMid, CHANNEL_TOLERANCE),
        {
          timeout: 10_000,
          message: `Önizleme ${intensity} karışımına oturmadı (beklenen ${expectedMid.join(',')}).`,
        },
      )
      .toBe(true);

    // ── EXPORT: aynı sözleşme, farklı dosya adı (ilk bacağın artefaktını ezmesin).
    const mp4Path = await exportAndDownload(
      page,
      account.context.request,
      'lut-export-int08.mp4',
    );
    const exportFrame = extractFirstFrameRgba(mp4Path, 'lut-export-int08-frame.rgba');
    expect(exportFrame.width).toBe(1920);
    expect(exportFrame.height).toBe(1080);

    // ── KISMÎ UYGULAMA — yama ortalamalarıyla üç iddia: (1) her kanal §4.2'nin
    // öngördüğü karışım değerine oturur, (2) her kanal ham ile tam LUT zarfının
    // içindedir (±1 LSB payı), (3) aynalı güçlü kanal B ne ham ne tam'dır
    // (gerçek kısmîlik; kanal seçiminin gerekçesi PARTIAL_MARGIN başlığında).
    for (const [label, [cx, cy]] of [
      ['sağ', RIGHT],
      ['sol', LEFT],
    ] as const) {
      const measured = patchMean(exportFrame, cx, cy);
      const refBase = patchMean(baseFrame, cx, cy);
      const refFull = referencePatchMean(lut, baseFrame, cx, cy, 1);
      const refMid = referencePatchMean(lut, baseFrame, cx, cy, intensity);
      const fmt = (v: readonly number[]): string => v.map((c) => c.toFixed(2)).join(',');
      // Rapor daima yazılır — eşik geçse de sayılar görünür kalsın (parite deseni).
      console.log(
        `[LUT KISMI ${label}] I=${intensity} ölçülen=${fmt(measured)} ham=${fmt(refBase)} ` +
          `kısmî-ref=${fmt(refMid)} tam-ref=${fmt(refFull)}`,
      );

      for (const c of [0, 1, 2] as const) {
        const ch = 'RGB'[c];
        expect(
          Math.abs(measured[c] - refMid[c]),
          `${label} yama ${ch}: ölçülen ${measured[c].toFixed(2)} kısmî referansa oturmadı ` +
            `(beklenen ${refMid[c].toFixed(2)} ±${PATCH_MEAN_TOLERANCE})`,
        ).toBeLessThanOrEqual(PATCH_MEAN_TOLERANCE);

        const lo = Math.min(refBase[c], refFull[c]) - 1;
        const hi = Math.max(refBase[c], refFull[c]) + 1;
        expect(
          measured[c] >= lo && measured[c] <= hi,
          `${label} yama ${ch}: ölçülen ${measured[c].toFixed(2)} ham↔tam zarfının dışında ` +
            `[${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
        ).toBe(true);
      }

      // Kısmîlik yalnız B'de iddia edilir — gerekçe PARTIAL_MARGIN başlığında
      // (en güçlü ve iki yamada aynalı kanal; R/G'yi oturma + zarf sınırlar).
      const B = 2;
      // Ayrıştırma gücü muhafızı: fixture/nokta/band ileride değişir de kanal
      // deltası küçülürse kısmîlik iddiası sessizce boşalmasın — önce referans
      // aralıklarının kendisi denetlenir. Tam tarafında eşik, payın üstüne
      // ölçülen kodlama yanlılığı bandını da koyar: tam-LUT'a inmiş bir kare
      // salt kodlama kaymasıyla "kısmî" sayılamaz (ve meşru kısmî kare kaymayla
      // tam'a yapışmış görünemez).
      expect(
        Math.abs(refFull[B] - refMid[B]),
        `${label} yama B: tam↔kısmî referans aralığı ayrıştırıcı değil`,
      ).toBeGreaterThanOrEqual(PARTIAL_MARGIN + ENCODE_BIAS_BOUND);
      expect(
        Math.abs(refBase[B] - refMid[B]),
        `${label} yama B: ham↔kısmî referans aralığı ayrıştırıcı değil`,
      ).toBeGreaterThanOrEqual(10);

      expect(
        Math.abs(measured[B] - refBase[B]),
        `${label} yama B: export HAM görünüyor (LUT hiç uygulanmamış)`,
      ).toBeGreaterThanOrEqual(PARTIAL_MARGIN);
      expect(
        Math.abs(measured[B] - refFull[B]),
        `${label} yama B: export TAM LUT görünüyor (yoğunluk yok sayılmış)`,
      ).toBeGreaterThanOrEqual(PARTIAL_MARGIN);
    }
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
