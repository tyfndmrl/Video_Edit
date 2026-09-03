/**
 * Timeline dikey boyutlandırma — GERÇEK fare/klavye (panel turu dilim 2b).
 *
 * ASIL SÖZLEŞME (T1): timeline'ın YÜKSEKLİĞİ değişir, YATAY DÜZLEMİ değişmez.
 * Aynı klibin ekrandaki x'i ve genişliği, zoom (pxPerUs) ve yatay kaydırma
 * (scrollUs) sürüklemeden ETKİLENMEZ — kullanıcı "biraz yer açayım" derken
 * kesim noktalarını kaybetmemelidir.
 *
 * SIZINTI ÖNLEMİ (yüksek risk): e2e context'i WORKER-scope'tur (fixtures/test.ts
 * account fixture'ı worker başına TEK tarayıcı context'i açar) — yani
 * localStorage TÜM spec'ler arasında yaşar. Burada bırakılacak bir yükseklik
 * tercihi sonraki spec'lerin timeline geometrisini sessizce değiştirirdi. Bu
 * yüzden her testin ÖNCESİNDE anahtar silinir ve sayfa YENİDEN açılır (store
 * değeri yalnız açılışta okur), SONRASINDA da silinir.
 */
import { snapUsToFrameGrid, type Rational } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { findClip, readProjectSettings } from './support/appBridge';
import { TimelineHarness } from './support/timeline';
import { SECOND_US } from './fixtures/seed';
import { DEFAULT_TIMELINE_H, MIN_PLAYER_H } from '../src/features/timeline/timelineHeight';
import { NEW_TRACK_ZONE_H, RULER_H, TRACK_GAP, TRACK_H } from '../src/features/timeline/geometry';

/** Fare/düzen yuvarlamasının kabul edilen üst sınırı (px). */
const PX_TOLERANCE = 1.5;
/** Klip x/genişliğinde İZİN VERİLEN sapma: yok denecek kadar (asıl sözleşme). */
const CLIP_PX_TOLERANCE = 0.5;
/** Tutamağın ok tuşu adımı (TimelineResizeHandle STEP_PX). */
const STEP_PX = 8;

/** Oynatıcı hücresinin (main) ekran yüksekliği. */
async function playerHeight(page: import('@playwright/test').Page): Promise<number> {
  const h = await page.evaluate(() => {
    const el = document.querySelector('main');
    return el ? el.getBoundingClientRect().height : null;
  });
  expect(h, 'Oynatıcı hücresi (main) bulunamadı.').not.toBeNull();
  return h as number;
}

/** Tutamağın ilan ettiği sınırlar (a11y sözleşmesi = uygulamanın kendi sayısı). */
async function handleBounds(
  harness: TimelineHarness,
): Promise<{ now: number; min: number; max: number }> {
  const handle = harness.resizeHandle();
  const [now, min, max] = await Promise.all([
    handle.getAttribute('aria-valuenow'),
    handle.getAttribute('aria-valuemin'),
    handle.getAttribute('aria-valuemax'),
  ]);
  expect(now, 'Tutamak aria-valuenow taşımalı.').not.toBeNull();
  return { now: Number(now), min: Number(min), max: Number(max) };
}

