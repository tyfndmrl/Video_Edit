/**
 * M5 — klip HIZI ve RENK DÜZELTME, GERÇEK fare ve klavye ile.
 *
 * review-gate kural 3: bir etkileşimin "çalıştığı" ancak `page.mouse` /
 * `page.keyboard` ile doğrulanmışsa söylenebilir. Bu dosyada `dispatchEvent`,
 * sentetik PointerEvent veya store fonksiyonunu doğrudan çağırma YOKTUR;
 * store yalnız DOĞRULAMA için okunur.
 *
 * Renk tarafında doğrulama tek adım daha ileri gider: dokümana yazılan değeri
 * okumak "shader'a ulaştı" demek DEĞİLDİR — uniform GPU'da yaşar. Bu yüzden
 * önizleme kompozitöründen GERÇEK PİKSEL okunur (engine.probePixel, çizimle
 * aynı karede `gl.readPixels`) ve rendering-semantics §4.1'in CPU referansıyla
 * (src/features/player/core/colorAdjustRef.ts) karşılaştırılır. Ekrandaki
 * piksel ile normatif formül arasındaki fark ±2/255'i geçemez.
 */
import type { Page } from '@playwright/test';
import { clipTimelineDurationUs, validateTimelineDoc } from '@videoedit/timeline-schema';
import { applyColorAdjustRef } from '../src/features/player/core/colorAdjustRef';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** clipA [60s,66s) — playhead klibin ORTASINDA (şekil katmanı oraya düşer). */
const INSIDE_CLIP_A_US = 63 * SECOND_US;

/** Yeni şeklin varsayılan dolgusu (features/text/overlayDefaults). */
const SHAPE_FILL_RGB = { r: 0x5a, g: 0x8c, b: 0xff };

/**
 * GPU float ile CPU referansı arasında kabul edilen kanal farkı.
 * §4.1 notu 8-bit ara formatlar için ±1/255 diyor; texture yükleme + shader
 * yuvarlaması için bir kanal daha pay bırakıyoruz. Daha büyük hiçbir sapma
 * affedilmez — 3 birim fark zaten formül farkı demektir.
 */
const CHANNEL_TOLERANCE = 2;

interface ClipProbe {
  id: string;
  kind: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  sourceInUs?: number;
  sourceOutUs?: number;
  speed?: { rate: number };
  effects: { id: string; type: string; enabled: boolean; params: Record<string, number> }[];
}

async function readClip(page: Page, clipId: string): Promise<ClipProbe> {
  const probe = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: { tracks: { clips: { id: string }[] }[] } } } } };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === id) return JSON.parse(JSON.stringify(clip)) as unknown;
      }
    }
    return null;
  }, clipId);
  expect(probe, `Klip dokümanda bulunamadı: ${clipId}`).not.toBeNull();
  return probe as ClipProbe;
}

async function readDoc(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    return JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as unknown;
  });
}

/** Editörün ürettiği belge PAYLAŞILAN sözleşmeden geçmeli (export aynı kuralları koşar). */
function expectDocValid(doc: unknown, context: string): void {
  const result = validateTimelineDoc(doc);
  const issues = result.success
    ? ''
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  expect(result.success, `${context} — sözleşme ihlali:\n${issues}`).toBe(true);
}

/** Gerçek fare tıklaması: öğenin ekrandaki kutusunun ortasına. */
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

/**
 * Klavye kısayolları (Ctrl+Z dahil) bir input odaktayken BİLEREK devre dışıdır
 * (shortcuts/dispatcher.isEditableTarget). Slider sürükledikten sonra odak hâlâ
 * slider'dadır; panelin etkileşimsiz başlık alanına gerçek tıklama, kullanıcının
 * da yapacağı şeyi yapar.
 */
async function blurPanel(page: Page): Promise<void> {
  const identity = page.getByTestId('clip-inspector-identity');
  await identity.scrollIntoViewIfNeeded();
  const box = await identity.boundingBox();
  expect(box, 'Inspector kimlik bölümü görünmüyor.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 6);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
    .not.toBe('INPUT');
  await page.waitForTimeout(80);
}

/** Bir range input'unu GERÇEK fareyle, kutusunun oranına göre sürükler. */
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
 * Önizleme kompozitöründen TEK PİKSEL okur (proje koordinatı).
 *
 * Neden köprü: canvas `preserveDrawingBuffer: false` ile açılır (kare başına
 * bir tampon kopyası kazandırır), yani dışarıdan `toDataURL`/`getImageData`
 * boş döner. Motor, isteği bir sonraki ÇİZİM karesinde, `render()` çağrısının
 * hemen ardından karşılar. Köprü DEV'e özeldir ve yalnız okur.
 */
async function probePixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
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
    'window.__videoeditPlayer yok: önizleme motoru DEV köprüsünü kurmadı (Vite DEV sunucusuna bağlanıldığından emin olun).',
  ).not.toBeNull();
  return value as [number, number, number, number];
}

