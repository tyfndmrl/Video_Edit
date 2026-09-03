/**
 * Elle zaman kodu girişi — GERÇEK klavye ve fare (review-gate §3).
 *
 * `locator.fill()` BİLİNÇLİ OLARAK KULLANILMAZ: fill() değeri programatik
 * atar ve odak/seçim/tuş yolunu atlar — yani "alana tıklayıp yazınca ne oluyor"
 * sorusunu hiç sormaz. Desen guard-paths.spec.ts'teki `typeNumber` ile aynıdır
 * (gerçek tıklama -> Control+A -> keyboard.type -> Enter).
 *
 * Kanıtlanan davranış:
 *  - yazılan zaman kodu playhead'i TAM hedefe götürür (30 fps seed, 82 sn),
 *  - ⭐ off-by-one çivisi: `00:00:00:01` -> 33 334 µs ve alan `:01` KALIR
 *    (half-up `frameToUs` 33 333 verirdi ve alan tazelenince `:00`a düşerdi),
 *  - kısa yazım (`30` = 30 sn) ve proje sonu kelepçesi (görünür bildirimle),
 *  - çöp metin: playhead OYNAMAZ, metin korunur, gerekçe yazılır; blur geri alır,
 *  - Escape yazılanı geri alır,
 *  - ⭐ kısayol izolasyonu: alanda `c`/Space/Delete/ArrowRight/Home dokümanı
 *    ve transport durumunu DEĞİŞTİRMEZ,
 *  - oynatırken commit playhead'i atlatır ama oynatmayı KESMEZ,
 *  - kelepçe yayılımı: cetvelde proje sonunun ötesine tıklamak ve ok tuşuyla
 *    sondan ileri gitmek de proje sonunda durur (kullanıcı kararı: hepsi).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { SECOND_US, SEED_TIMES } from './fixtures/seed';

const FIELD = 'transport-timecode-input';
const MESSAGE = 'transport-timecode-message';

function field(page: Page) {
  return page.getByTestId(FIELD);
}

/** Alana GERÇEK fare tıklaması (odak + tüm metnin seçilmesi buradan gelir). */
async function focusField(page: Page): Promise<void> {
  const el = field(page);
  await expect(el, 'Zaman kodu alanı ekranda yok.').toBeVisible();
  const box = await el.boundingBox();
  expect(box, 'Zaman kodu alanının kutusu okunamadı.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(el, 'Tıklama alana odak vermedi.').toBeFocused();
}

/** Gerçek klavye: tıkla -> hepsini seç -> yaz -> (isteğe bağlı) Enter. */
async function typeTimecode(page: Page, value: string, commit = true): Promise<void> {
  await focusField(page);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  if (commit) await page.keyboard.press('Enter');
  await page.waitForTimeout(160);
}

/** Alanın dışına GERÇEK tıklama (yan taraftaki süre göstergesi — yan etkisiz). */
async function clickAway(page: Page): Promise<void> {
  const el = page.getByTitle('Proje süresi');
  const box = await el.boundingBox();
  expect(box, 'Proje süresi göstergesi bulunamadı.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(160);
}

async function isPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { editor: { useEditorStore: { getState(): { isPlaying: boolean } } } };
    }).__ve;
    return bridge.editor.useEditorStore.getState().isPlaying;
  });
}

function clipCount(state: { tracks: { clips: unknown[] }[] }): number {
  return state.tracks.reduce((n, t) => n + t.clips.length, 0);
}

