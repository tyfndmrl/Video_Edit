/**
 * Keyframe editörü — GERÇEK fare ve klavye ile (review-gate kural 3).
 *
 * Bu dosyada `dispatchEvent`, sentetik PointerEvent veya store fonksiyonunu
 * doğrudan çağırma YOKTUR. Store ve modüller yalnızca DOĞRULAMA için okunur:
 * - keyframe listesi canvas'ta okunamaz, tek kaynak doküman;
 * - elmasların EKRAN konumu uygulamanın KENDİ `stripGeometry` modülünden
 *   hesaplanır, yani test "uygulama nereye çizdiyse" oraya tıklar (ikinci bir
 *   koordinat matematiği = sahte yeşil riski);
 * - önizlemenin gerçekten interpolasyon yaptığının tek dürüst kanıtı PİKSEL'dir
 *   (uniform'lar GPU'da; hiçbir store "shader bu opaklığı gördü mü?" sorusunu
 *   yanıtlamaz), bu yüzden `window.__videoeditPlayer.probePixel` kullanılır.
 *
 * Neden ŞEKİL klibi: seed klipleri var olmayan bir asset'e bakar (kasıtlı, hız
 * için) ve önizlemede hiçbir piksel üretmez. Şekil katmanı ise tamamen istemci
 * tarafında rasterlenir — düz renkli, kompozisyon merkezini kaplayan bir
 * dikdörtgen, opaklık ölçmek için ideal hedef.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** clipA [60s,66s) — şekil klibi buraya, playhead'in üstüne düşer. */
const SHAPE_START_US = 63 * SECOND_US;
/** Şekil klibi 5 sn (overlayDefaults.OVERLAY_DEFAULT_DURATION_US). */
const SHAPE_DURATION_US = 5 * SECOND_US;

interface KeyframeProbe {
  timeUs: number;
  value: number;
  easing: { type: string };
}

interface DiamondPoint {
  channel: string;
  timeUs: number;
  /** SAYFA koordinatı — doğrudan page.mouse'a verilir. */
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Doğrulama okumaları (salt okunur)
// ---------------------------------------------------------------------------

async function readKeyframes(
  page: Page,
  clipId: string,
  channel: string,
): Promise<KeyframeProbe[]> {
  return page.evaluate(
    ({ id, ch }) => {
      const bridge = (window as unknown as {
        __ve: {
          doc: {
            useDocStore: {
              getState(): {
                doc: { tracks: { clips: { id: string; keyframes: Record<string, unknown> }[] }[] };
              };
            };
          };
        };
      }).__ve;
      for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
        for (const clip of track.clips) {
          if (clip.id === id) {
            return JSON.parse(JSON.stringify(clip.keyframes[ch] ?? [])) as KeyframeProbe[];
          }
        }
      }
      return [] as KeyframeProbe[];
    },
    { id: clipId, ch: channel },
  );
}

async function readTransform(
  page: Page,
  clipId: string,
): Promise<{ x: number; y: number; scale: number; rotationDeg: number }> {
  const value = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): {
              doc: {
                tracks: {
                  clips: {
                    id: string;
                    transform: { x: number; y: number; scale: number; rotationDeg: number };
                  }[];
                }[];
              };
            };
          };
        };
      };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === id) return clip.transform;
      }
    }
    return null;
  }, clipId);
  expect(value, `Klip dokümanda yok: ${clipId}`).not.toBeNull();
  return value as { x: number; y: number; scale: number; rotationDeg: number };
}

/**
 * Elmasların EKRAN konumu, uygulamanın kendi layout fonksiyonundan.
 *
 * Modül değişken üzerinden import edilir (appBridge ile aynı desen): saf bir
 * fonksiyon olduğu için modül örneği kimliği önemsiz, ama SONUÇ uygulamanın
 * gerçekten çizdiği yerdir — test kendi geometri matematiğini kurmaz.
 */