test.describe('Timeline dikey boyutlandırma', () => {
  test.beforeEach(async ({ editor, seed }) => {
    // Önceki spec'ten kalmış olabilecek tercihi sil ve sayfayı TAZE aç:
    // yükseklik store'u kayıtlı değeri yalnız açılışta okur.
    await TimelineHarness.clearStoredHeight(editor.page);
    await editor.open(seed.projectId, { email: seed.email, password: seed.password });
    await editor.ensureContentVisible(seed.clipAId);
  });

  test.afterEach(async ({ editor }) => {
    // Sızıntı önlemi: paketin geri kalanı varsayılan yükseklikle koşsun.
    await TimelineHarness.clearStoredHeight(editor.page);
  });

  test('T1 ⭐ 120 px büyütme: yükseklik +120, klibin x/genişliği ve zoom/scroll AYNI', async ({
    editor,
    seed,
  }) => {
    const timeline = editor.timeline;
    const before = await editor.state();
    const sectionBefore = await timeline.sectionBox();
    const clipBefore = await timeline.clipBox(seed.clipAId, before);

    await timeline.dragHandleBy(-120);

    const sectionAfter = await timeline.sectionBox();
    expect(
      sectionAfter.height,
      'Tutamağı 120 px yukarı sürüklemek timeline satırını 120 px büyütmeli.',
    ).toBeCloseTo(sectionBefore.height + 120, 0);

    const after = await editor.state();
    const clipAfter = await timeline.clipBox(seed.clipAId, after);
    // ASIL SÖZLEŞME: yatay düzlem dokunulmamış.
    expect(after.pxPerUs, 'Dikey boyutlandırma zoom\'u değiştirdi.').toBe(before.pxPerUs);
    expect(after.scrollUs, 'Dikey boyutlandırma yatay kaydırmayı değiştirdi.').toBe(
      before.scrollUs,
    );
    expect(
      Math.abs(clipAfter.x - clipBefore.x),
      `Klibin ekrandaki x'i kaydı (${clipBefore.x.toFixed(1)} -> ${clipAfter.x.toFixed(1)}).`,
    ).toBeLessThanOrEqual(CLIP_PX_TOLERANCE);
    expect(
      Math.abs(clipAfter.width - clipBefore.width),
      `Klibin genişliği değişti (${clipBefore.width.toFixed(1)} -> ${clipAfter.width.toFixed(1)}).`,
    ).toBeLessThanOrEqual(CLIP_PX_TOLERANCE);
    // Belge dokunulmadı: yükseklik bir görünüm tercihidir.
    expect(after.historyLabels).toEqual(before.historyLabels);
  });

  test('T2 400 px küçültme: alt sınırda durur, +V düğmesi ve yeni-track bölgesi erişilebilir kalır', async ({
    editor,
  }) => {
    const timeline = editor.timeline;
    const page = editor.page;

    await timeline.dragHandleBy(400);

    const bounds = await handleBounds(timeline);
    const section = await timeline.sectionBox();
    expect(
      section.height,
      `Küçültme alt sınırda durmalıydı (aria-valuemin ${bounds.min}).`,
    ).toBeCloseTo(bounds.min, 0);

    // Başlık düğmeleri hâlâ GERÇEKTEN tıklanabilir (tutamak onları çalmadı).
    const before = await editor.state();
    await page.locator('button[title="Video track ekle"]').click();
    await page.waitForTimeout(120);
    expect(
      (await editor.state()).tracks.length,
      'En küçük yükseklikte "+V" düğmesi tıklanamıyor (tutamak üstünü kapatmış olabilir).',
    ).toBe(before.tracks.length + 1);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(120);

    // Bir tam track satırı + yeni-track bölgesi canvas gövdesinde duruyor.
    const wrap = await timeline.wrapBox();
    expect(
      wrap.height,
      'En küçük yükseklikte bir satır + yeni-track bölgesi canvas gövdesine sığmıyor.',
    ).toBeGreaterThanOrEqual(RULER_H + TRACK_H + TRACK_GAP + NEW_TRACK_ZONE_H - PX_TOLERANCE);
  });

  test('T3 2000 px büyütme: üst sınırda durur, oynatıcıya en az 160 px kalır', async ({
    editor,
  }) => {
    const timeline = editor.timeline;
    await timeline.dragHandleBy(-2000);

    const bounds = await handleBounds(timeline);
    const section = await timeline.sectionBox();
    expect(
      section.height,
      `Büyütme üst sınırda durmalıydı (aria-valuemax ${bounds.max}).`,
    ).toBeCloseTo(bounds.max, 0);

    expect(
      await playerHeight(editor.page),
      `Oynatıcıya ${MIN_PLAYER_H} px'ten az yer kaldı — sahne kaybolur.`,
    ).toBeGreaterThanOrEqual(MIN_PLAYER_H - PX_TOLERANCE);
  });

  test('T4 ⭐ KALICILIK: boyut reload sonrası korunur ve localStorage o değeri taşır', async ({
    editor,
  }) => {
    const timeline = editor.timeline;
    const page = editor.page;

    await timeline.dragHandleBy(-90);
    const resized = await timeline.sectionBox();

    const stored = await TimelineHarness.readStoredHeight(page);
    expect(stored, 'Boyutlandırma localStorage anahtarını yazmadı.').not.toBeNull();
    expect(
      Number(stored),
      `Kaydedilen değer ekrandaki yükseklikle uyuşmuyor (${stored} vs ${resized.height}).`,
    ).toBeCloseTo(resized.height, 0);

    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });
    await expect(page.getByTestId('timeline-loading-overlay')).toHaveCount(0);
    await page.waitForTimeout(250);

    expect(
      (await timeline.sectionBox()).height,
      'Yükseklik reload sonrası korunmadı (tercih tarayıcıda kalıcı olmalı).',
    ).toBeCloseTo(resized.height, 0);
  });

  test('T5 HIT-TEST: büyütmeden sonra sürükleme ve tıklama doğru hedefi vuruyor', async ({
    editor,
    seed,
  }) => {
    const timeline = editor.timeline;
    await timeline.dragHandleBy(-140);

    const before = await editor.state();
    const anchor = findClip(before, seed.clipAId).clip;
    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;

    // clipA [60s,66s) -> +8 sn: [68s,74s) (timeline-mouse ile aynı hedef).
    const deltaUs = 8 * SECOND_US;
    await timeline.dragClipByTime(seed.clipAId, deltaUs);

    const after = await editor.state();
    const moved = findClip(after, seed.clipAId);
    const expectedStartUs = snapUsToFrameGrid(anchor.timelineStartUs + deltaUs, fps);
    const tolUs = TimelineHarness.pxToUs(2, before.pxPerUs);
    expect(
      moved.clip.timelineStartUs,
      'Boyutlandırmadan sonra sürükleme yanlış süreye düştü (dikey kaymayı hesaba katmayan hit-test).',
    ).toBeGreaterThan(expectedStartUs - tolUs);
    expect(moved.clip.timelineStartUs).toBeLessThan(expectedStartUs + tolUs);
    expect(moved.trackIndex).toBe(findClip(before, seed.clipAId).trackIndex);

    // Tıklama da doğru klibi seçer.
    await editor.timeline.click(await timeline.clipCenter(seed.clipBId));
    expect((await editor.state()).selection).toEqual([seed.clipBId]);
  });

  test('T6 scrollY: içerik sığana kadar büyütünce kaydırma sıfırlanır, satır 0 doğru klibi verir', async ({
    editor,
    seed,
  }) => {
    const timeline = editor.timeline;
    const page = editor.page;

    // İçeriği gövdeden taşır (5 track) ve dibe kaydır.
    const addVideoTrack = page.locator('button[title="Video track ekle"]');
    for (let i = 0; i < 3; i++) {
      await addVideoTrack.click();
      await page.waitForTimeout(80);
    }
    await timeline.wheel(1200);

    const wrapScrolled = await timeline.wrapBox();
    const scrolled = wrapScrolled.y + RULER_H - (await timeline.trackHeaderTop(0));
    // ÖN KOŞUL: gerçekten kaydı (aksi halde test boş).
    expect(scrolled, 'Wheel kaydırmadı — testin ön koşulu sağlanmadı.').toBeGreaterThan(20);

    // Şimdi paneli büyüt: içerik sığar, sınır 0'a düşer, kaydırma geri çekilmeli.
    await timeline.dragHandleBy(-200);

    const wrap = await timeline.wrapBox();
    expect(
      await timeline.trackHeaderTop(0),
      'Panel büyüdü ama scrollY bayat kaldı: üstte boşluk, altta boş şerit.',
    ).toBeCloseTo(wrap.y + RULER_H, 0);

    const state = await editor.state();
    const clip = findClip(state, seed.clipAId);
    expect(clip.trackIndex, 'clipA ilk satırda olmalı').toBe(0);
    const midUs = clip.clip.timelineStartUs + clip.clip.timelineDurationUs / 2;
    await timeline.click(await timeline.point(midUs, 0, state));
    expect(
      (await editor.state()).selection,
      'Büyütmeden sonra satır 0\'a tıklama doğru klibi seçmedi (hit-test kayması).',
    ).toEqual([seed.clipAId]);
  });

  test('T7 KLAVYE: ok/Shift+ok/End/Home yüksekliği değiştirir, playhead HİÇ oynamaz', async ({
    editor,
  }) => {
    const timeline = editor.timeline;
    const page = editor.page;

    // ÖN KOŞUL (gevşetme değil, iddiayı ÖLÇÜLEBİLİR yapan adım): playhead'i
    // gerçek cetvel tıklamasıyla SIFIRDAN UZAĞA taşı. Sıfırda dursaydı
    // dispatcher'a sızan bir 'Home' (setPlayhead(0)) fark edilmezdi — test
    // sızıntıyı görmeden yeşil kalırdı (bu ölçüldü).
    await timeline.scrubTo(5 * SECOND_US);

    // Gerçek tıkla odaklan (tutamak sürükleme jestiyle aynı yolla odak alır).
    const handleBox = await timeline.resizeHandleBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(80);
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      ),
      'Tutamağa tıklamak onu odaklamadı — klavye sözleşmesi ölçülemez.',
    ).toBe('timeline-resize-handle');

    const playheadBefore = (await editor.state()).playheadUs;
    expect(playheadBefore, 'Cetvel scrub\'ı playhead\'i taşımadı (ön koşul).').toBeGreaterThan(0);
    const start = (await timeline.sectionBox()).height;

    /** Her adımdan SONRA: tuş global dispatcher'a sızmadı mı? */
    const expectPlayheadStill = async (step: string): Promise<void> => {
      expect(
        (await editor.state()).playheadUs,
        `"${step}" global kısayol dispatcher'ına SIZDI (playhead oynadı): ↑↓ orada ` +
          'kesme noktası, Home/End playhead\'dir.',
      ).toBe(playheadBefore);
    };

    // Ok tuşu x4 -> +32 px.
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(120);
    expect((await timeline.sectionBox()).height, 'ArrowUp x4 = +32 px').toBeCloseTo(
      start + 4 * STEP_PX,
      0,
    );
    await expectPlayheadStill('ArrowUp');

    // Shift+ok -> bir track satırı (TRACK_H + TRACK_GAP).
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(120);
    expect((await timeline.sectionBox()).height, 'Shift+ArrowUp = +1 track satırı').toBeCloseTo(
      start + 4 * STEP_PX + TRACK_H + TRACK_GAP,
      0,
    );
    await expectPlayheadStill('Shift+ArrowUp');

    // End -> üst sınır, Home -> alt sınır (tutamağın ilan ettiği değerler).
    await page.keyboard.press('End');
    await page.waitForTimeout(120);
    const atMax = await handleBounds(timeline);
    expect((await timeline.sectionBox()).height, 'End üst sınıra gitmeli').toBeCloseTo(
      atMax.max,
      0,
    );
    await expectPlayheadStill('End');

    await page.keyboard.press('Home');
    await page.waitForTimeout(120);
    const atMin = await handleBounds(timeline);
    expect((await timeline.sectionBox()).height, 'Home alt sınıra gitmeli').toBeCloseTo(
      atMin.min,
      0,
    );
    await expectPlayheadStill('Home');
  });

  test('T8 VARSAYILAN: depolama boşken timeline satırı 280 px', async ({ editor }) => {
    expect(
      await TimelineHarness.readStoredHeight(editor.page),
      'Test kayıtlı yükseklikle başlamamalı (sızıntı önlemi çalışmıyor).',
    ).toBeNull();
    expect(
      (await editor.timeline.sectionBox()).height,
      'Depolama boşken görünüm özellik ÖNCESİYLE birebir aynı olmalı.',
    ).toBeCloseTo(DEFAULT_TIMELINE_H, 0);
  });
});