test.describe('Transport zaman kodu alanı — gerçek klavye', () => {
  test('yazılan zaman kodu playhead\'i tam hedefe götürür', async ({ editor }) => {
    const page = editor.page;
    // ÖNCE gerçek bir kullanıcı seek'i (cetvel scrub'ı). Bu satır süs değil:
    // alan playhead'i `'engine'` kaynağıyla yazsaydı, araya giren bir user
    // seek'ten sonra store o yazımı SESSİZCE DÜŞÜRÜRDÜ (intersection contract A)
    // ve alan "bazen çalışır" olurdu. Scrub olmadan test o hatayı göremez.
    await editor.timeline.scrubTo(10 * SECOND_US);
    const scrubbed = (await editor.state()).playheadUs;
    expect(scrubbed, 'Ön koşul: scrub 10 sn civarına oturmalıydı.').toBeGreaterThan(8 * SECOND_US);

    await typeTimecode(page, '00:00:05:00');

    expect((await editor.state()).playheadUs, 'Yazılan zaman kodu uygulanmadı.').toBe(
      5 * SECOND_US,
    );
    await expect(field(page)).toHaveValue('00:00:05:00');
    await expect(page.getByTestId(MESSAGE)).toHaveCount(0);
  });

  test('OFF-BY-ONE ÇİVİSİ: 00:00:00:01 -> 33 334 µs ve alan :01 kalır', async ({ editor }) => {
    const page = editor.page;
    await typeTimecode(page, '00:00:00:01');

    // 30 fps'te half-up frameToUs 33 333 verirdi; formatTimecode(33 333) ise
    // "00:00:00:00" der (time-vectors.json). Yani yanlış taraf seçilseydi
    // playhead 33 333'e giderdi VE alan yazılanı kaybederdi.
    expect(
      (await editor.state()).playheadUs,
      'Bir kare için half-up değer (33 333) yazılmış — alan kendi yazdığını gösteremez.',
    ).toBe(33_334);
    await expect(
      field(page),
      'Alan tazelenince ":01" yerine ":00" gösteriyor (ters dönüşüm ileri fonksiyona çivili değil).',
    ).toHaveValue('00:00:00:01');
  });

  test('kısa yazım: 30 = 30 saniye', async ({ editor }) => {
    const page = editor.page;
    await typeTimecode(page, '30');
    expect((await editor.state()).playheadUs).toBe(30 * SECOND_US);
  });

  test('proje sonunun ötesi SONA oturur ve bunu söyler', async ({ editor }) => {
    const page = editor.page;
    await typeTimecode(page, '90'); // içerik 82. saniyede bitiyor

    expect((await editor.state()).playheadUs, 'Kelepçe uygulanmadı.').toBe(
      SEED_TIMES.contentEndUs,
    );
    const note = page.getByTestId(MESSAGE);
    await expect(note, 'Kelepçe SESSİZCE uygulandı — kullanıcı neden orada durduğunu bilmiyor.').toBeVisible();
    await expect(note).toHaveAttribute('data-kind', 'notice');
    await expect(note).toHaveText('Proje sonuna oturtuldu');
    await expect(field(page)).toHaveValue('00:01:22:00');

    // YERLEŞİM SÖZLEŞMESİ: mesaj transport çubuğuna YENİ SATIR açmaz. Açsaydı
    // çubuk uzar, `flex-1` sahne kısalır ve tuvalin letterbox kutusu (gizmo
    // koordinat kökeni) kayardı. Ölçüm: mesaj oynat düğmesiyle AYNI satırda.
    const playBox = await page.getByRole('button', { name: /^(Oynat|Duraklat)$/ }).boundingBox();
    const noteBox = await note.boundingBox();
    expect(playBox && noteBox, 'Kutular okunamadı.').toBeTruthy();
    const dy = Math.abs(
      noteBox!.y + noteBox!.height / 2 - (playBox!.y + playBox!.height / 2),
    );
    expect(dy, 'Mesaj transport çubuğuna yeni bir satır açtı (sahne yüksekliği kayar).').toBeLessThan(6);
  });

  test('çöp metin: playhead oynamaz, metin korunur, gerekçe yazılır; blur geri alır', async ({
    editor,
  }) => {
    const page = editor.page;
    await typeTimecode(page, '00:00:05:00');
    const before = (await editor.state()).playheadUs;

    await typeTimecode(page, 'abc');
    expect((await editor.state()).playheadUs, 'Geçersiz metin playhead\'i oynattı.').toBe(before);
    await expect(field(page), 'Reddedilen metin silindi — kullanıcı ne yazdığını göremiyor.').toHaveValue('abc');
    const err = page.getByTestId(MESSAGE);
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('data-kind', 'error');
    await expect(err).toHaveAttribute('role', 'status');
    await expect(err).toContainText('anlaşılmadı');

    // Odaktan çıkınca alan yalancı bir ayna olarak KALMAZ.
    await clickAway(page);
    await expect(field(page)).toHaveValue('00:00:05:00');
    await expect(page.getByTestId(MESSAGE)).toHaveCount(0);
    expect((await editor.state()).playheadUs).toBe(before);
  });

  test('Escape yazılanı geri alır (playhead değişmez)', async ({ editor }) => {
    const page = editor.page;
    await typeTimecode(page, '00:00:05:00');
    const before = (await editor.state()).playheadUs;

    await typeTimecode(page, '00:00:40:00', false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(160);

    expect((await editor.state()).playheadUs, 'Escape\'e rağmen seek yapıldı.').toBe(before);
    await expect(field(page)).toHaveValue('00:00:05:00');
    await expect(page.getByTestId(MESSAGE)).toHaveCount(0);
  });

  test('KISAYOL İZOLASYONU: alandayken c/Space/Delete/ok/Home dokümanı bozmaz', async ({
    editor,
  }) => {
    const page = editor.page;
    await typeTimecode(page, '00:01:03:00'); // clipA'nın (60-66 sn) içinde
    const before = await editor.state();
    const clipsBefore = clipCount(before);
    expect(clipsBefore, 'Seed iki klip kurmalıydı.').toBe(2);

    await focusField(page);
    for (const k of ['c', ' ', 'Delete', 'ArrowRight', 'Home']) {
      await page.keyboard.press(k);
    }
    await page.waitForTimeout(200);

    const after = await editor.state();
    expect(clipCount(after), '"c" alandayken klibi BÖLDÜ (kısayol sızdı).').toBe(clipsBefore);
    expect(await isPlaying(page), 'Space alandayken oynatmayı başlattı.').toBe(false);
    expect(after.playheadUs, 'Ok/Home tuşları alandayken playhead\'i oynattı.').toBe(
      before.playheadUs,
    );
  });

  test('oynatırken commit: playhead atlar, oynatma sürer', async ({ editor }) => {
    const page = editor.page;
    const play = page.getByRole('button', { name: /^(Oynat|Duraklat)$/ });
    const box = await play.boundingBox();
    expect(box, 'Transport düğmesi görünmüyor.').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => isPlaying(page), { message: 'Oynatma başlamadı.' }).toBe(true);

    await typeTimecode(page, '00:00:20:00');

    await expect
      .poll(async () => (await editor.state()).playheadUs, {
        message: 'Oynatırken yazılan zaman koduna atlanmadı.',
      })
      .toBeGreaterThanOrEqual(20 * SECOND_US);
    expect(
      (await editor.state()).playheadUs,
      'Hedefin çok ötesine geçti — seek yerine başka bir şey oldu.',
    ).toBeLessThan(26 * SECOND_US);
    expect(await isPlaying(page), 'Zaman kodu commit\'i oynatmayı DURDURDU.').toBe(true);
  });
});