async function diamondPoints(page: Page): Promise<DiamondPoint[]> {
  return page.evaluate(async () => {
    const strip = document.querySelector('[data-testid="keyframe-strip"]');
    if (!strip) return [] as DiamondPoint[];
    const wrap = [...document.querySelectorAll('div')].find(
      (d) => [...d.children].filter((c) => c.tagName === 'CANVAS').length >= 3,
    );
    if (!wrap) return [] as DiamondPoint[];
    const stripRect = strip.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    const bridge = (window as unknown as {
      __ve: {
        doc: { useDocStore: { getState(): { doc: unknown } } };
        editor: {
          useEditorStore: {
            getState(): { selection: Set<string>; scrollUs: number; pxPerUs: number };
          };
        };
      };
    }).__ve;
    const specifier = '/src/features/keyframes/stripGeometry.ts';
    const geo = (await import(/* @vite-ignore */ specifier)) as unknown as {
      KEYFRAME_ROW_H: number;
      buildStripLayout(input: unknown): {
        topY: number;
        rows: { channel: string; y: number; diamonds: { timeUs: number; x: number }[] }[];
      } | null;
    };
    const ed = bridge.editor.useEditorStore.getState();
    const layout = geo.buildStripLayout({
      doc: bridge.doc.useDocStore.getState().doc,
      selection: ed.selection,
      scrollUs: ed.scrollUs,
      pxPerUs: ed.pxPerUs,
      widthPx: wrapRect.width,
    });
    if (!layout) return [] as DiamondPoint[];

    const out: DiamondPoint[] = [];
    for (const row of layout.rows) {
      for (const d of row.diamonds) {
        out.push({
          channel: row.channel,
          timeUs: d.timeUs,
          x: wrapRect.left + d.x,
          // Şeridin DOM kutusu ekrandaki gerçek üst kenarı verir; satır ofseti
          // layout'tan gelir (dikey kaydırma zaten kutuya dahil).
          y: stripRect.top + (row.y - layout.topY) + geo.KEYFRAME_ROW_H / 2,
        });
      }
    }
    return out;
  });
}

/** Keyframe şeridi canvas'ından bir pikselin RGBA'sı (sayfa koordinatı). */
async function stripPixel(
  page: Page,
  point: { x: number; y: number },
): Promise<[number, number, number, number]> {
  const rgba = await page.evaluate((p: { x: number; y: number }) => {
    const canvas = document.querySelector(
      '[data-testid="keyframe-strip-canvas"]',
    ) as HTMLCanvasElement | null;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx || r.width === 0) return null;
    const sx = Math.round((p.x - r.left) * (canvas.width / r.width));
    const sy = Math.round((p.y - r.top) * (canvas.height / r.height));
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
  }, point);
  expect(rgba, 'Keyframe şeridi canvas\'ı okunamadı.').not.toBeNull();
  return rgba as [number, number, number, number];
}

/**
 * Kompozisyon pikseli — motorun KENDİ probe kuyruğu üzerinden (drawing buffer
 * korunmadığı için dışarıdan okunamaz; bkz. player/engine.ts).
 */
async function probeComposition(
  page: Page,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const rgba = await page.evaluate(
    async (p: { x: number; y: number }) => {
      const hook = (window as unknown as {
        __videoeditPlayer?: {
          probePixel(x: number, y: number): Promise<[number, number, number, number]>;
        };
      }).__videoeditPlayer;
      if (!hook) return null;
      return hook.probePixel(p.x, p.y);
    },
    { x, y },
  );
  expect(
    rgba,
    'window.__videoeditPlayer yok — DEV sunucusuna bağlanıldığından emin olun.',
  ).not.toBeNull();
  return rgba as [number, number, number, number];
}

// ---------------------------------------------------------------------------
// Gerçek girdi yardımcıları
// ---------------------------------------------------------------------------