/**
 * Timeline GÖVDE canvas'ında, verilen ekran dikdörtgeni içinde hız rozetinin
 * amber dolgusundan (drawSpeedBadge) piksel var mı?
 *
 * Rozet canvas'a çizilir; DOM'da karşılığı yoktur. "Rozet göründü" iddiasının
 * tek dürüst kanıtı, klibin isim çubuğunda o rengin GERÇEKTEN bulunmasıdır.
 */
async function hasSpeedBadgePixels(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<boolean> {
  const found = await page.evaluate((r) => {
    const tagged = document.querySelector('[data-testid="timeline-canvas"]');
    const wrap =
      tagged ??
      [...document.querySelectorAll('div')].find(
        (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
      );
    if (!wrap) return null;
    // Canvas sırası: ruler, body, overlay (TimelinePanel render'ı).
    const body = wrap.querySelectorAll('canvas')[1] as HTMLCanvasElement | undefined;
    if (!body) return null;
    const box = body.getBoundingClientRect();
    const sx = body.width / box.width;
    const sy = body.height / box.height;
    const x0 = Math.max(0, Math.round((r.x - box.left) * sx));
    const y0 = Math.max(0, Math.round((r.y - box.top) * sy));
    const w = Math.max(1, Math.round(r.width * sx));
    const h = Math.max(1, Math.round(r.height * sy));
    const ctx = body.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(x0, y0, w, h).data;
    // drawSpeedBadge: rgba(250, 204, 21, 0.85) — koyu isim çubuğu üstünde
    // karışınca kırmızı/yeşil yüksek, mavi düşük kalır.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 190 && data[i + 1] > 150 && data[i + 2] < 90) return true;
    }
    return false;
  }, rect);
  expect(found, 'Timeline gövde canvas’ı okunamadı (rozet örneklemesi).').not.toBeNull();
  return found as boolean;
}

/** Proje merkezindeki piksel — şekil katmanı (scale 0.5) tam oraya düşer. */
async function centrePixel(page: Page): Promise<[number, number, number, number]> {
  const settings = await page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: { settings: { width: number; height: number } } } } } };
    }).__ve;
    const s = bridge.doc.useDocStore.getState().doc.settings;
    return { width: s.width, height: s.height };
  });
  return probePixel(page, Math.floor(settings.width / 2), Math.floor(settings.height / 2));
}

function channelsClose(
  actual: readonly number[],
  expected: readonly number[],
  tolerance = CHANNEL_TOLERANCE,
): boolean {
  return [0, 1, 2].every((i) => Math.abs(actual[i] - expected[i]) <= tolerance);
}

/** §4.1 CPU referansının 8-bit karşılığı (shader'ın üretmesi GEREKEN piksel). */
function referencePixel(
  base: { r: number; g: number; b: number },
  params: Record<string, number>,
): [number, number, number] {
  const out = applyColorAdjustRef(
    { r: base.r / 255, g: base.g / 255, b: base.b / 255 },
    {
      exposure: params.exposure ?? 0,
      temperature: params.temperature ?? 0,
      tint: params.tint ?? 0,
      brightness: params.brightness ?? 0,
      contrast: params.contrast ?? 0,
      saturation: params.saturation ?? 0,
    },
  );
  return [Math.round(out.r * 255), Math.round(out.g * 255), Math.round(out.b * 255)];
}

