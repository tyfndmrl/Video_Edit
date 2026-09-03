/**
 * Timeline etkileşimleri — GERÇEK fare olaylarıyla (page.mouse.*).
 *
 * Bu dosyadaki her jest Chromium'un girdi hattından geçer: pointer capture,
 * buton maskesi, wheel modifier'ları, sürükleme eşiği... hepsi gerçek. Store
 * yalnızca SONUCU doğrulamak için okunur.
 *
 * ---------------------------------------------------------------------------
 * NİCEL İDDİA KURALI (M4 denetimi, yüksek bulgu)
 * ---------------------------------------------------------------------------
 * Bu dosya eskiden yalnız YÖN kanıtlıyordu (`toBeGreaterThan` / `toBeLessThan`).
 * 8 saniyelik bir sürükleme 8 ms de taşısa, 40 sn de taşısa test yeşildi;
 * pxPerUs'un tersine çevrildiği ya da bir yerde ikiye bölündüğü bir hata
 * fark edilmezdi. Seed deterministik olduğu için BEKLENEN DEĞER hesaplanabilir:
 *
 *   xPx = (timeUs - scrollUs) * pxPerUs           (geometry.ts, tek kaynak)
 *   commit edilen zaman = frame ızgarasına oturtulmuş hedef
 *                          (snapping.ts: aday yoksa DAİMA ızgara)
 *
 * Tolerans neden var ve neden 2 px: fare koordinatı tarayıcı girdi hattında
 * tam sayı piksele yuvarlanabilir (basma + bırakma = iki uçta yuvarlama) ve
 * frame ızgarası (30 fps -> 33.333 µs) bu ölçekte 0.26 px'tir. 2 px'lik
 * pencere bu iki kaynağı kapsar, ondan büyük hiçbir sapmayı affetmez. Sığdırma
 * zoom'unda (pxPerUs ~ 7.8e-6) 2 px ≈ 0.26 sn — yani 8 sn'lik bir taşımada
 * %3'ten büyük her hata kırmızıdır.
 */
import { snapUsToFrameGrid, type Rational } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { findClip, readProjectSettings } from './support/appBridge';
import { TimelineHarness } from './support/timeline';
import { SECOND_US, SEED_TIMES } from './fixtures/seed';

/** Konum belirsizliğinin (fare yuvarlaması + ızgara) kabul edilen üst sınırı. */
const TOLERANCE_PX = 2;

/** Aday yakalama eşiği (snapping.ts SNAP_THRESHOLD_PX) — testlerin ön koşulu. */
const SNAP_THRESHOLD_PX = 8;

const tolUs = (pxPerUs: number): number => TimelineHarness.pxToUs(TOLERANCE_PX, pxPerUs);