/**
 * Gerçek fare tıklaması. `scrollIntoViewIfNeeded` OLAY ÜRETMEZ (yalnız
 * kaydırma); Inspector 900 px viewport'ta kaydırılabilir bir sütun olduğu için
 * Görüntü bölümü kıvrımın altında kalabiliyor ve fare oraya hiç ulaşamıyordu.
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
  await page.waitForTimeout(140);
}

/**
 * Range girdisine GERÇEK tıklama: tıklanan x oranı değeri belirler. Ardından
 * klavye ile uca sabitlenir (Home/End) — böylece beklenen değer tam sayıdır,
 * "yaklaşık" değil.
 */
async function setSliderToEnd(page: Page, testId: string, end: 'min' | 'max'): Promise<void> {
  const el = page.getByTestId(testId);
  await expect(el).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `Kaydırıcı kutusu okunamadı: ${testId}`).not.toBeNull();
  const x = end === 'min' ? box!.x + 2 : box!.x + box!.width - 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press(end === 'min' ? 'Home' : 'End');
  await page.waitForTimeout(140);
}

/**
 * Klavye kısayolları bir input odaktayken bilerek devre dışı
 * (shortcuts/dispatcher.isEditableTarget) — Ctrl+Z'den önce odağı bırak.
 */
async function blurPanel(page: Page): Promise<void> {
  const identity = page.getByTestId('clip-inspector-identity');
  const box = await identity.boundingBox();
  expect(box, 'Inspector kimlik bölümü görünmüyor.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 6);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe(
    'INPUT',
  );
  await page.waitForTimeout(120);
}

/** İmleç çapalı Ctrl+wheel: klip ekranda kalırken şerit rahat tıklanır olsun. */
async function zoomOnClip(
  editor: { page: Page; timeline: { clipCenter(id: string): Promise<{ x: number; y: number }>; ctrlWheel(d: number, at: { x: number; y: number }): Promise<void> } },
  clipId: string,
  steps: number,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await editor.timeline.ctrlWheel(-120, await editor.timeline.clipCenter(clipId));
  }
}

/** Şekil katmanı ekler (gerçek fare, TopBar düğmesi) ve id'sini döndürür. */
async function addShapeAtPlayhead(editor: {
  page: Page;
  timeline: { scrubTo(us: number): Promise<void> };
  state(): Promise<{ tracks: { type: string; clips: { id: string; kind: string }[] }[] }>;
}): Promise<string> {
  await editor.timeline.scrubTo(SHAPE_START_US);
  await clickReal(editor.page, 'add-shape-clip');
  const state = await editor.state();
  const overlay = state.tracks.find((t) => t.type === 'overlay');
  expect(overlay, '"Şekil ekle" bir overlay track açmalı.').toBeDefined();
  const clip = overlay!.clips.find((c) => c.kind === 'shape');
  expect(clip, 'Overlay track\'te şekil klibi olmalı.').toBeDefined();
  return clip!.id;
}

/** Gerçek fare: bas → eşiği aşan kademeli hareket → bırak. */
async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 5, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  await page.waitForTimeout(160);
}

// ---------------------------------------------------------------------------

