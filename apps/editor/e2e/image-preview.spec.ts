/**
 * Fotoğraf ve çıkartma ÖNİZLEMEDE çiziliyor mu — GERÇEK fareyle, GERÇEK medyayla.
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR (POC teslim değerlendirmesi, iki YÜKSEK bulgu)
 * ---------------------------------------------------------------------------
 * 1) Görsel/sticker klipleri önizleme kompozitöründe HİÇ çizilmiyordu. Zincir
 *    tamamen sessizdi: worker görsel için proxy ÜRETMEZ
 *    (ProcessAssetJob.ProcessImageAsync — "Image için proxy ÜRETİLMEZ"),
 *    media-urls `proxy: null` döner, PlayerPanel kaynak olarak koşulsuz
 *    `proxyUrl` okur, engineV1.imageDrawItem URL yok diye erken döner. Hiçbir
 *    store'da "çizilemedi" diye bir alan yok; dışa aktarma ise DOĞRU çalışıyor.
 *    Yani tek dürüst kanıt PİKSEL'dir — bu dosya onu okur
 *    (`window.__videoeditPlayer.probePixel`, çizimle aynı karede gl.readPixels).
 *
 * 2) Timeline'a görsel eklemek şema değişmezini ihlal ediyordu:
 *    `sourceOutUs (4000000) exceeds asset duration (...)`. Kök neden sunucunun
 *    bildirdiği "görsel süresi"dir ve bu testin kullandığı İKİ dosya, sorunun
 *    İKİ farklı yüzünü birden üretir (yerelde ffprobe 8.0 ile ölçüldü):
 *      - PNG  -> `png_pipe` demuxer süre bildirmez -> API `durationMicros: null`
 *                -> JS'te `4000000 > null` TRUE.
 *      - JPEG -> `image2` demuxer 0.04 sn bildirir -> `durationMicros: 40000`
 *                -> null'a bakan bir düzeltmenin ELİNDEN KAÇAR.
 *    Fotoğrafın süresi dosyadan değil KLİPTEN gelir (4 sn), tıpkı dışa aktarma
 *    derleyicisinin `-loop 1` ile açtığı gibi (ExportClipPlan.IsStillInput).
 *    assertDocValidDev mutasyondan SONRA fırlattığı için hata ekranda değil
 *    konsolda patlıyordu ve yeni klibin seçilmesini kırıyordu — bu yüzden
 *    aşağıda hem seçim hem de sayfa hataları izleniyor.
 *
 * KURAL (docs/review-gate.md §3): yalnız page.mouse.* / page.keyboard.*.
 * Sentetik olay YOK. Medya GERÇEK: 'ready' rozetini yazan tek şey worker'ın
 * gerçek ffprobe/ffmpeg çıktısıdır, presigned poster URL'i de ancak o zaman
 * doğar — sahte asset ile bu zincirin hiçbir halkası test EDİLEMEZ.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTimelineDoc } from '@videoedit/timeline-schema';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { readProjectSettings } from './support/appBridge';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

const SECOND_US = 1_000_000;
/** timelineOps.IMAGE_DEFAULT_DURATION_US — fotoğraf klibinin doğduğu uzunluk. */
const IMAGE_CLIP_US = 4 * SECOND_US;

/** e2e/.artifacts/media — support/media.ts ile aynı klasör (gitignore). */
const MEDIA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '.artifacts', 'media');

interface TestImage {
  path: string;
  fileName: string;
  width: number;
  height: number;
}

/**
 * Test görselleri ffmpeg ile ÜRETİLİR (repoya ikili dosya konmaz; support/media.ts
 * ile aynı desen) ve koşumlar arasında yeniden kullanılır.
 *
 * İçerikler kasıtlı olarak FARKLI:
 *  - `foto` = testsrc2 karesi: her köşesi başka renkte, yani "gerçekten bir
 *    görüntü mü çizildi, yoksa düz bir dolgu mu?" sorusu piksel ÇEŞİTLİLİĞİ ile
 *    yanıtlanabilir (düz renkli bir kaynakta bu ayrım yapılamazdı);
 *  - `sticker` = DÜZ MACENTA: kompozisyonda başka hiçbir katmanın üretemeyeceği
 *    bir renk. Çıkartma, altındaki fotoğraf klibinin ÜSTÜNE eklendiğinde
 *    "macenta okundu" tek başına çıkartmanın çizildiğini kanıtlar — çeşitlilik
 *    ölçmeye gerek kalmaz, karışma ihtimali yoktur.
 */
