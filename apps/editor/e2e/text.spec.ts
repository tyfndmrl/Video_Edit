/**
 * Metin / şekil / sticker katmanları — GERÇEK fare ve klavye ile.
 *
 * review-gate kural 3: bir etkileşimin "çalıştığı" ancak `page.mouse` /
 * `page.keyboard` ile doğrulanmışsa söylenebilir. Bu dosyada `dispatchEvent`,
 * sentetik PointerEvent veya store fonksiyonunu doğrudan çağırma YOKTUR;
 * store yalnız DOĞRULAMA için okunur (canvas'ta okunabilir başka kaynak yok).
 *
 * Kapsanan zincir (görevin 5. maddesi): metin ekle → içeriği yaz → timeline'da
 * klip göründü → Inspector'da renk değişti → Ctrl+Z geri aldı. Ayrıca sağ tık
 * menüsü, önizleme rasterının geometrisi (rendering-semantics §7 baseScale) ve
 * şekil katmanı.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { validateTimelineDoc } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** Seed projesinin çıktı genişliği (fixtures/seed.ts) — bbox'ı px'e çevirmek için. */
const SEED_WIDTH_PX = 1920;

/**
 * SUNUCUNUN çözebildiği fontId'ler — testin ELİNDEKİ tek doğruluk kaynağı.
 * Editörün ne yazdığını bu dosyaya karşı doğrularız; M4 dalga-2 KRİTİK bulgu #1
 * tam olarak buydu: editör 'inter' yazıyordu, bu dosyada 'inter' YOK.
 */
const SERVER_FONT_IDS: string[] = (() => {
  const manifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../fonts/manifest.json',
  );
  const parsed = JSON.parse(new TextDecoder().decode(readFileSync(manifestPath))) as {
    fonts: Record<string, unknown>;
  };
  return Object.keys(parsed.fonts);
})();

/** clipA [60s,66s) — playhead klibin içindeyken metin ekleniyor. */
const INSIDE_CLIP_A_US = 63 * SECOND_US;

interface TextClipProbe {
  kind: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  text?: {
    content: string;
    fill: string;
    fontId: string;
    fontSizePx: number;
    align: string;
    stroke?: { color: string; widthPx: number };
    background?: { color: string; paddingPx: number; radiusPx: number };
  };
  shape?: { type: string; fill: string };
  transform: { x: number; y: number; scale: number; rotationDeg: number };
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

/** Editörün ürettiği belge PAYLAŞILAN sözleşmeden geçmeli (export aynı kuralları koşar). */
function expectDocValid(doc: unknown, context: string): void {
  const result = validateTimelineDoc(doc);
  const issues = result.success
    ? ''
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  expect(result.success, `${context} — sözleşme ihlali:\n${issues}`).toBe(true);
}

/**
 * Gerçek fare tıklaması: locator'ın ekrandaki kutusunun ortasına.
 *
 * Önce görünür alana kaydırılır — kullanıcının da yaptığı şey. Inspector paneli
 * kaydırılabilir; kaydırmadan `boundingBox()` panelin DIŞINDA bir nokta
 * döndürür ve fare başka bir öğeye basar (arka plan alanları burada kırılmıştı).
 */
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

/**
 * Klavye kısayolları (Ctrl+Z dahil) bir input odaktayken bilerek devre dışıdır
 * (shortcuts/dispatcher.isEditableTarget). Panelin etkileşimsiz başlığına
 * GERÇEK tıklama, kullanıcının da yaptığı şeyi yapar: odağı bırakır ve yazma
 * burst'ünü kapatır.
 */
async function blurPanel(page: Page): Promise<void> {
  const identity = page.getByTestId('clip-inspector-identity');
  const box = await identity.boundingBox();
  expect(box, 'Inspector kimlik bölümü görünmüyor.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 6);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
    .not.toBe('TEXTAREA');
  await page.waitForTimeout(120);
}

/** Bir metin alanına gerçek fareyle odaklan, içeriği seç ve yeni değeri yaz. */
async function retype(page: Page, testId: string, value: string): Promise<void> {
  await clickReal(page, testId);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
}

interface GizmoBox {
  corners: { x: number; y: number }[];
  centre: { x: number; y: number };
  width: number;
  height: number;
  /** Kompozitör canvas'ının ekrandaki genişliği (nicel iddia için). */
  canvasWidth: number;
  canvasHeight: number;
}

/** Gizmo kutusunu UYGULAMANIN çizdiği noktalardan oku (test kendi matematiğini kurmaz). */
async function gizmoBox(page: Page): Promise<GizmoBox | null> {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="player-gizmo"]');
    const box = document.querySelector('[data-testid="player-gizmo-box"]');
    if (!svg || !box) return null;
    const stage = svg.parentElement;
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = svg.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const corners = (box.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x: r.left + x, y: r.top + y };
      });
    if (corners.length !== 4) return null;
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    return {
      corners,
      centre: {
        x: corners.reduce((s, p) => s + p.x, 0) / 4,
        y: corners.reduce((s, p) => s + p.y, 0) / 4,
      },
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      canvasWidth: c.width,
      canvasHeight: c.height,
    };
  });
}

