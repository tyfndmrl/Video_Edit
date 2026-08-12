/**
 * Metin katmanı boyut tavanı — GERÇEK klavye ile (3. tur denetim, blocker 2).
 *
 * ÖLÇÜLEN HATA: Inspector'ın "Boyut" alanı sabit 2000 px'e, "Ölçek" alanı ise
 * TUVALDEN türeyen 4.266'ya kadar açıktı. Metin katmanı kareye SIĞDIRILMAZ,
 * kendi kutusu kadar çizilir (rendering-semantics §7: `bbox * scale`), yani
 * fontSizePx 2000 + scale 4 ~9600 px'lik bir katman demekti. Baş mimar bunu
 * canlı ölçtü: PUT 200 → POST /exports 202 → iş worker'da düştü. Dışa aktarıcı
 * tek katmanı 8192 piksele sınırlar (LayerGeometry.MaxLayerDimension).
 *
 * review-gate kural 3: iddia yalnız GERÇEK girdiyle kanıtlanır. Aşağıdaki her
 * etkileşim `page.mouse.*` / `page.keyboard.*` üzerinden gider; store yalnız
 * DOĞRULAMA için okunur.
 */
import type { Page } from '@playwright/test';
import { MAX_LAYER_DIMENSION, validateTimelineDoc } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** clipA [60s,66s) — playhead klibin içindeyken metin eklenir. */
const INSIDE_CLIP_A_US = 63 * SECOND_US;

interface TextClipProbe {
  kind: string;
  transform: { scale: number };
  text: { content: string; fontSizePx: number; lineHeight: number };
}