test.describe('M5 — klip hızı (gerçek fare)', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('2x düğmesi klip süresini yarıya indirir, tek geçmiş girdisi bırakır ve Ctrl+Z geri alır', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    expect((await editor.state()).selection, 'Klibe tıklamak onu seçmeli.').toEqual([seed.clipAId]);

    const before = await editor.state();
    const originalClip = await readClip(page, seed.clipAId);
    expect(originalClip.speed?.rate, 'Seed klibi 1x hızda başlar.').toBe(1);
    expect(originalClip.timelineDurationUs).toBe(6 * SECOND_US);

    // Hız bölümü seçili klip için görünmeli (video klip -> hız var).
    const section = page.getByTestId('clip-inspector-speed');
    await section.scrollIntoViewIfNeeded();
    await expect(section, 'Video klip seçiliyken Hız bölümü görünmeli.').toBeVisible();
    await expect(page.getByTestId('clip-speed-value')).toHaveText('1x');

    const boxBefore = await editor.timeline.clipBox(seed.clipAId);

    // ---- GERÇEK FARE: "2x" ön ayarına tıkla ----
    await clickReal(page, 'clip-speed-preset-2');

    const after = await readClip(page, seed.clipAId);
    expect(after.speed?.rate, 'Doküman 2x hızı taşımalı.').toBe(2);
    expect(
      after.timelineDurationUs,
      'Süre = round((sourceOut - sourceIn) / rate) — §1.3.',
    ).toBe(clipTimelineDurationUs(after.sourceInUs!, after.sourceOutUs!, 2));
    expect(after.timelineDurationUs, '6 sn / 2 = 3 sn.').toBe(3 * SECOND_US);
    expect(after.sourceOutUs, 'Kaynak aralığı DEĞİŞMEZ (hız kırpma değildir).').toBe(
      originalClip.sourceOutUs,
    );
    expect(after.timelineStartUs, 'Klip yerinde kalır.').toBe(originalClip.timelineStartUs);
    expectDocValid(await readDoc(page), '2x sonrası');

    // Panel yeni değeri gösteriyor mu?
    await expect(page.getByTestId('clip-speed-value')).toHaveText('2x');

    // Tek geçmiş girdisi.
    const afterState = await editor.state();
    expect(
      afterState.historyLabels.length,
      'Bir hız değişikliği TEK geçmiş girdisi olmalı.',
    ).toBe(before.historyLabels.length + 1);
    expect(afterState.historyLabels.at(-1)).toMatch(/hız/i);

    // ---- Timeline rozeti: "2x" klibin üstünde GERÇEKTEN çizildi mi? ----
    expect(
      (await editor.timeline.clipBox(seed.clipAId)).width,
      'Klip yarıya indiyse timeline bloğu da yarıya inmeli.',
    ).toBeCloseTo(boxBefore.width / 2, 0);

    // Sığdırılmış görünümde 3 sn'lik blok ~23 px: isim çubuğunun kendisi bile
    // çizilmiyor (drawTracks w > 24 kapısı). Rozeti okumak için kullanıcının da
    // yapacağı şeyi yap — GERÇEK Ctrl+wheel ile yakınlaş.
    for (let i = 0; i < 12 && (await editor.timeline.clipBox(seed.clipAId)).width < 80; i++) {
      await editor.timeline.ctrlWheel(-120, await editor.timeline.clipCenter(seed.clipAId));
    }
    const boxZoomed = await editor.timeline.clipBox(seed.clipAId);
    expect(boxZoomed.width, 'Yakınlaşma rozet için yer açmalı.').toBeGreaterThan(60);
    await expect
      .poll(() => hasSpeedBadgePixels(page, { ...boxZoomed, height: 16 }), {
        message:
          'Hız rozeti timeline’da görünmeli: rozetsiz bir 2x klip, blok uzunluğuyla ' +
          'içeriği hakkında sessizce yalan söyler.',
      })
      .toBe(true);

    // Negatif kontrol: aynı yakınlıkta 1x olan komşu klipte rozet OLMAMALI
    // (her klipte rozet = rozet yok demektir).
    const neighbour = await editor.timeline.clipBox(seed.clipBId);
    if (neighbour.x > boxZoomed.x && neighbour.width > 60) {
      expect(
        await hasSpeedBadgePixels(page, { ...neighbour, height: 16 }),
        '1x klipte hız rozeti çizilmemeli.',
      ).toBe(false);
    }

    // ---- GERÇEK KLAVYE: Ctrl+Z ----
    await blurPanel(page);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await readClip(page, seed.clipAId)).timelineDurationUs)
      .toBe(6 * SECOND_US);
    expect((await readClip(page, seed.clipAId)).speed?.rate).toBe(1);
    expectDocValid(await readDoc(page), 'Ctrl+Z sonrası');
  });

  test('sonraki klibe çarpan yavaşlatma REDDEDİLİR; "Sonrakileri kaydır" ile geçer', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    const before = await editor.state();
    const clipBBefore = await readClip(page, seed.clipBId);

    // clipA [60,66), clipB [76,82): 10 sn boşluk. 0.25x -> 24 sn -> 84 > 76.
    await page.getByTestId('clip-inspector-speed').scrollIntoViewIfNeeded();
    await clickReal(page, 'clip-speed-preset-0.25');

    const refused = await readClip(page, seed.clipAId);
    expect(refused.speed?.rate, 'Reddedilen işlem klibe DOKUNMAMALI.').toBe(1);
    expect(refused.timelineDurationUs).toBe(6 * SECOND_US);
    expect(
      (await editor.state()).historyLabels.length,
      'Reddedilen işlem geçmişe girmez.',
    ).toBe(before.historyLabels.length);

    // Sessiz ret YASAK: panelde gerekçe görünmeli.
    const message = page.getByTestId('clip-inspector-message');
    await expect(message, 'Ret gerekçesi ekranda olmalı (sessiz ret = "çalışmıyor").').toBeVisible();
    await expect(message).toHaveAttribute('data-kind', 'error');
    await expect(message, 'Mesaj, basılan düğmenin bölümünde olmalı.').toHaveAttribute(
      'data-source',
      'speed',
    );
    await expect(message).toContainText(/kaydır/i);

    // `toBeVisible` CSS görünürlüğüne bakar — kaydırmalı bir panelde ekranın
    // dışında kalan bir mesaj da "visible"dır. Kullanıcının gerçekten GÖRDÜĞÜNÜ
    // iddia etmek için mesajın, az önce basılan düğmeyle aynı ekran alanında
    // olduğu doğrulanır.
    const presetBox = await page.getByTestId('clip-speed-preset-0.25').boundingBox();
    const messageBox = await message.boundingBox();
    const viewport = page.viewportSize();
    expect(messageBox, 'Mesajın kutusu okunamadı.').not.toBeNull();
    expect(presetBox, 'Ön ayar düğmesinin kutusu okunamadı.').not.toBeNull();
    expect(
      messageBox!.y >= 0 && messageBox!.y + messageBox!.height <= viewport!.height,
      'Ret gerekçesi görüntü alanının içinde olmalı.',
    ).toBe(true);
    expect(
      Math.abs(messageBox!.y - presetBox!.y),
      'Gerekçe, basılan düğmenin yanında durmalı (400 px yukarısı = yine sessizlik).',
    ).toBeLessThan(250);

    // ---- Ripple aç, tekrar dene ----
    await clickReal(page, 'clip-speed-ripple');
    await clickReal(page, 'clip-speed-preset-0.25');

    const rippled = await readClip(page, seed.clipAId);
    expect(rippled.speed?.rate).toBe(0.25);
    expect(rippled.timelineDurationUs, '6 sn / 0.25 = 24 sn.').toBe(24 * SECOND_US);
    const clipBAfter = await readClip(page, seed.clipBId);
    expect(
      clipBAfter.timelineStartUs,
      'Ripple sonraki klibi süre farkı kadar öteler (boşluk korunur).',
    ).toBe(clipBBefore.timelineStartUs + 18 * SECOND_US);
    expectDocValid(await readDoc(page), 'ripple hız değişikliği sonrası');
  });
});