function ensureTestImage(kind: 'foto' | 'sticker'): TestImage {
  const spec =
    kind === 'foto'
      ? {
          fileName: 'e2e-foto-640x480.jpg',
          width: 640,
          height: 480,
          input: 'testsrc2=size=640x480:rate=1:duration=1',
          extra: ['-q:v', '2'],
        }
      : {
          fileName: 'e2e-sticker-magenta.png',
          width: 320,
          height: 320,
          input: 'color=c=magenta:size=320x320:rate=1:duration=1',
          extra: [] as string[],
        };
  const path = join(MEDIA_DIR, spec.fileName);
  if (!existsSync(path)) {
    if (ffmpegVersion() === null) throw new Error(FFMPEG_SKIP_REASON);
    mkdirSync(MEDIA_DIR, { recursive: true });
    const res = spawnSync(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', spec.input,
       '-frames:v', '1', ...spec.extra, path],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (res.status !== 0 || !existsSync(path)) {
      throw new Error(`Test görseli üretilemedi (ffmpeg exit ${res.status}):\n${res.stderr}`);
    }
  }
  expect(statSync(path).size, `${spec.fileName} boş üretilmiş.`).toBeGreaterThan(0);
  return { path, fileName: spec.fileName, width: spec.width, height: spec.height };
}

type Rgba = [number, number, number, number];

/**
 * Önizleme kompozitöründen tek piksel (PROJE koordinatı). Motor isteği bir
 * sonraki ÇİZİM karesinde, render()'ın hemen ardından karşılar; canvas'ın
 * çizim tamponu korunmadığı için dışarıdan okumanın başka yolu yoktur.
 */
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
  expect(
    value,
    'window.__videoeditPlayer yok — önizleme motoru DEV köprüsünü kurmadı ' +
      '(Vite DEV sunucusuna bağlanıldığından emin olun).',
  ).not.toBeNull();
  return value as Rgba;
}

/**
 * Kaynağın kompozisyon içindeki YERLEŞİMİ (rendering-semantics §2.2, fit=contain)
 * — örnekleme noktaları buradan türetilir ki test letterbox bandını "siyah kare"
 * diye okuyup kendi kendini kandırmasın.
 */
function containRect(
  comp: { width: number; height: number },
  src: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const s = Math.min(comp.width / src.width, comp.height / src.height);
  const w = src.width * s;
  const h = src.height * s;
  return { x: (comp.width - w) / 2, y: (comp.height - h) / 2, width: w, height: h };
}

interface Sample {
  /** Örneklenen noktalar. */
  points: { x: number; y: number; rgba: Rgba }[];
  /** Farklı RGB üçlüsü sayısı. */
  unique: number;
  /** Tam siyah OLMAYAN nokta sayısı. */
  nonBlack: number;
}

/** Yerleşim dikdörtgeninin içinden (kenarlardan %15 içeride) 5x5 ızgara örneği. */
async function sampleRect(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Sample> {
  const points: Sample['points'] = [];
  const seen = new Set<string>();
  let nonBlack = 0;
  for (let iy = 0; iy < 5; iy++) {
    for (let ix = 0; ix < 5; ix++) {
      const x = Math.round(rect.x + rect.width * (0.15 + 0.175 * ix));
      const y = Math.round(rect.y + rect.height * (0.15 + 0.175 * iy));
      const rgba = await probePixel(page, x, y);
      points.push({ x, y, rgba });
      seen.add(`${rgba[0]},${rgba[1]},${rgba[2]}`);
      if (rgba[0] + rgba[1] + rgba[2] > 0) nonBlack++;
    }
  }
  return { points, unique: seen.size, nonBlack };
}

function describeSample(s: Sample): string {
  return s.points
    .slice(0, 6)
    .map((p) => `(${p.x},${p.y})=rgb(${p.rgba[0]},${p.rgba[1]},${p.rgba[2]})`)
    .join(' ');
}

/** Klibin dokümandaki hali (kind + zaman aralığı) — salt okunur doğrulama. */
async function clipsOf(page: Page): Promise<
  { id: string; kind: string; trackType: string; startUs: number; durationUs: number }[]
> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): {
              doc: {
                tracks: {
                  type: string;
                  clips: {
                    id: string;
                    kind: string;
                    timelineStartUs: number;
                    timelineDurationUs: number;
                  }[];
                }[];
              };
            };
          };
        };
      };
    }).__ve;
    const out: {
      id: string;
      kind: string;
      trackType: string;
      startUs: number;
      durationUs: number;
    }[] = [];
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        out.push({
          id: clip.id,
          kind: clip.kind,
          trackType: track.type,
          startUs: clip.timelineStartUs,
          durationUs: clip.timelineDurationUs,
        });
      }
    }
    return out;
  });
}