async function readClip(page: Page, clipId: string): Promise<TextClipProbe> {
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
  return probe as TextClipProbe;
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

/** Gerçek fare tıklaması: önce görünür alana kaydır (panel kaydırılabilir). */
async function clickReal(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId);
  await expect(el, `Öğe ekranda yok: ${testId}`).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `Öğenin kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/** Bir sayı alanına gerçek fareyle odaklan, içeriği seç, yaz ve Enter'la bitir. */
async function retypeNumber(page: Page, testId: string, value: string): Promise<void> {
  await clickReal(page, testId);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
}

async function addTextAtClipA(editor: {
  page: Page;
  timeline: { scrubTo(us: number): Promise<void> };
  state(): Promise<{ tracks: { type: string; clips: { id: string; kind: string }[] }[] }>;
}): Promise<string> {
  await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
  await clickReal(editor.page, 'add-text-clip');
  const state = await editor.state();
  const overlay = state.tracks.find((t) => t.type === 'overlay');
  expect(overlay, '"Metin ekle" bir overlay track açmalı.').toBeDefined();
  expect(overlay!.clips[0].kind).toBe('text');
  return overlay!.clips[0].id;
}

test.describe('Metin katmanı boyut tavanı — gerçek klavye', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('çok büyük font + ölçek gerçek klavyeyle yazılınca katman tavanına kırpılır', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addTextAtClipA(editor);
    const initial = await readClip(page, clipId);
    expect(initial.text.lineHeight, 'Varsayılan satır yüksekliği 1.2 olmalı.').toBe(1.2);
    // Ön koşul: ölçek 1 iken tavan hâlâ projenin tavanıdır.
    await expect(page.getByTestId('clip-scale')).toHaveAttribute('max', '4.266');

    // ---- 1. Denetimin canlı ölçtüğü puntoyu GERÇEK klavyeyle yaz ----
    const sizeMax = Number(await page.getByTestId('clip-text-size').getAttribute('max'));
    await retypeNumber(page, 'clip-text-size', '2000');
    const big = await readClip(page, clipId);
    expect(
      big.text.fontSizePx,
      'Punto alanının kendi tavanını aşamaz (alan tam sayı gösterir).',
    ).toBe(Math.min(2000, sizeMax));

    // ---- 2. Ölçek tavanı ARTIK TUVALDEN GELMİYOR ----
    // Metin katmanı kareye sığdırılmaz: kutusu punto ile büyür, tavanı da onunla
    // düşer. Eski panel burada hâlâ 4.266 gösteriyordu — ve 2000 px punto + 4
    // ölçek tam olarak worker'ı düşüren belgeydi.
    const scaleNote = page.getByTestId('clip-scale-limit-note');
    await expect(scaleNote).toHaveAttribute('data-from-text-box', 'true');
    await expect(scaleNote).toContainText('kendi kutusu');
    const scaleMax = Number(await page.getByTestId('clip-scale').getAttribute('max'));
    expect(scaleMax, 'Metin klibinin ölçek tavanı tuvalinkinden küçük olmalı.').toBeLessThan(4.266);

    // ---- 3. Ölçeği zorla: doküman tavanı alır, yazılanı değil ----
    await retypeNumber(page, 'clip-scale', '50');
    const clamped = await readClip(page, clipId);
    expect(
      clamped.transform.scale,
      '50 yazmak dokümana metnin KENDİ kutusundan gelen tavanı yazmalı.',
    ).toBe(scaleMax);
    expect(clamped.transform.scale).toBeLessThan(4.266);

    // Dışa aktarıcının ölçtüğü katmanın ALT SINIRI tavana sığmalı (gerçek kutu
    // daha büyüktür; onu sunucunun kendi ölçümü yakalar).
    expect(clamped.text.fontSizePx * clamped.text.lineHeight * clamped.transform.scale)
      .toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectDocValid(await readDoc(page), 'ölçek tavanına kırpma sonrası');

    // ---- 4. TERS SIRA: önce ölçek, sonra punto — kapı yine kapalı ----
    // Kullanıcı hangi alanı en son sürerse sürsün, ötekinin tavanı çoktan
    // yerine oturmuş olmalı. Küçük puntoya dön, ölçeği tavana çek, puntoyu zorla.
    await retypeNumber(page, 'clip-text-size', '100');
    await retypeNumber(page, 'clip-scale', '50');
    expect((await readClip(page, clipId)).transform.scale).toBe(4.266);

    const sizeMaxNow = Number(await page.getByTestId('clip-text-size').getAttribute('max'));
    expect(sizeMaxNow, 'Ölçek tavandayken punto tavanı 2000 olamaz.').toBeLessThan(2000);
    const note = page.getByTestId('clip-text-size-limit-note');
    await expect(note, 'Sessiz kırpma yasak: gerekçe ekranda yazmalı.').toBeVisible();
    await expect(note).toContainText(String(MAX_LAYER_DIMENSION));

    await retypeNumber(page, 'clip-text-size', '2000');
    const finalClip = await readClip(page, clipId);
    expect(
      finalClip.text.fontSizePx,
      'Denetimin canlı ölçtüğü bileşim (2000 px punto + 4 ölçek) YAZILAMAMALI.',
    ).toBeLessThan(2000);
    expect(finalClip.text.fontSizePx).toBeLessThanOrEqual(sizeMaxNow);
    expect(finalClip.text.fontSizePx * finalClip.text.lineHeight * finalClip.transform.scale)
      .toBeLessThanOrEqual(MAX_LAYER_DIMENSION);
    expectDocValid(await readDoc(page), 'punto tavanına kırpma sonrası');
  });

  test('normal bir başlık kırpılmaz — tavan yalnız gereken yerde daralır', async ({ editor }) => {
    // NEGATİF KONTROL: kapı her metni daraltsaydı ürün kullanılamaz olurdu.
    const page = editor.page;
    const clipId = await addTextAtClipA(editor);

    await retypeNumber(page, 'clip-text-size', '120');
    expect((await readClip(page, clipId)).text.fontSizePx).toBe(120);

    // 120 px tek satırda tavan hâlâ projenin tavanıdır (8192/144 = 56 >> 4.266).
    await expect(page.getByTestId('clip-scale')).toHaveAttribute('max', '4.266');
    await expect(page.getByTestId('clip-scale-limit-note')).toHaveAttribute(
      'data-from-text-box',
      'false',
    );
    // Türetilmiş tavan sabit tavanın altına inmediği için not da GÖRÜNMEZ.
    await expect(page.getByTestId('clip-text-size-limit-note')).toHaveCount(0);
    expectDocValid(await readDoc(page), 'normal başlık sonrası');
  });
});