test.describe('Keyframe editörü — gerçek fare ve klavye', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('opaklık keyframe zinciri: ekle → playhead taşı → ikinci keyframe → iki elmas → ara karede interpolasyon → Ctrl+Z', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);
    await zoomOnClip(editor, clipId, 3);

    // ---- 1. Başlangıçta hiçbir kanal animasyonlu değil ----
    const toggle = page.getByTestId('clip-kf-opacity');
    await expect(toggle, 'Opaklığın yanında keyframe düğmesi olmalı.').toBeVisible();
    await expect(toggle).toHaveAttribute('data-animated', 'false');
    await expect(
      page.getByTestId('keyframe-strip'),
      'Keyframe yokken şerit hiç var olmamalı (mevcut jestlere sıfır müdahale).',
    ).toHaveCount(0);

    // ---- 2. Playhead klip başında; elmas düğmesi ilk keyframe'i yazar ----
    await clickReal(page, 'clip-kf-opacity');
    let kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs, 'Elmas düğmesi playhead\'e TEK keyframe yazmalı.').toHaveLength(1);
    expect(kfs[0].timeUs, 'Playhead klip başındayken keyframe klip-göreli 0 olmalı.').toBe(0);
    expect(kfs[0].value, 'İlk keyframe klibin MEVCUT (taban) opaklığını almalı.').toBe(1);
    await expect(toggle).toHaveAttribute('data-animated', 'true');
    await expect(toggle).toHaveAttribute('data-keyed', 'true');
    await expect(page.getByTestId('clip-kf-summary')).toHaveAttribute('data-channels', 'opacity');

    // ---- 3. İlk keyframe'in değeri 0 (kaydırıcı + klavye, gerçek girdi) ----
    await setSliderToEnd(page, 'clip-opacity', 'min');
    kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs, 'Kaydırıcı YENİ keyframe açmamalı — aynı andaki keyframe güncellenir.').toHaveLength(1);
    expect(kfs[0].value).toBe(0);
    expect(
      (await readTransform(page, clipId)) && true,
      'Sanity: klip hâlâ dokümanda.',
    ).toBe(true);

    // ---- 4. Playhead'i 2 sn ileri taşı, değeri değiştir -> İKİNCİ keyframe ----
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await expect(
      toggle,
      'Playhead keyframe olmayan bir ana geldi: "animasyonlu" ama "burada keyframe yok".',
    ).toHaveAttribute('data-keyed', 'false');
    await expect(toggle).toHaveAttribute('data-animated', 'true');

    await setSliderToEnd(page, 'clip-opacity', 'max');
    kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs, 'Yeni bir anda değer değiştirmek İKİNCİ keyframe\'i açmalı.').toHaveLength(2);
    expect(kfs.map((k) => k.timeUs)).toEqual([0, 2 * SECOND_US]);
    expect(kfs.map((k) => k.value)).toEqual([0, 1]);
    await expect(toggle).toHaveAttribute('data-keyed', 'true');

    // ---- 5. Şeritte İKİ elmas — hem konum hem BOYA kanıtı ----
    await expect(page.getByTestId('keyframe-strip')).toHaveAttribute('data-rows', 'opacity');
    const points = await diamondPoints(page);
    expect(points.map((p) => p.timeUs), 'Şerit iki elmas çizmeli.').toEqual([0, 2 * SECOND_US]);
    for (const p of points) {
      const [r, g, b, a] = await stripPixel(page, p);
      expect(
        a,
        `Elmas (${p.timeUs} us) yalnız hesapta değil, canvas'ta da BOYALI olmalı.`,
      ).toBeGreaterThan(200);
      // Opaklık satırının rengi #57c785 — yeşil baskın.
      expect(g, `Elmas rengi opaklık kanalınınki olmalı (rgb ${r},${g},${b}).`).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
    }
    const between = { x: (points[0].x + points[1].x) / 2, y: points[0].y };
    const gap = await stripPixel(page, between);
    expect(
      gap[1] > 150 && gap[1] > gap[0],
      'İki elmasın ORTASI elmas rengi olmamalı (aksi halde çizgi çizmişiz demektir).',
    ).toBe(false);

    // ---- 6. Ara karede İNTERPOLASYON: önizleme pikseli ----
    // Kompozisyon merkezi şeklin içinde (şekil ölçeği 0.5, doğal kutusu kare).
    const centre = { x: 960, y: 540 };
    await editor.timeline.scrubTo(SHAPE_START_US);
    const atStart = await probeComposition(page, centre.x, centre.y);
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    const atEnd = await probeComposition(page, centre.x, centre.y);
    expect(
      Math.abs(atEnd[2] - atStart[2]),
      'Opaklık 0 -> 1 arasında önizleme gözle görülür biçimde değişmeli ' +
        `(başta ${atStart.join(',')}, sonda ${atEnd.join(',')}).`,
    ).toBeGreaterThan(60);

    await editor.timeline.scrubTo(SHAPE_START_US + SECOND_US);
    const atMid = await probeComposition(page, centre.x, centre.y);
    // Shader straight-alpha ile karıştırır (compositor: SRC_ALPHA /
    // ONE_MINUS_SRC_ALPHA, shaders.ts: c.a *= uOpacity), yani sonuç a'da
    // DOĞRUSAL: 0.5 opaklık iki ucun tam ortasıdır (§3.3 linear easing + §6.3).
    for (const ch of [0, 1, 2]) {
      const expected = (atStart[ch] + atEnd[ch]) / 2;
      expect(
        Math.abs(atMid[ch] - expected),
        `Ara karede kanal ${ch} iki ucun ortası olmalı (beklenen ${expected}, ` +
          `gerçek ${atMid[ch]}); "değişti" yetmez.`,
      ).toBeLessThanOrEqual(10);
    }

    // ---- 7. Ctrl+Z ----
    await blurPanel(page);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(180);
    kfs = await readKeyframes(page, clipId, 'opacity');
    expect(
      kfs,
      'Ctrl+Z ikinci keyframe\'i geri almalı (kaydırıcı sürüklemesi TEK girdi).',
    ).toHaveLength(1);
    expect(kfs[0].timeUs).toBe(0);
  });

  test('şeritteki elmas gerçek fareyle zamanda taşınır — tek geçmiş girdisi, sıra bozulmaz', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);
    await zoomOnClip(editor, clipId, 3);

    // İki keyframe kur (0 ve 2 sn).
    await clickReal(page, 'clip-kf-opacity');
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await clickReal(page, 'clip-kf-opacity');
    expect(await readKeyframes(page, clipId, 'opacity')).toHaveLength(2);

    const before = await editor.state();
    const points = await diamondPoints(page);
    expect(points).toHaveLength(2);
    const target = points[1];
    // Sola doğru, ilk elmasın ötesine geçmeyecek kadar.
    const dx = -(target.x - points[0].x) / 2;
    await dragMouse(page, target, { x: target.x + dx, y: target.y });

    const kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs, 'Sürükleme keyframe SAYISINI değiştirmemeli.').toHaveLength(2);
    expect(kfs[1].timeUs, 'İkinci keyframe geriye taşınmalı.').toBeLessThan(2 * SECOND_US);
    expect(kfs[1].timeUs, 'Ama komşusunu geçmemeli (şema: kesin artan sıra).').toBeGreaterThan(
      kfs[0].timeUs,
    );
    expect(kfs[1].value, 'Zamanda taşımak DEĞERİ değiştirmemeli.').toBe(kfs[0].value);

    const after = await editor.state();
    expect(
      after.cursor - before.cursor,
      'Bir sürükleme = BİR geçmiş girdisi (transaction coalescing).',
    ).toBe(1);
    expect(after.historyLabels.at(-1)).toMatch(/keyframe taşındı/i);

    // Elmasın DIŞINA basmak şeridin işi değil: timeline klibi seçmeye devam eder.
    await page.keyboard.press('Control+z');
  });

  test('elmasa çift tık siler; elmas DIŞINA basma timeline jestini engellemez', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-opacity');
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await clickReal(page, 'clip-kf-opacity');

    const points = await diamondPoints(page);
    expect(points).toHaveLength(2);

    // 1. Şerit bandının İÇİNDE ama elmasların uzağında bir noktadan klibi
    //    sürüklemek HÂLÂ klip taşımasıdır: şerit yalnız elmasları sahiplenir.
    const stateBefore = await editor.state();
    const startBefore = stateBefore.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)!.timelineStartUs;
    const emptySpot = { x: (points[0].x + points[1].x) / 2, y: points[0].y };
    await dragMouse(page, emptySpot, { x: emptySpot.x + 60, y: emptySpot.y });
    const startAfter = (await editor.state()).tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId)!.timelineStartUs;
    expect(
      startAfter,
      'Elmas dışına basma tüketilmemeli — klip taşıma jesti çalışmaya devam etmeli.',
    ).toBeGreaterThan(startBefore);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(160);

    // 2. Çift tık siler.
    const again = await diamondPoints(page);
    const doomed = again[1];
    await page.mouse.move(doomed.x, doomed.y);
    await page.mouse.dblclick(doomed.x, doomed.y);
    await page.waitForTimeout(180);
    const kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs, 'Çift tık o keyframe\'i silmeli.').toHaveLength(1);
    expect(kfs[0].timeUs).toBe(0);
  });

  test('elmasa sağ tık easing menüsü açar; seçim dokümana yazılır', async ({ editor }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-opacity');
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await clickReal(page, 'clip-kf-opacity');

    const points = await diamondPoints(page);
    const first = points[0];
    await page.mouse.move(first.x, first.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(160);

    const menu = page.getByTestId('keyframe-easing-menu');
    await expect(menu, 'Elmasa sağ tık easing menüsünü açmalı.').toBeVisible();
    await expect(
      page.getByTestId('timeline-context-menu'),
      'Elmas üzerindeki sağ tık timeline menüsünü AÇMAMALI (olay tüketildi).',
    ).toHaveCount(0);

    await clickReal(page, 'keyframe-easing-easeInOut');
    const kfs = await readKeyframes(page, clipId, 'opacity');
    expect(kfs[0].easing.type, 'Seçilen easing keyframe\'e yazılmalı.').toBe('easeInOut');
    await expect(menu).toHaveCount(0);
  });

  test('gizmo keyframe\'li klipte artık salt okunur DEĞİL: playhead\'deki keyframe\'i yazar', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAtPlayhead(editor);

    // Konum X'i animasyonlu yap (klip başında bir keyframe).
    await clickReal(page, 'clip-kf-x');
    expect(await readKeyframes(page, clipId, 'x')).toHaveLength(1);

    const gizmo = page.getByTestId('player-gizmo');
    await expect(gizmo, 'Duraklamışken seçili klip için gizmo görünmeli.').toHaveCount(1);
    await expect(gizmo).toHaveAttribute('data-keyframed', 'true');
    await expect(
      page.getByTestId('player-gizmo-corner-se'),
      'Animasyonlu klipte de tutamaklar çizilmeli (kutu artık kilitli değil).',
    ).toHaveCount(1);

    // Playhead'i 2 sn ileri al ve kutuyu SÜRÜKLE.
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    const geo = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="player-gizmo"]');
      const box = document.querySelector('[data-testid="player-gizmo-box"]');
      if (!svg || !box) return null;
      const r = svg.getBoundingClientRect();
      const corners = (box.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x: r.left + x, y: r.top + y };
        });
      if (corners.length !== 4) return null;
      const xs = corners.map((p) => p.x);
      return {
        centre: {
          x: corners.reduce((s, p) => s + p.x, 0) / 4,
          y: corners.reduce((s, p) => s + p.y, 0) / 4,
        },
        width: Math.max(...xs) - Math.min(...xs),
      };
    });
    expect(geo, 'Gizmo kutusu okunamadı.').not.toBeNull();

    const dragPx = 80;
    await dragMouse(page, geo!.centre, { x: geo!.centre.x + dragPx, y: geo!.centre.y });

    const xKfs = await readKeyframes(page, clipId, 'x');
    expect(
      xKfs,
      'Sürükleme playhead anına İKİNCİ bir keyframe yazmalı (eskiden hiçbir şey olmuyordu).',
    ).toHaveLength(2);
    expect(xKfs[1].timeUs).toBe(2 * SECOND_US);
    expect(
      xKfs[1].value,
      'Yeni keyframe sürüklenen miktarı taşımalı (0 kalırsa yazma yanlış yere gitti).',
    ).toBeGreaterThan(0.02);
    expect(
      (await readTransform(page, clipId)).x,
      'Animasyonlu kanalda TABAN değer değişmemeli (ekranda karşılığı yok).',
    ).toBe(xKfs[0].value);

    // Klip başındaki keyframe hâlâ 0 -> yani gerçekten ANİMASYON var.
    expect(xKfs[0].timeUs).toBe(0);
    expect(xKfs[1].value).not.toBe(xKfs[0].value);
    expect(SHAPE_DURATION_US).toBe(5 * SECOND_US);
  });
});