/**
 * Doküman değişmezleri, UYGULAMANIN KENDİ asset süre haritasıyla.
 *
 * İki parça da uygulamadan gelir, test ikinci bir kural seti KURMAZ:
 *  - doküman ve `knownAssetDurations()` sayfadan okunur (ops modülü değişken
 *    üzerinden import edilir — player-gizmo.spec.ts ile aynı desen: TS modül
 *    çözümlemesi devre dışı, runtime'da Vite dev grafiğinden çözülür, yani
 *    ekrandaki uygulamanın AYNI modül örneği);
 *  - doğrulama Node tarafında paylaşılan şema paketiyle yapılır
 *    (transitions-image.spec.ts ile aynı desen).
 * Süre haritasının uygulamadan okunması şart: düzeltilen şey tam olarak o
 * haritanın fotoğraflar için ne bildirdiğidir.
 */
async function docInvariantIssues(page: Page): Promise<string[]> {
  const snapshot = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    const specifier = '/src/state/timelineOps.ts';
    const ops = (await import(/* @vite-ignore */ specifier)) as unknown as {
      knownAssetDurations(): Map<string, number>;
    };
    return {
      doc: JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as unknown,
      durations: [...ops.knownAssetDurations()] as [string, number][],
    };
  });
  const result = validateTimelineDoc(snapshot.doc, new Map(snapshot.durations));
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/**
 * Kitaplık satırına GERÇEK çift tık — satırın SOL tarafından.
 *
 * Neden harness'in `doubleClickAsset`'i değil: o satırın TAM ORTASINA tıklar ve
 * bir GÖRSEL satırında oranın üstünde "Sticker" düğmesi durur (LibraryPanel:
 * `asset-add-sticker`, yalnız `kind === 'image'` satırlarında var). Çift tık
 * oraya düşünce iki ayrı `onClick` iki ÇIKARTMA ekliyor ve klip timeline'a hiç
 * girmiyor — ilk koşumda tam olarak bu oldu. Video satırlarında o düğme
 * olmadığı için diğer testler bunu görmez; sürükleme testi de aynı sebeple
 * satırı `x + 40`'tan yakalar (library-dnd.spec.ts).
 */
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

/**
 * Cetvele gerçek tıkla playhead'i taşır ve GERÇEKTEN oraya gittiğini doğrular.
 * Zoom/scroll yüzünden hedef zamanın ekran koordinatı timeline'ın dışına
 * düşerse tıklama komşu panele gider ve test sessizce anlamını kaybederdi.
 */