test.describe('Timeline — gerçek fare', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('klibe tıklayınca seçilir (store + canvas boyaması)', async ({ editor, seed }) => {
    const before = await editor.state();
    expect(before.selection).toEqual([]);
    const signatureBefore = await editor.timeline.bodySignature();

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, before));

    const after = await editor.state();
    expect(after.selection).toEqual([seed.clipAId]);
    // Seçim yalnızca canvas'a çiziliyor (DOM göstergesi yok): timeline'ın
    // GERÇEKTEN yeniden boyandığını piksel imzasından doğrula.
    expect(
      await editor.timeline.bodySignature(),
      'Seçim sonrası timeline canvas\'ı yeniden boyanmadı (seçim çerçevesi çizilmiyor?).',
    ).not.toBe(signatureBefore);
  });

  test('boş alana sürüklenen klip TAM 8 sn taşınır (68. saniyeye)', async ({ editor, seed }) => {
    const before = await editor.state();
    const anchor = findClip(before, seed.clipAId).clip;
    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;

    // clipA [60s,66s) -> boşluk [66s,76s). +8 sn: [68s,74s), clipB'ye (76s) değmez.
    const deltaUs = 8 * SECOND_US;
    // Ön koşul: hedefin yakınında YAKALAYICI bir aday olmamalı, yoksa beklenen
    // değer ızgara değil o adayın kendisi olurdu. En yakın aday clipB başı (76s),
    // sürüklenen klibin sonuna (74s) 2 sn uzakta.
    expect(
      TimelineHarness.pxToUs(SNAP_THRESHOLD_PX, before.pxPerUs),
      'Snap eşiği 2 sn\'yi aşarsa bu test aday snap\'ini ölçer, ızgarayı değil.',
    ).toBeLessThan(2 * SECOND_US);

    await editor.timeline.dragClipByTime(seed.clipAId, deltaUs);

    const after = await editor.state();
    const moved = findClip(after, seed.clipAId);
    // Beklenen: hedef başlangıç frame ızgarasına oturur. 68 sn @30fps = 2040.
    // tam frame -> ızgara onu değiştirmez.
    const expectedStartUs = snapUsToFrameGrid(anchor.timelineStartUs + deltaUs, fps);
    expect(expectedStartUs).toBe(68 * SECOND_US);
    expect(
      moved.clip.timelineStartUs,
      `Klip 68. saniyeye taşınmalıydı (±${TOLERANCE_PX} px).`,
    ).toBeGreaterThan(expectedStartUs - tolUs(before.pxPerUs));
    expect(moved.clip.timelineStartUs).toBeLessThan(expectedStartUs + tolUs(before.pxPerUs));

    // Taşıma SÜREYE ve KATMANA dokunmaz — burada tolerans yok, birebir.
    expect(moved.clip.timelineDurationUs).toBe(anchor.timelineDurationUs);
    expect(moved.trackIndex).toBe(findClip(before, seed.clipAId).trackIndex);
    expect(after.historyLabels.at(-1)).toMatch(/taşın/i);
  });

  test('dolu alana sürüklenen klip taşınmaz VE kullanıcıya uyarı gösterilir', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;
    const history0 = before.historyLabels.length;

    // +19 sn -> [79s,85s), clipB [76s,82s) ile ÇAKIŞIR (snap eşiğinden uzak).
    await editor.timeline.dragClipByTime(seed.clipAId, 19 * SECOND_US);

    const after = await editor.state();
    expect(
      findClip(after, seed.clipAId).clip.timelineStartUs,
      'Çakışan hedefe bırakılan klip taşınmamalı.',
    ).toBe(start0);
    expect(after.historyLabels.length, 'Reddedilen taşıma history\'ye girmemeli.').toBe(history0);

    await expect(
      editor.warningToast,
      'Çakışma nedeniyle reddedilen taşımada kullanıcıya görünür bir uyarı bekleniyor ' +
        '(sessiz ret kullanıcı şikayetinin ta kendisiydi).',
    ).toBeVisible();
    await expect(editor.warningToast).toContainText(/çakış/i);
  });

  test('sağ kenarı 63. saniyeye çekmek klibi TAM 3 sn\'ye kırpar', async ({ editor, seed }) => {
    const before = await editor.state();
    const clip0 = findClip(before, seed.clipAId).clip;
    const settings = await readProjectSettings(editor.page);
    const targetEndUs = 63 * SECOND_US;

    // Ön koşul: 63 sn'nin yakınında aday yok (en yakını clipB başı, 13 sn ötede).
    expect(
      TimelineHarness.pxToUs(SNAP_THRESHOLD_PX, before.pxPerUs),
    ).toBeLessThan(13 * SECOND_US);

    await editor.timeline.dragRightEdgeToTime(seed.clipAId, targetEndUs);

    const after = await editor.state();
    const trimmed = findClip(after, seed.clipAId).clip;
    // Kırpma imlecin zamanını yeni kenar yapar; ızgaraya oturur.
    const expectedDurationUs = snapUsToFrameGrid(targetEndUs, settings.fps) - clip0.timelineStartUs;
    expect(expectedDurationUs).toBe(3 * SECOND_US);
    expect(
      trimmed.timelineDurationUs,
      `Klip süresi 3 sn olmalıydı (±${TOLERANCE_PX} px), yalnızca "kısaldı" değil.`,
    ).toBeGreaterThan(expectedDurationUs - tolUs(before.pxPerUs));
    expect(trimmed.timelineDurationUs).toBeLessThan(expectedDurationUs + tolUs(before.pxPerUs));

    // Sağ kenar kırpması SOL kenara dokunmaz — birebir.
    expect(trimmed.timelineStartUs).toBe(clip0.timelineStartUs);
    expect(after.historyLabels.at(-1)).toMatch(/kırp/i);
  });

  test('klibi alt track\'e sürüklemek katman değiştirir, ZAMANI değiştirmez', async ({
    editor,
    seed,
  }) => {
    const before = await editor.state();
    const clip0 = findClip(before, seed.clipAId);
    expect(clip0.trackIndex).toBe(0);

    await editor.timeline.dragClipByTime(seed.clipAId, 0, 1);

    const after = await editor.state();
    const moved = findClip(after, seed.clipAId);
    expect(moved.trackIndex).toBe(1);
    // Yatay piksel farkı SIFIR olduğu için burada tolerans YOK: dikey bir jestin
    // zamanı kıpırdatması tam olarak "katman değiştirince klip kaydı" hatasıdır.
    expect(
      moved.clip.timelineStartUs,
      'Yalnızca dikey sürükleme klibin zamanını değiştirmemeli.',
    ).toBe(clip0.clip.timelineStartUs);
    expect(moved.clip.timelineDurationUs).toBe(clip0.clip.timelineDurationUs);
  });

  test('Ctrl+Z gerçek fareyle yapılan taşımayı geri alır', async ({ editor, seed }) => {
    const before = await editor.state();
    const start0 = findClip(before, seed.clipAId).clip.timelineStartUs;
    expect(start0).toBe(SEED_TIMES.clipAStartUs);

    await editor.timeline.dragClipByTime(seed.clipAId, 8 * SECOND_US);
    const moved = await editor.state();
    const movedStart = findClip(moved, seed.clipAId).clip.timelineStartUs;
    expect(movedStart).toBeGreaterThan(68 * SECOND_US - tolUs(before.pxPerUs));
    expect(movedStart).toBeLessThan(68 * SECOND_US + tolUs(before.pxPerUs));

    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(120);

    const undone = await editor.state();
    expect(findClip(undone, seed.clipAId).clip.timelineStartUs).toBe(start0);
    expect(undone.cursor).toBe(before.cursor);
  });

  test('Ctrl+wheel zoom\'u TAM 1.2 kat değiştirir ve imleç zamanını sabit tutar', async ({
    editor,
  }) => {
    const before = await editor.state();
    const wrap = await editor.timeline.wrapBox();
    // zoomAt çapası: imlecin canvas içindeki yerel x'i (centerOfBody -> w/2).
    const anchorPx = wrap.width / 2;
    const anchorTime = (state: { scrollUs: number; pxPerUs: number }): number =>
      state.scrollUs + anchorPx / state.pxPerUs;

    await editor.timeline.ctrlWheel(-120);
    const zoomedIn = await editor.state();
    // TimelinePanel: deltaY < 0 -> faktör 1.2 (tek wheel olayı = tek adım).
    expect(
      zoomedIn.pxPerUs / before.pxPerUs,
      'Bir wheel adımı TAM 1.2 kat yakınlaştırmalı.',
    ).toBeCloseTo(1.2, 10);
    // Çapa değişmezliği: imlecin altındaki zaman yerinde kalmalı (aksi halde
    // yakınlaştırma içeriği kaydırır ve kullanıcı hedefini kaybeder).
    expect(
      Math.abs(anchorTime(zoomedIn) - anchorTime(before)),
      'Yakınlaştırma imlecin altındaki zamanı 1 pikselden fazla kaydırmamalı.',
    ).toBeLessThan(TimelineHarness.pxToUs(1, before.pxPerUs));

    await editor.timeline.ctrlWheel(240);
    const zoomedOut = await editor.state();
    expect(
      zoomedOut.pxPerUs / zoomedIn.pxPerUs,
      'deltaY > 0 tek adımda TAM 1/1.2 kat uzaklaştırmalı.',
    ).toBeCloseTo(1 / 1.2, 10);
    expect(
      zoomedOut.pxPerUs,
      'Yakınlaştır + uzaklaştır başlangıç zoom\'una dönmeli.',
    ).toBeCloseTo(before.pxPerUs, 12);
  });

  test('orta tuşla 200 px sürüklemek TAM 200 px\'lik zamanı kaydırır (pan)', async ({ editor }) => {
    // Kaydırma payı olsun diye önce yakınlaştır (scrollUs 0'da kırpılır).
    await editor.timeline.ctrlWheel(-120);
    await editor.timeline.ctrlWheel(-120);
    const before = await editor.state();

    const center = await editor.timeline.centerOfBody();
    const dragPx = 200;
    // "Grab" modeli (features/timeline/pan.ts): imleç SOLA giderse daha GEÇ
    // zaman görünür -> scrollUs artar, tam da kat edilen piksel kadar.
    await editor.timeline.drag(center, { x: center.x - dragPx, y: center.y }, 'middle');
    const panned = await editor.state();

    const expectedPanned = before.scrollUs + TimelineHarness.pxToUs(dragPx, before.pxPerUs);
    expect(
      panned.scrollUs,
      `200 px'lik pan tam olarak 200 px'lik zaman kaydırmalı (±${TOLERANCE_PX} px).`,
    ).toBeGreaterThan(expectedPanned - tolUs(before.pxPerUs));
    expect(panned.scrollUs).toBeLessThan(expectedPanned + tolUs(before.pxPerUs));
    // Pan zoom'a dokunmaz.
    expect(panned.pxPerUs).toBe(before.pxPerUs);

    // Ters yön aynı miktarı geri getirir.
    await editor.timeline.drag(center, { x: center.x + dragPx, y: center.y }, 'middle');
    const back = await editor.state();
    expect(
      back.scrollUs,
      'Aynı mesafe ters yöne sürüklenince başlangıç kaydırmasına dönülmeli.',
    ).toBeGreaterThan(before.scrollUs - tolUs(before.pxPerUs));
    expect(back.scrollUs).toBeLessThan(before.scrollUs + tolUs(before.pxPerUs));
  });

  test('Shift+wheel yatay kaydırmayı deltaY kadar piksel öteler', async ({ editor }) => {
    await editor.timeline.ctrlWheel(-120);
    const before = await editor.state();

    // 100 px: kaydırmanın ÜST SINIRINDAN (pan.ts maxPanScrollUs) uzak kalacak
    // kadar küçük, ölçülebilecek kadar büyük. Sınır davranışı bir sonraki testte.
    const deltaY = 100;
    await editor.timeline.shiftWheel(deltaY);
    const after = await editor.state();

    // TimelinePanel: scrollUs += deltaY / pxPerUs (sonra tam sayıya yuvarlanır).
    // Fare KONUMU işin içinde olmadığı için piksel yuvarlaması yok — iddia birebir.
    const expected = Math.round(before.scrollUs + deltaY / before.pxPerUs);
    expect(
      after.scrollUs,
      'Shift+wheel tam olarak deltaY piksellik zaman kaydırmalı. ' +
        `beklenen=${expected} gerçek=${after.scrollUs} ` +
        `scroll0=${before.scrollUs} pxPerUs=${before.pxPerUs} ` +
        '(sapma büyükse kaydırma üst sınırına çarpmış olabilir.)',
    ).toBe(expected);
    expect(after.pxPerUs, 'Shift+wheel zoom\'a dokunmamalı.').toBe(before.pxPerUs);
  });

  test('kaçak Shift+wheel içeriği ekrandan ATAMAZ: içerik sonu %75 çizgisinde durur', async ({
    editor,
  }) => {
    // Kaydırmanın üst sınırı (pan.ts): içerik sonu görünür alanın en fazla
    // %75'ine kadar gidebilir, yani ekranda DAİMA içerik kalır. Burada beklenen
    // değer uygulamanın fonksiyonundan değil, o KULLANICI KURALINDAN türetiliyor.
    const tailFraction = 0.25;
    await editor.timeline.ctrlWheel(-120);
    const wrap = await editor.timeline.wrapBox();

    // Tek seferde defalarca ekran boyu kaydırmayı dene.
    for (let i = 0; i < 6; i++) await editor.timeline.shiftWheel(2000);

    const after = await editor.state();
    const contentEndX = (SEED_TIMES.contentEndUs - after.scrollUs) * after.pxPerUs;
    expect(
      contentEndX,
      'Sınırsız yatay kaydırma "timeline boşaldı" şikayetinin ta kendisiydi: ' +
        'içerik sonu görünür alanın %75 çizgisinden geriye gidememeli.',
    ).toBeGreaterThan(wrap.width * (1 - tailFraction) - TOLERANCE_PX);
    expect(contentEndX).toBeLessThan(wrap.width * (1 - tailFraction) + TOLERANCE_PX);
  });
  /**
   * Cetvel scrub'ı ZOOM UÇLARINDA da tıklanan piksele oturur.
   *
   * İddia edilmişti: "çok uzaklaşılmış timeline'da cetvel scrub'ı ıskalıyor."
   * Bu test o iddiayı ölçen kalıcı kayıttır. Ölçülen: en uzak zoom seviyesinde
   * (pxPerUs alt sınırı MIN_PX_PER_US = 1 px/sn) tıklanan zaman ile playhead
   * arasında SIFIR sapma vardı; en yakın zoom'da (MAX_PX_PER_US) tek sapma
   * kaynağı `scrubTo`'nun kasıtlı frame ızgarası oturtmasıdır (yarım kareyi
   * aşmaz). Yani "ıskalama" ÜRETİLEMEDİ; bu test onu böyle sabitler.
   *
   * Neden sadece tek tık değil SÜRÜKLEME de: cetvelde basılı tutup gezinmek
   * pointer capture'a bağlıdır ve imleç canvas'ın dışına çıktığında da
   * sürmelidir — "ıskalama" en çok orada beklenirdi.
   *
   * PANEL-1B UYARLAMASI: cetvel scrub'ı artık proje sonunda KELEPÇELENİR
   * (kullanıcı kararı "hepsi kelepçelensin"). Uzak zoom'da içerik cetvelin
   * yalnız ilk ~%7'sini kaplar, gerisi kelepçe bölgesidir — "tıklanan piksele
   * oturur" iddiası ancak playhead'in GERÇEKTEN gidebildiği bölgede ölçülebilir.
   * Bu yüzden hem tıklama noktaları hem sürükleme hedefi kelepçe sınırından
   * türetilir; kelepçenin kendisi `timecode-input.spec.ts`te ölçülür.
   */
  test("cetvel scrub'ı zoom uçlarında da tıklanan piksele oturur", async ({ editor }) => {
    const page = editor.page;
    const fps = (await readProjectSettings(page)).fps;

    for (const direction of ['out', 'in'] as const) {
      await page.keyboard.press('Shift+Z'); // görünümü projeye sığdır
      await page.waitForTimeout(200);
      // Zoom'u kendi sınırına DAYA (clampPxPerUs): 40 adım her iki uç için de fazlasıyla yeter.
      for (let i = 0; i < 40; i++) {
        await editor.timeline.ctrlWheel(direction === 'out' ? 120 : -120, await editor.timeline.centerOfBody());
      }
      const wrap = await editor.timeline.wrapBox();
      const y = wrap.y + 14; // cetvel şeridi (RULER_H = 28)

      // Kelepçe sınırının ekran koordinatı ve altındaki kullanılabilir şerit.
      const zoomState = await editor.state();
      const capX = wrap.x + (SEED_TIMES.contentEndUs - zoomState.scrollUs) * zoomState.pxPerUs;
      expect(
        capX - wrap.x,
        `zoom=${direction}: proje sonu görünür alanda değil — ölçüm ön koşulu yok`,
      ).toBeGreaterThan(40);
      const usableWidth = Math.min(wrap.width, capX - wrap.x);

      for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = wrap.x + usableWidth * fraction;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(140);
        const state = await editor.state();
        // Beklenen değer uygulamanın TEK KAYNAK dönüşümünden türetilir
        // (geometry.xToTime + scrubTo'nun ızgara oturtması + panel-1b kelepçesi
        // clampPlayheadUs; kelepçe ızgara oturtmasından SONRA uygulanır).
        const expected = Math.min(
          SEED_TIMES.contentEndUs,
          snapUsToFrameGrid(
            Math.max(0, Math.round(state.scrollUs + (x - wrap.x) / state.pxPerUs)),
            fps as Rational,
          ),
        );
        expect(
          Math.abs(state.playheadUs - expected),
          `zoom=${direction} pxPerUs=${state.pxPerUs} x=${Math.round(x)}: cetvel tıklaması ` +
            `${expected} µs beklenirken ${state.playheadUs} µs verdi`,
        ).toBeLessThanOrEqual(tolUs(state.pxPerUs));
      }

      // Basılı tutup gezinme: canvas'ın SAĞINA taşsa bile playhead takip eder.
      // Hedef KELEPÇENİN ALTINDA seçilir — kelepçe bölgesinde "takip etti"
      // ölçülemez (playhead orada zaten proje sonunda durur, kopmuş bir pointer
      // capture ile aynı değeri verirdi).
      const endX = Math.min(wrap.x + wrap.width - 60, capX - 8);
      const startX = Math.max(wrap.x + 5, endX - 200);
      expect(
        endX - startX,
        `zoom=${direction}: kelepçe altında sürüklenecek yer kalmadı`,
      ).toBeGreaterThan(20);
      await page.mouse.move(startX, y);
      await page.mouse.down();
      await page.mouse.move(endX, y, { steps: 12 });
      await page.waitForTimeout(140);
      const dragged = await editor.state();
      const draggedExpected = Math.min(
        SEED_TIMES.contentEndUs,
        snapUsToFrameGrid(
          Math.max(0, Math.round(dragged.scrollUs + (endX - wrap.x) / dragged.pxPerUs)),
          fps as Rational,
        ),
      );
      expect(
        Math.abs(dragged.playheadUs - draggedExpected),
        `zoom=${direction}: cetvelde sürükleme imleci takip etmedi`,
      ).toBeLessThanOrEqual(tolUs(dragged.pxPerUs));

      const outsideX = wrap.x + wrap.width + 120;
      await page.mouse.move(outsideX, y, { steps: 6 });
      await page.waitForTimeout(140);
      const outside = await editor.state();
      await page.mouse.up();
      expect(
        outside.playheadUs,
        `zoom=${direction}: imleç canvas'ın dışına çıkınca scrub durdu (pointer capture kopmuş)`,
      ).toBeGreaterThan(dragged.playheadUs);
    }
  });
});