/** Playhead'i klibin içine götürüp GERÇEK fareyle "Metin ekle"ye basar. */
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
  expect(overlay!.clips).toHaveLength(1);
  expect(overlay!.clips[0].kind).toBe('text');
  return overlay!.clips[0].id;
}

test.describe('Metin / şekil katmanları — gerçek fare ve klavye', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('metin ekle → içeriği yaz → timeline\'da klip → rengi değiştir → Ctrl+Z', async ({
    editor,
  }) => {
    const page = editor.page;
    const before = await editor.state();
    const signatureBefore = await editor.timeline.bodySignature();

    // ---- 1. Ekleme (gerçek fare, TopBar düğmesi) ----
    const clipId = await addTextAtClipA(editor);
    const afterAdd = await editor.state();
    expect(afterAdd.selection, 'Yeni metin klibi seçili gelmeli.').toEqual([clipId]);
    expect(afterAdd.historyLabels.at(-1)).toMatch(/metin eklendi/i);
    expect(
      afterAdd.historyLabels.length,
      'Ekleme TEK geçmiş girdisi olmalı.',
    ).toBe(before.historyLabels.length + 1);
    expect(afterAdd.tracks[0].type, 'Overlay katmanı videonun ÜSTÜNDE olmalı.').toBe('overlay');

    const added = await readClip(page, clipId);
    expect(added.timelineStartUs, 'Metin playhead\'e düşmeli.').toBe(afterAdd.playheadUs);
    expect(added.timelineDurationUs, 'Varsayılan süre 5 sn olmalı.').toBe(5 * SECOND_US);
    expectDocValid(await readDoc(page), 'metin eklendikten sonra');

    // ---- 2. Timeline gerçekten çizdi mi? ----
    expect(
      await editor.timeline.bodySignature(),
      'Yeni klip timeline canvas\'ını yeniden boyamalı.',
    ).not.toBe(signatureBefore);
    const clipBox = await editor.timeline.clipBox(clipId);
    const wrap = await editor.timeline.wrapBox();
    expect(clipBox.width, 'Klibin timeline\'daki kutusu görünür genişlikte olmalı.').toBeGreaterThan(4);
    expect(clipBox.x + clipBox.width).toBeGreaterThan(wrap.x);
    expect(clipBox.x).toBeLessThan(wrap.x + wrap.width);

    // ---- 3. İçeriği yaz (gerçek klavye) ----
    await expect(page.getByTestId('clip-inspector-text')).toBeVisible();
    await retype(page, 'clip-text-content', 'Merhaba Dünya');
    await expect
      .poll(async () => (await readClip(page, clipId)).text?.content, {
        message: 'Yazılan metin dokümana ANINDA yazılmalı (canlı önizleme için).',
      })
      .toBe('Merhaba Dünya');

    await blurPanel(page);
    const afterTyping = await editor.state();
    expect(
      afterTyping.historyLabels.length,
      'Tüm yazım TEK geçmiş girdisine katlanmalı (harf başına girdi değil).',
    ).toBe(afterAdd.historyLabels.length + 1);
    expect(afterTyping.historyLabels.at(-1)).toMatch(/metin içeriği/i);
    expectDocValid(await readDoc(page), 'metin yazıldıktan sonra');

    // ---- 4. Renk (gerçek klavye, hex alanı) ----
    expect((await readClip(page, clipId)).text?.fill).toBe('#ffffff');
    await retype(page, 'clip-text-fill', '#ff0000');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await readClip(page, clipId)).text?.fill)
      .toBe('#ff0000');
    const afterColor = await editor.state();
    // "renk" -> "rengi" (ünsüz yumuşaması): kalıp gövdeye bakar.
    expect(afterColor.historyLabels.at(-1)).toMatch(/reng/i);

    // ---- 5. Ctrl+Z ----
    await blurPanel(page);
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await readClip(page, clipId)).text?.fill, {
        message: 'Ctrl+Z renk değişikliğini geri almalı.',
      })
      .toBe('#ffffff');
    expect((await readClip(page, clipId)).text?.content, 'Renk geri alması yazıyı silmemeli.').toBe(
      'Merhaba Dünya',
    );

    // Yazımın kendisi de TEK adımda geri alınmalı.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await readClip(page, clipId)).text?.content).toBe('Metin');

    // Ve klibin kendisi tek adımda gitmeli (katmanıyla birlikte).
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await editor.state()).tracks.some((t) => t.type === 'overlay'))
      .toBe(false);
    expectDocValid(await readDoc(page), 'tüm geri almalardan sonra');
  });

  test('boş alana sağ tık > "Metin ekle" DONMUŞ playhead\'e ekler', async ({ editor }) => {
    const page = editor.page;
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    const state = await editor.state();

    // Track satırlarının ALTI = 'empty' bağlamı (yeni-track bırakma bölgesi).
    const point = await editor.timeline.point(INSIDE_CLIP_A_US, state.tracks.length);
    await editor.timeline.click(point, 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.contextMenuItem(/metin ekle/i).click();
    await page.waitForTimeout(200);

    const after = await editor.state();
    const overlay = after.tracks.find((t) => t.type === 'overlay');
    expect(overlay, 'Sağ tık menüsü metin klibi eklemeli.').toBeDefined();
    const clip = await readClip(page, overlay!.clips[0].id);
    expect(clip.kind).toBe('text');
    expect(clip.timelineStartUs, 'Menü açılırken DONAN playhead kullanılmalı.').toBe(
      state.playheadUs,
    );
    expectDocValid(await readDoc(page), 'sağ tık ile metin eklendikten sonra');
  });

  /**
   * rendering-semantics §7: metin rasterı bbox * scale ile çizilir, kompozisyona
   * SIĞDIRILMAZ. Gizmo kutusu kompozitörle aynı matematiği kullandığı için, kutu
   * sahneyi kaplıyorsa raster yanlış ölçekleniyor demektir (fit=contain'e
   * düşülmüş). Bu, önizlemede metnin dev görünmesi hatasının tek görünür kanıtı.
   */
  test('önizleme kutusu metin bbox\'ı kadar (kompozisyona sığdırılmış DEĞİL) ve sürüklenebilir', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addTextAtClipA(editor);
    await expect(page.getByTestId('player-gizmo')).toHaveAttribute('data-clip-id', clipId);

    // Raster ilk karede üretilir; kutu o ana kadar "fit" yedeğini gösterebilir.
    await expect
      .poll(
        async () => {
          const geo = await gizmoBox(page);
          return geo === null ? 1 : geo.width / geo.canvasWidth;
        },
        {
          message:
            'Metin kutusu kompozisyonun tamamını kaplıyor: raster fit=contain ile ' +
            'ölçeklenmiş (baseScale uygulanmamış) demektir.',
          timeout: 5000,
        },
      )
      .toBeLessThan(0.8);

    const geo = await gizmoBox(page);
    expect(geo, 'Gizmo kutusu okunamadı.').not.toBeNull();
    expect(geo!.height / geo!.canvasHeight, 'Kutu yüksekliği de bbox kadar olmalı.').toBeLessThan(0.5);

    // Gerçek fare ile taşı: §2.3 -> Δx_doc = Δx_ekran / canvasGenişliği.
    const dragPx = 80;
    await page.mouse.move(geo!.centre.x, geo!.centre.y);
    await page.mouse.down();
    await page.mouse.move(geo!.centre.x + 6, geo!.centre.y, { steps: 2 });
    await page.mouse.move(geo!.centre.x + dragPx, geo!.centre.y, { steps: 12 });
    await page.mouse.move(geo!.centre.x + dragPx, geo!.centre.y);
    await page.mouse.up();
    await page.waitForTimeout(200);

    const moved = await readClip(page, clipId);
    const expectedX = dragPx / geo!.canvasWidth;
    expect(
      Math.abs(moved.transform.x - expectedX),
      `${dragPx} px sağa sürükleme transform.x'i TAM ${expectedX.toFixed(4)} yapmalı ` +
        `(gerçek ${moved.transform.x}).`,
    ).toBeLessThan(2 / geo!.canvasWidth);
    expect((await editor.state()).historyLabels.at(-1)).toMatch(/konum/i);
    expectDocValid(await readDoc(page), 'metin kutusu sürüklendikten sonra');
  });

  test('şekil ekle: tür ve dolgu Inspector\'dan gerçek girdiyle değişir', async ({ editor }) => {
    const page = editor.page;
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await clickReal(page, 'add-shape-clip');

    const state = await editor.state();
    const overlay = state.tracks.find((t) => t.type === 'overlay');
    expect(overlay, '"Şekil ekle" bir overlay track açmalı.').toBeDefined();
    const clipId = overlay!.clips[0].id;
    expect(overlay!.clips[0].kind).toBe('shape');
    expect(state.historyLabels.at(-1)).toMatch(/şekil eklendi/i);

    await expect(page.getByTestId('clip-inspector-shape')).toBeVisible();
    expect((await readClip(page, clipId)).shape).toMatchObject({ type: 'rect', fill: '#5a8cff' });

    // Tür: gerçek <select> etkileşimi.
    await page.getByTestId('clip-shape-type').selectOption('ellipse');
    await expect.poll(async () => (await readClip(page, clipId)).shape?.type).toBe('ellipse');

    // Dolgu: gerçek klavye.
    await retype(page, 'clip-shape-fill', '#00ff00');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readClip(page, clipId)).shape?.fill).toBe('#00ff00');
    expectDocValid(await readDoc(page), 'şekil düzenlendikten sonra');

    // Metin bölümü bir şekil klibinde GÖRÜNMEMELİ (bölümler karışmaz).
    await expect(page.getByTestId('clip-inspector-text')).toHaveCount(0);
  });

  /**
   * M4 dalga-2 denetimi, KRİTİK bulgu #1 — "metin ekle → dışa aktar" ANA YOLU.
   *
   * Eskiden yeni metin klibi `fontId: 'inter'` ile doğuyordu; 'inter'
   * fonts/manifest.json'da YOKTUR, yani her export 'font-missing' ile düşerdi.
   * Test bunu tek şeye indirger: GERÇEK FARE ile eklenen klibin fontId'si
   * SUNUCUNUN manifestinde var mı?
   */
  test('yeni metin klibinin fontId\'si sunucu manifestinde VAR (font-missing regresyonu)', async ({
    editor,
  }) => {
    const page = editor.page;
    expect(SERVER_FONT_IDS.length, 'fonts/manifest.json okunamadı.').toBeGreaterThan(0);

    const clipId = await addTextAtClipA(editor);
    const fontId = (await readClip(page, clipId)).text?.fontId;

    expect(
      SERVER_FONT_IDS,
      `Yeni metin klibi fontId='${fontId}' ile doğdu; sunucu manifestinde yok → export ` +
        "'font-missing' ile düşerdi. Manifest: " + SERVER_FONT_IDS.join(', '),
    ).toContain(fontId);

    // Seçici de yalnız sunucunun çözebildiği id'leri sunmalı (katalog artık
    // GET /api/fonts'tan gelir; ağ yoksa derlenmiş küratörlü liste kullanılır —
    // her iki dalda da id'ler manifestin İÇİNDEDİR).
    await expect(page.getByTestId('clip-inspector-text')).toBeVisible();
    const options = await page
      .getByTestId('clip-text-font')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
    expect(options.length, 'Yazı tipi seçici boş.').toBeGreaterThan(0);
    for (const option of options) {
      expect(SERVER_FONT_IDS, `Seçicideki '${option}' sunucuda yok.`).toContain(option);
    }

    // Başka bir küratörlü fontu GERÇEKTEN seç: dokümana yazılan değer de geçerli kalmalı.
    const other = options.find((o) => o !== fontId) ?? options[0];
    await page.getByTestId('clip-text-font').selectOption(other);
    await expect.poll(async () => (await readClip(page, clipId)).text?.fontId).toBe(other);
    expect(SERVER_FONT_IDS).toContain(other);
    expectDocValid(await readDoc(page), 'yazı tipi değiştirildikten sonra');
  });

  /**
   * M4 dalga-2 denetimi, bulgu #2 — TEK kutu kuralı, GERÇEK piksellerde.
   *
   * Eski istemci kuralı kutuyu HER KENARDA (kontur + arkaplanPayı) kadar
   * büyütüyordu; sunucu ise mürekkep+kontur/2 ve içerik+pay birleşimini
   * kullanıyor. Aradaki fark ölçülebilir: kontur W açıldığında kutu ESKİ kuralda
   * 2W büyürdü, YENİ kuralda en fazla W (yarısı her kenardan, üstelik yalnız
   * mürekkep içerik kenarına dayanıyorsa).
   */
  test('kontur ve arka plan önizleme kutusunu SUNUCU kuralı kadar büyütür', async ({ editor }) => {
    const page = editor.page;
    const clipId = await addTextAtClipA(editor);
    await expect(page.getByTestId('player-gizmo')).toHaveAttribute('data-clip-id', clipId);

    /** Gizmo kutusunun PROJE pikseli cinsinden genişliği (= bbox, scale 1). */
    const bboxWidth = async (): Promise<number> => {
      const geo = await gizmoBox(page);
      expect(geo, 'Gizmo kutusu okunamadı.').not.toBeNull();
      return (geo!.width * SEED_WIDTH_PX) / geo!.canvasWidth;
    };

    // Varsayılan metin KONTURLU gelir (overlayDefaults): önce konturu kapat ki
    // ölçümün tabanı temiz olsun. Gerçek fare ile toggle.
    await clickReal(page, 'clip-text-stroke');
    await expect.poll(async () => (await readClip(page, clipId)).text?.stroke).toBeUndefined();
    await expect.poll(bboxWidth, { timeout: 5000 }).toBeGreaterThan(0);
    const plain = await bboxWidth();

    // ---- Kontur 24 px ----
    await clickReal(page, 'clip-text-stroke');
    await retype(page, 'clip-text-stroke-width', '24');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readClip(page, clipId)).text?.stroke?.widthPx).toBe(24);
    // Önizleme rasterı bir sonraki karede yeniden üretilir ve ARA durumlardan
    // (kontur açılırken varsayılan 4 px) geçer: kutunun 24 px'lik konturu
    // yansıttığı kareyi bekle, yoksa ölçüm ara kareyi yakalar.
    await expect
      .poll(async () => (await bboxWidth()) - plain, { timeout: 5000 })
      .toBeGreaterThan(12);
    const stroked = await bboxWidth();

    const grewBy = stroked - plain;
    expect(
      grewBy,
      `Kontur 24 px kutuyu ${grewBy.toFixed(1)} px büyüttü. ESKİ istemci kuralı 48 px ` +
        '(her kenarda TAM genişlik) büyütürdü; sunucu kuralı en fazla 24 px büyütür ' +
        '(kontur glif konturunun ORTASINDADIR, dışa taşan pay yarısıdır).',
    ).toBeLessThanOrEqual(24 + 2.5);
    expect(grewBy, 'Kontur kutuyu hiç büyütmedi — mürekkep taşması hesaba katılmamış.')
      .toBeGreaterThan(0);

    // ---- Arka plan payı 40 px (kontur payından BÜYÜK) ----
    await clickReal(page, 'clip-text-background');
    await retype(page, 'clip-text-bg-padding', '40');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await readClip(page, clipId)).text?.background?.paddingPx)
      .toBe(40);
    // Yine ara kare var: arka plan açılırken pay VARSAYILAN 16 ile gelir.
    await expect
      .poll(async () => (await bboxWidth()) - plain, { timeout: 5000 })
      .toBeGreaterThanOrEqual(80 - 2.5);
    const withBackground = await bboxWidth();
    void stroked;

    // Pay (40) kontur payından (12) büyük → kutuyu ARKA PLAN belirler: içerik ± 40.
    // Eski kural burada içerik + 2*(24 + 40) = içerik + 128 verirdi; ÜST SINIR
    // ayırt edici olan taraftır.
    expect(
      withBackground - plain,
      `Arka plan payı 40 px iken kutu tabana göre ${(withBackground - plain).toFixed(1)} px ` +
        'büyüdü; tek kural bunu 80 px (içerik ± 40) yapar, eski istemci kuralı 128 px yapardı.',
    ).toBeLessThanOrEqual(80 + 2.5);

    expectDocValid(await readDoc(page), 'kontur ve arka plan açıldıktan sonra');
  });

  test('metin klibi kırpma/taşıma ile aynı zemini paylaşır (gerçek fare)', async ({ editor }) => {
    const page = editor.page;
    const clipId = await addTextAtClipA(editor);
    const before = await readClip(page, clipId);

    // Sağ kenardan kırp: overlay klipleri de normal klip gibi düzenlenebilmeli.
    await editor.timeline.dragRightEdgeByTime(clipId, -2 * SECOND_US);
    const trimmed = await readClip(page, clipId);
    expect(
      trimmed.timelineDurationUs,
      'Sağ kenarı sola sürüklemek metin klibini kısaltmalı.',
    ).toBeLessThan(before.timelineDurationUs);
    expectDocValid(await readDoc(page), 'metin klibi kırpıldıktan sonra');

    // Gövdesinden taşı.
    await editor.timeline.dragClipByTime(clipId, 2 * SECOND_US);
    expect((await readClip(page, clipId)).timelineStartUs).toBeGreaterThan(before.timelineStartUs);
    expectDocValid(await readDoc(page), 'metin klibi taşındıktan sonra');
  });
});