async function scrubAndVerify(page: Page, app: EditorApp, timeUs: number): Promise<void> {
  const wrap = await app.timeline.wrapBox();
  const inside = (p: { x: number }) => p.x > wrap.x + 8 && p.x < wrap.x + wrap.width - 8;
  let point = await app.timeline.rulerPoint(timeUs);
  if (!inside(point)) {
    // GERÇEK klavye: Shift+Z görünümü projeye sığdırır (shortcuts/dispatcher.ts
    // -> viewControl.fitToProject). Düğmeye tıklamak yerine kısayol, çünkü
    // düğmenin erişilebilir adı "Fit", başlığı "Sığdır" — locator seçimi bu
    // testin konusu değil.
    await page.keyboard.press('Shift+Z');
    await page.waitForTimeout(250);
    point = await app.timeline.rulerPoint(timeUs);
  }
  expect(
    inside(point),
    `${timeUs} µs timeline görünümünün dışında (x=${Math.round(point.x)}, ` +
      `görünüm ${Math.round(wrap.x)}..${Math.round(wrap.x + wrap.width)}): cetvele ` +
      'tıklamak komşu panele giderdi.',
  ).toBe(true);

  await app.timeline.click(point);
  const state = await app.state();
  const toleranceUs = 40 / state.pxPerUs; // ~40 px'lik hedefleme payı
  expect(
    Math.abs(state.playheadUs - timeUs),
    `Playhead ${timeUs} µs'ye taşınamadı (gerçek ${state.playheadUs} µs): cetvel tıklaması ` +
      'hedefi ıskaladı, sonraki piksel iddiaları yanlış zamanı ölçerdi.',
  ).toBeLessThan(toleranceUs);
}