test.describe('Proje sonu kelepçesi — alan dışındaki yollar', () => {
  test('cetvelde proje sonunun ötesine tıklamak sonda durur', async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
    const st = await editor.state();
    const wrap = await editor.timeline.wrapBox();
    // Sığdırma içeriği genişliğin %95'ine oturtur; sağ uç bilerek içerik
    // SONRASINI gösterir. Ön koşul olmadan test boş yere yeşil olurdu.
    const beyondUs = st.scrollUs + (wrap.width - 4) / st.pxPerUs;
    expect(
      beyondUs,
      'Cetvelin sağ ucu proje sonundan sonrasını göstermiyor — ön koşul sağlanmadı.',
    ).toBeGreaterThan(SEED_TIMES.contentEndUs);

    await editor.timeline.click(await editor.timeline.rulerPoint(beyondUs, st));
    expect(
      (await editor.state()).playheadUs,
      'Cetvel scrub\'ı playhead\'i içeriğin ötesine taşıdı.',
    ).toBe(SEED_TIMES.contentEndUs);
  });

  test('End sonrası ok tuşları proje sonunu aşmaz', async ({ editor, seed }) => {
    const page = editor.page;
    await editor.ensureContentVisible(seed.clipAId);
    // Odak alanda OLMAMALI (dispatcher input'ta pasiftir) — cetvele tıklayarak
    // klavyeyi timeline'a ver.
    await editor.timeline.scrubTo(10 * SECOND_US);

    await page.keyboard.press('End');
    await page.waitForTimeout(120);
    expect((await editor.state()).playheadUs).toBe(SEED_TIMES.contentEndUs);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(160);
    expect(
      (await editor.state()).playheadUs,
      'Ok tuşları playhead\'i proje sonunun ötesine taşıdı.',
    ).toBe(SEED_TIMES.contentEndUs);
  });
});