test.describe('M5 — renk düzeltme (gerçek fare + canvas piksel imzası)', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('renk slider’ı sürüklenince shader değeri değişir, tek geçmiş girdisi bırakır ve Ctrl+Z geri alır', async ({
    editor,
  }) => {
    const page = editor.page;

    // ---- Boyanabilir bir katman: şekil (medya gerektirmez, istemcide raster) ----
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await clickReal(page, 'add-shape-clip');
    const state = await editor.state();
    const overlay = state.tracks.find((t) => t.type === 'overlay');
    expect(overlay, '"Şekil ekle" bir overlay track açmalı.').toBeDefined();
    const shapeId = overlay!.clips[0].id;
    expect(state.selection, 'Yeni şekil seçili gelmeli.').toEqual([shapeId]);

    // Önizleme gerçekten şekli çiziyor mu? (doküman yüklemesi 100 ms debounce)
    await expect
      .poll(async () => channelsClose(await centrePixel(page), [SHAPE_FILL_RGB.r, SHAPE_FILL_RGB.g, SHAPE_FILL_RGB.b]), {
        timeout: 10_000,
        message: 'Önizlemenin merkezinde şeklin dolgu rengi görünmeli (renk testinin ön koşulu).',
      })
      .toBe(true);
    const baseline = await centrePixel(page);

    const beforeHistory = (await editor.state()).historyLabels.length;
    const colorSection = page.getByTestId('clip-inspector-color');
    await colorSection.scrollIntoViewIfNeeded();
    await expect(colorSection, 'Şekil klibi için Renk bölümü görünmeli.').toBeVisible();

    // ---- GERÇEK FARE: doygunluk slider'ını sola sürükle (-1..1, 0 = ortada) ----
    await dragSlider(page, 'clip-color-saturation', 0.08);

    const clip = await readClip(page, shapeId);
    const effect = clip.effects.find((e) => e.type === 'colorAdjust');
    expect(effect, 'Slider bir colorAdjust efekti yazmalı.').toBeDefined();
    expect(effect!.enabled).toBe(true);
    expect(
      effect!.params.saturation,
      'Sola sürükleme doygunluğu düşürmeli.',
    ).toBeLessThan(-0.5);
    expectDocValid(await readDoc(page), 'renk düzeltme sonrası');

    // ---- Piksel: shader GERÇEKTEN değişti mi ve §4.1 ile aynı mı? ----
    const expectedPixel = referencePixel(SHAPE_FILL_RGB, effect!.params);
    await expect
      .poll(async () => channelsClose(await centrePixel(page), expectedPixel), {
        timeout: 10_000,
        message:
          `Önizleme pikseli §4.1 CPU referansıyla eşleşmeli (beklenen ${expectedPixel.join(',')}).`,
      })
      .toBe(true);
    const graded = await centrePixel(page);
    expect(
      channelsClose(graded, [baseline[0], baseline[1], baseline[2]]),
      'Renk değişimi ekranda görünmeli — piksel imzası değişmeli.',
    ).toBe(false);

    // ---- Tek geçmiş girdisi (sürükleme boyunca yüzlerce onChange) ----
    const afterState = await editor.state();
    expect(
      afterState.historyLabels.length,
      'Bir slider SÜRÜKLEMESİ tek geçmiş girdisi olmalı (liveEdit transaction).',
    ).toBe(beforeHistory + 1);
    expect(afterState.historyLabels.at(-1)).toMatch(/doygunluk/i);

    // ---- GERÇEK KLAVYE: Ctrl+Z ----
    await blurPanel(page);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await readClip(page, shapeId)).effects.length)
      .toBe(0);
    await expect
      .poll(async () => channelsClose(await centrePixel(page), [baseline[0], baseline[1], baseline[2]]), {
        timeout: 10_000,
        message: 'Ctrl+Z sonrası önizleme ilk rengine dönmeli.',
      })
      .toBe(true);
    expectDocValid(await readDoc(page), 'renk Ctrl+Z sonrası');
  });

  test('parlaklık slider’ı da aynı formülü izler ve "Sıfırla" efekti kaldırır', async ({
    editor,
  }) => {
    const page = editor.page;
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await clickReal(page, 'add-shape-clip');
    const shapeId = (await editor.state()).selection[0];

    await expect
      .poll(async () => channelsClose(await centrePixel(page), [SHAPE_FILL_RGB.r, SHAPE_FILL_RGB.g, SHAPE_FILL_RGB.b]), {
        timeout: 10_000,
      })
      .toBe(true);

    await page.getByTestId('clip-inspector-color').scrollIntoViewIfNeeded();
    await dragSlider(page, 'clip-color-brightness', 0.9);

    const params = (await readClip(page, shapeId)).effects.find((e) => e.type === 'colorAdjust')!
      .params;
    expect(params.brightness, 'Sağa sürükleme parlaklığı artırmalı.').toBeGreaterThan(0.5);

    const expectedPixel = referencePixel(SHAPE_FILL_RGB, params);
    await expect
      .poll(async () => channelsClose(await centrePixel(page), expectedPixel), { timeout: 10_000 })
      .toBe(true);

    // ---- "Sıfırla": efekt tamamen kalkar (etkisiz efekt bile export kapısına takılır) ----
    await clickReal(page, 'clip-color-reset');
    expect((await readClip(page, shapeId)).effects, 'Sıfırla efekti KALDIRMALI.').toHaveLength(0);
    await expect
      .poll(async () => channelsClose(await centrePixel(page), [SHAPE_FILL_RGB.r, SHAPE_FILL_RGB.g, SHAPE_FILL_RGB.b]), {
        timeout: 10_000,
      })
      .toBe(true);
    expectDocValid(await readDoc(page), 'renk sıfırlama sonrası');
  });
});