test.describe('Görsel/çıkartma önizlemesi — gerçek fare, gerçek medya, gerçek piksel', () => {
  test('fotoğraf ve çıkartma önizleme canvas\'ında GERÇEKTEN çizilir', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(300_000);

    // Konsola düşen her hata toplanır: assertDocValidDev mutasyondan SONRA
    // fırlatıyordu, yani ekranda hiçbir iz bırakmadan olay işleyicisini
    // patlatıyordu. Ekranı izleyen bir test bunu göremezdi.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    const foto = ensureTestImage('foto');
    const sticker = ensureTestImage('sticker');
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E görsel önizleme',
    );

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // --- GERÇEK yükleme: "Dosya seç" düğmesine gerçek tık -> dosya seçici ---
    await library.pickFiles([foto.path, sticker.path]);
    await library.waitForReady(foto.fileName);
    await library.waitForReady(sticker.fileName);

    // --- ÖN KOŞUL: sunucunun bildirdiği "görsel süresi" geçerli bir üst sınır DEĞİL ---
    // Bu bulgunun çekirdeği. Doğrulanan şey ffprobe'un tam çıktısı değil (sürüm
    // sürüm değişebilir), İDDİA edilebilir olan: bir fotoğrafın dosya süresi
    // 4 sn'lik klibi kısıtlayamaz. Değer 4 sn'ye çıkarsa bu ön koşul kırmızı
    // olur — istenen budur, çünkü hatanın şekli değişmiş demektir.
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    expect(assets, 'İki görsel de sunucuda görünmeli.').toHaveLength(2);
    const reported = assets.map((a) => `${a.fileName}: ${String(a.durationMicros)}`).join(', ');
    for (const a of assets) {
      expect(
        a.durationMicros == null || a.durationMicros < IMAGE_CLIP_US,
        `Ön koşul kayboldu — sunucu "${a.fileName}" için kliple uyumlu bir süre bildiriyor ` +
          `(${reported}). Bulgunun şekli değişmiş olabilir.`,
      ).toBe(true);
    }

    // --- Fotoğrafı timeline'a ekle: GERÇEK çift tık ---
    await doubleClickRow(page, library, foto.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 15_000,
        message: 'Çift tık fotoğrafı timeline\'a EKLEMEDİ.',
      })
      .toBe(1);

    // Başlıktaki 2. bulgu: doküman kendi değişmezlerinden geçmeli VE yeni klip seçili
    // olmalı. Eskiden mutasyon commit ediliyor, hemen ardından assertDocValidDev
    // fırlıyor ve setSelection'a hiç sıra gelmiyordu.
    const afterFoto = await clipsOf(page);
    expect(afterFoto[0].kind).toBe('image');
    expect(afterFoto[0].trackType).toBe('video');
    expect(afterFoto[0].startUs).toBe(0);
    expect(afterFoto[0].durationUs, 'Fotoğrafın süresi KLİPTEN gelir (4 sn).').toBe(IMAGE_CLIP_US);
    expect(await docInvariantIssues(page), 'Editör kendi reddedeceği bir doküman yazdı.').toEqual(
      [],
    );
    expect(
      (await app.state()).selection,
      'Yeni eklenen klip SEÇİLİ olmalı (değişmez ihlali seçimi kırıyordu).',
    ).toEqual([afterFoto[0].id]);

    // --- Çıkartma kaynağını da timeline'a ekle (2. görsel: PNG) ---
    // Playhead 0'da ve video track'i dolu -> ekleme proje SONUNA düşer (4 sn).
    await doubleClickRow(page, library, sticker.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, { timeout: 15_000 })
      .toBe(2);
    const afterBoth = await clipsOf(page);
    const pngClip = afterBoth.find((c) => c.startUs === IMAGE_CLIP_US);
    expect(pngClip, 'İkinci görsel klip proje sonuna eklenmeliydi.').toBeTruthy();
    expect(await docInvariantIssues(page)).toEqual([]);

    // ---------------------------------------------------------------------
    // ASIL İDDİA (başlıktaki 1. bulgu): fotoğraf klibinin ÜSTÜNDE piksel var mı?
    // ---------------------------------------------------------------------
    const settings = await readProjectSettings(page);
    const fotoRect = containRect(settings, foto);
    await scrubAndVerify(page, app, 2 * SECOND_US);

    // Doku çözme ASENKRON (img.onload -> GPU upload): ilk kare kaçabilir.
    await expect
      .poll(async () => (await sampleRect(page, fotoRect)).nonBlack, {
        timeout: 20_000,
        message:
          'Fotoğraf klibinin üstünde önizleme SİMSİYAH: görsel hiç çizilmiyor ' +
          '(kaynak URL seçimi görsele proxy soruyor, worker ise görsele proxy üretmiyor).',
      })
      .toBeGreaterThan(0);

    const fotoSample = await sampleRect(page, fotoRect);
    expect(
      fotoSample.nonBlack,
      `Kutunun içindeki 25 noktanın ${25 - fotoSample.nonBlack} tanesi hâlâ siyah. ` +
        describeSample(fotoSample),
    ).toBe(25);
    // Çeşitlilik: kaynak testsrc2 karesi. Düz bir dolgu (ör. arka plan rengi)
    // "siyah değil" testini geçerdi, bu geçemez.
    expect(
      fotoSample.unique,
      `Önizlemede renk çeşitliliği yok (${fotoSample.unique} farklı renk): çizilen şey ` +
        `kaynak görüntü değil, düz bir dolgu. ${describeSample(fotoSample)}`,
    ).toBeGreaterThanOrEqual(4);

    // Letterbox bandı hâlâ siyah olmalı — yani "her yer beyaz" gibi bir
    // yanlış-pozitif değil, gerçekten YERİNE oturmuş bir görüntü var.
    const bandX = Math.round(fotoRect.x / 2);
    const band = await probePixel(page, bandX, Math.round(settings.height / 2));
    expect(
      band[0] + band[1] + band[2],
      `Letterbox bandı (${bandX}) da boyanmış: örneklenen bölge görüntü değil, ekranın tamamı.`,
    ).toBe(0);

    // İkinci klip (PNG, süresi sunucuda null) da çizilmeli.
    const pngRect = containRect(settings, sticker);
    await scrubAndVerify(page, app, 6 * SECOND_US);
    await expect
      .poll(async () => (await sampleRect(page, pngRect)).nonBlack, {
        timeout: 20_000,
        message: 'Süresi null bildirilen PNG klibi önizlemede çizilmiyor.',
      })
      .toBe(25);
    const pngSample = await sampleRect(page, pngRect);
    for (const p of pngSample.points) {
      expect(
        p.rgba[0] > 200 && p.rgba[2] > 200 && p.rgba[1] < 80,
        `PNG klibi macenta olmalıydı, okunan rgb(${p.rgba.slice(0, 3).join(',')}) @${p.x},${p.y}.`,
      ).toBe(true);
    }

    // ---------------------------------------------------------------------
    // ÇIKARTMA: aynı görsel asset, overlay katmanında StickerClip olarak.
    // Fotoğraf klibinin ÜSTÜNE eklenir; macenta okunması tek başına
    // çıkartmanın çizildiğini kanıtlar (alttaki kaynak testsrc2, macenta üretmez).
    // ---------------------------------------------------------------------
    await scrubAndVerify(page, app, 2 * SECOND_US);
    const stickerButton = library.row(sticker.fileName).getByTestId('asset-add-sticker');
    const buttonBox = await stickerButton.boundingBox();
    expect(buttonBox, 'Görsel satırında "Sticker" düğmesi yok.').not.toBeNull();
    await page.mouse.move(buttonBox!.x + buttonBox!.width / 2, buttonBox!.y + buttonBox!.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    await expect
      .poll(async () => (await clipsOf(page)).filter((c) => c.kind === 'sticker').length, {
        timeout: 15_000,
        message: '"Sticker" düğmesi overlay katmanına çıkartma eklemedi.',
      })
      .toBe(1);
    const stickerClip = (await clipsOf(page)).find((c) => c.kind === 'sticker')!;
    expect(stickerClip.trackType).toBe('overlay');
    expect(await docInvariantIssues(page)).toEqual([]);

    const stickerRect = containRect(settings, sticker);
    await expect
      .poll(
        async () => {
          const c = await probePixel(page, Math.round(settings.width / 2), Math.round(settings.height / 2));
          return c[0] > 200 && c[2] > 200 && c[1] < 80;
        },
        {
          timeout: 20_000,
          message:
            'Çıkartma önizlemede çizilmiyor: fotoğraf klibinin üstüne macenta bir katman ' +
            'eklendiği halde kompozisyonun merkezinde macenta yok.',
        },
      )
      .toBe(true);
    const stickerSample = await sampleRect(page, stickerRect);
    for (const p of stickerSample.points) {
      expect(
        p.rgba[0] > 200 && p.rgba[2] > 200 && p.rgba[1] < 80,
        `Çıkartma alanı macenta değil: rgb(${p.rgba.slice(0, 3).join(',')}) @${p.x},${p.y}.`,
      ).toBe(true);
    }

    // --- Sessiz patlama olmadı mı? ---
    const invariantErrors = pageErrors.filter((m) =>
      /invariant|exceeds asset duration|frame-grid/i.test(m),
    );
    expect(
      invariantErrors,
      `Doküman değişmezi ihlali konsola düştü:\n  ${invariantErrors.join('\n  ')}`,
    ).toEqual([]);
  });
});

test.describe('Görselli proje media-urls yoklaması (BG-2)', () => {
  /**
   * Worker görsele proxy ÜRETMEZ (yalnız poster). "Hazır asset'in URL'ü eksik
   * mi" kuralı yalnız proxyUrl'e bakınca ready görsel KALICI olarak "url'süz"
   * sayılıyordu ve sekme /media-urls ucunu ~5 sn'de bir süresiz yokluyordu
   * (canlı ölçüm: 40 sn'de 8 istek, tam 5,0 sn aralık). Buradaki kanıt ağ
   * katmanından: poster indikten sonraki 13 sn'lik pencerede uç en fazla bir
   * kez (yarıda kalmış ertelenmiş yenileme payı) çağrılabilir — eski kodda bu
   * pencereye 2-3 istek düşerdi.
   */
  test('hazır görselden sonra /media-urls yoklaması SUSAR', async ({ page, account }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    test.setTimeout(240_000);

    const foto = ensureTestImage('foto');
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E media-urls yoklama',
    );

    const mediaUrlHits: number[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/media-urls')) mediaUrlHits.push(Date.now());
    });

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    // GERÇEK yükleme -> worker gerçekten işler -> satır READY olur.
    await library.pickFiles([foto.path]);
    await library.waitForReady(foto.fileName);

    // READY geçişinin tetiklediği (meşru) ertelenmiş yenilemenin oturması için
    // throttle penceresinden uzun bekle; SONRA pencereyi ölçmeye başla.
    await page.waitForTimeout(6_500);
    const before = mediaUrlHits.length;
    expect(before, 'Açılış + ready sonrası en az bir media-urls çağrısı beklenir').toBeGreaterThan(0);

    await page.waitForTimeout(13_000);
    const during = mediaUrlHits.length - before;
    expect(
      during,
      `posterli görsel "url'süz" sayılmaya devam ediyor: 13 sn'lik pencerede ${during} ` +
        '/media-urls isteği (eski hatada ~5 sn aralıkla 2-3 istek düşerdi)',
    ).toBeLessThanOrEqual(1);
  });
});
