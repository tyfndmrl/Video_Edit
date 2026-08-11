/**
 * Erişilebilirlik dumanı — klavyeyle dolaşım ve rol/aria sözleşmesi.
 *
 * Kapsam dürüstlüğü: bu bir WCAG denetimi DEĞİL. Burada doğrulanan dört şey var
 * ve dördü de gerçek girdiyle ölçülür:
 *  1. Ana kontrollere fare olmadan (yalnız Tab ile) ULAŞILABİLİYOR mu,
 *  2. Menü/diyalog/durum bölgeleri doğru ROL'ü taşıyor mu (ekran okuyucunun
 *     "menü açıldı", "iletişim kutusu", "durum" diyebilmesi bunlara bağlı),
 *  3. Menü ve diyalog klavyeyle GEZİLİP kapatılabiliyor mu (fare tuzağı yok),
 *  4. `aria-modal="true"` diyen diyaloglar bu SÖZÜ TUTUYOR mu — odak tuzağı,
 *     Escape ile kapanma, kapanınca odağın tetikleyiciye dönmesi
 *     (bkz. aşağıdaki "modal odak sözleşmesi" bölümü ve oradaki UYARI).
 * Kontrast, odak halkası görünürlüğü ve canvas timeline'ın klavyeyle
 * düzenlenmesi kapsam DIŞI (docs/backlog.md).
 *
 * M4 dalga 2 denetimi (YÜKSEK) 4. maddeyi şöyle bulmuştu: dosya `aria-modal`
 * ÖZNİTELİĞİNİ doğruluyor ama o özniteliğin VAAT ETTİĞİ davranışın hiçbirini
 * ölçmüyordu — yani ekran okuyucu sözleşmesi "yeşil" görünürken klavye
 * kullanıcısı diyaloğun arkasına düşebiliyordu. Sahte güven buradan geliyordu.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';

/** Odaklı öğenin kullanıcıya görünen adı (aria-label > title > metin). */
async function focusedLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const label =
      el.getAttribute('aria-label') ??
      el.getAttribute('title') ??
      (el.textContent ?? '').trim();
    return `${el.tagName.toLowerCase()}:${label.slice(0, 40)}`;
  });
}

/** `count` kez Tab'a basar ve yol boyunca odaklanan öğeleri toplar. */
async function tabThrough(page: Page, count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    const label = await focusedLabel(page);
    if (label !== null) seen.push(label);
  }
  return seen;
}

/** focusedLabel'ın DAİMA metin döndüren hâli (hata mesajlarında boşluk kalmasın). */
async function focusHere(page: Page): Promise<string> {
  return (await focusedLabel(page)) ?? 'document.body (odak hiçbir kontrolde değil)';
}

/** Odaklı öğe `selector` ile eşleşen kökün İÇİNDE mi? (kök yoksa false) */
async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const el = document.activeElement;
    return !!root && !!el && root.contains(el);
  }, selector);
}

/**
 * `steps` kez Tab (ya da Shift+Tab) basar; odağın `selector` kökünün DIŞINA
 * çıktığı her adımı okunur biçimde döndürür. Boş dizi = odak tuzağı tutuyor.
 */
async function tabsEscaping(
  page: Page,
  selector: string,
  steps: number,
  shift = false,
): Promise<string[]> {
  const escapes: string[] = [];
  const key = shift ? 'Shift+Tab' : 'Tab';
  for (let i = 1; i <= steps; i++) {
    await page.keyboard.press(key);
    if (!(await focusInside(page, selector))) {
      escapes.push(`${key} #${i} -> ${await focusHere(page)}`);
    }
  }
  return escapes;
}

test.describe('Erişilebilirlik — klavye ve roller', () => {
  test('ana kontrollere yalnız Tab ile ULAŞILIR', async ({ editor }) => {
    const page = editor.page;
    // Odağı belgenin başına al (fare kullanmadan).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const visited = await tabThrough(page, 24);
    const joined = visited.join('\n');

    for (const expected of [
      'Proje seçiciye dön', // TopBar "Projeler"
      'Klavye kısayolları (?)',
      'Dışa Aktar',
      'Oturumu kapat', // TopBar "Çıkış"
      'Dosya seç',
      'Oynat',
      'Video track ekle',
      'Sığdır (Shift+Z)',
    ]) {
      expect(
        joined,
        `Tab ile ulaşılamayan kontrol: "${expected}".\nGezilen odaklar:\n${joined}`,
      ).toContain(expected);
    }
  });

  test('devre dışı kontroller odak sırasını KİRLETMEZ, etkinleşince sıraya girer', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Başlangıçta geçmiş boş -> Geri al devre dışı -> Tab ona uğramaz.
    const before = (await tabThrough(page, 24)).join('\n');
    expect(before).not.toContain('Geri al');

    // Gerçek bir düzenleme yap (gerçek fare) -> Geri al etkinleşir.
    await editor.ensureContentVisible(seed.clipAId);
    await editor.timeline.dragClipByTime(seed.clipAId, 2_000_000);
    await expect(editor.undoButton).toBeEnabled();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const after = (await tabThrough(page, 24)).join('\n');
    expect(after, 'Etkinleşen "Geri al" düğmesine Tab ile ulaşılamıyor.').toContain('Geri al');
  });

  test('sağ tık menüsü role="menu" taşır, ok tuşlarıyla gezilir ve Escape ile kapanır', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await editor.ensureContentVisible(seed.clipAId);
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-orientation', 'vertical');
    await expect(menu).toHaveAttribute('aria-label', 'Timeline işlemleri');
    expect(await menu.getByRole('menuitem').count()).toBeGreaterThan(0);

    // Açılışta ilk ETKİN öğe odaklanır; ArrowDown bir sonrakine geçer.
    const first = await focusedLabel(page);
    expect(first, 'Menü açıldığında odak menüye taşınmadı.').not.toBeNull();
    await page.keyboard.press('ArrowDown');
    const second = await focusedLabel(page);
    expect(second, 'ArrowDown menüde odağı ilerletmedi.').not.toBe(first);

    await page.keyboard.press('Escape');
    await expect(menu, 'Escape menüyü kapatmalı.').toHaveCount(0);
  });

  test('export diyaloğu role="dialog" + aria-modal taşır ve başlığı ile ilişkilidir', async ({
    editor,
  }) => {
    const page = editor.page;
    await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = await dialog.getAttribute('aria-labelledby');
    expect(labelledBy, 'Diyaloğun erişilebilir adı yok (aria-labelledby).').toBeTruthy();
    await expect(page.locator(`#${labelledBy}`)).toHaveText('Dışa Aktar');

    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('kısayol yardımı "?" ile açılır, role="dialog" taşır ve Escape ile kapanır', async ({
    editor,
  }) => {
    const page = editor.page;
    await page.keyboard.press('?');
    const overlay = page.getByRole('dialog');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
    await expect(overlay.getByRole('button', { name: 'Kapat' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('reddedilen işlem role="status" ile duyurulur (sessiz ret yok)', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    await editor.ensureContentVisible(seed.clipAId);
    // clipA'yı clipB'nin üstüne sürüklemek reddedilir -> uyarı çıkmalı.
    await editor.timeline.dragClipByTime(seed.clipAId, 16_000_000);

    const status = page.locator('[data-testid="timeline-warning"]');
    await expect(status, 'Reddedilen taşıma için kullanıcıya uyarı gösterilmedi.').toBeVisible();
    await expect(status).toHaveAttribute('role', 'status');
  });
});

// ---------------------------------------------------------------------------
// Modal odak sözleşmesi — `aria-modal="true"` demenin BEDELİ
// ---------------------------------------------------------------------------
//
// !!! BU BÖLÜMÜ OKUMADAN DEĞİŞTİRMEYİN !!!
//
// Aşağıdaki testler ürünün BUGÜN yapmadığı davranışları tarif eder. Bunlar
// M4 dalga 2 denetiminin YÜKSEK bulgusudur: üç overlay de `aria-modal="true"`
// yazar (ExportDialog.tsx, ShortcutsHelpOverlay.tsx, ConflictDialog.tsx) ama
// hiçbirinde odak yönetimi YOKTUR — ne açılışta odağı içeri alma, ne odak
// tuzağı, ne kapanışta odağı tetikleyiciye döndürme; ExportDialog'da Escape
// ile kapanma da yok (shortcuts/dispatcher.ts Escape'i yalnız kısayol
// overlay'i için işler). Ekran okuyucuya "burası modal" denir, klavye
// kullanıcısı ise Tab'la diyaloğun ARKASINDAKİ düğmelere düşer.
//
// Testler BİLEREK ZAYIFLATILMADI: gerçek klavyeyle beklenen davranışı ölçerler
// ve `test.fail()` ile "şu an başarısız olması BEKLENİYOR" diye işaretlenirler.
// Sonuç:
//   - bugün: CI kırmızıya dönmez (düzeltme başka bir ajanın alanında: src/),
//   - yarın: ürün odak yönetimini kazandığı an bu testler GEÇER ve Playwright
//     "Expected to fail, but passed" diyerek KIRMIZI verir; o an yapılacak tek
//     iş `test.fail(...)` satırını silmektir. Yani bulgu kaybolamaz.
//
// `test.fail()` bilinen zayıflığı: test YANLIŞ bir nedenle (ör. kurulum
// bozulması) düşerse yine "beklenen başarısızlık" sayılır. Bu yüzden bölümün
// başındaki KANARYA testi normal bir testtir — diyaloğu açan zincir bozulursa
// kırmızıyı O verir, sessizce yutulmaz.
const FIXME_FOCUS =
  'Ürün henüz modal odak yönetimi uygulamıyor (ExportDialog/ShortcutsHelpOverlay: ' +
  'odak tuzağı, açılışta odak, kapanışta odağı geri verme yok). Düzeltme src/ ' +
  'alanında; bu satır düzeltmeyle birlikte SİLİNMELİDİR.';

test.describe('Erişilebilirlik — modal odak sözleşmesi (aria-modal vaadi)', () => {
  test('KANARYA: export diyaloğu gerçek tıkla açılır ve içinde odaklanabilir iki düğme vardır', async ({
    editor,
  }) => {
    // Aşağıdaki test.fail testlerinin ön koşulu. Bu test kırmızıysa oradaki
    // "beklenen başarısızlıklar" ARTIK KANIT DEĞİLDİR — önce burayı onarın.
    const page = editor.page;
    await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Dışa aktar' })).toBeEnabled();
  });

  test('export diyaloğu AÇILINCA odak diyaloğun içine taşınır', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    expect(
      await focusInside(page, '[role="dialog"]'),
      `Diyalog açıldı ama odak dışarıda kaldı: ${await focusHere(page)}. ` +
        'Klavye kullanıcısı diyaloğa ulaşmak için sayfanın tamamını dolaşmak zorunda.',
    ).toBe(true);
  });

  test('export diyaloğu açıkken Tab odağı DIŞARI çıkaramaz (odak tuzağı)', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // İki yön de sınanır: gerçek bir tuzak Shift+Tab'ı da tutar.
    const forward = await tabsEscaping(page, '[role="dialog"]', 6);
    const backward = await tabsEscaping(page, '[role="dialog"]', 6, true);

    expect(
      [...forward, ...backward],
      'Odak diyaloğun DIŞINA sızdı — aria-modal="true" yazan bir diyalogda ' +
        'Tab arka plandaki kontrollere ulaşmamalı:\n' +
        [...forward, ...backward].join('\n'),
    ).toEqual([]);
  });

  test('export diyaloğu Escape ile kapanır', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    await page.getByRole('button', { name: 'Dışa Aktar', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(
      dialog,
      'Escape diyaloğu kapatmadı: fareye erişemeyen kullanıcı "Vazgeç" düğmesini ' +
        'bulmadan diyalogdan çıkamıyor.',
    ).toHaveCount(0, { timeout: 3_000 });
  });

  test('export diyaloğu kapanınca odak TETİKLEYEN düğmeye döner', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    const trigger = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // ÖN KOŞUL, gevşetme değil: "odak geri döndü" ancak odak önce İÇERİ
    // girdiyse ölçülebilir bir iddiadır. Bu satır olmadan test, odak yönetimi
    // hiç olmayan bir üründe BOŞ YERE yeşil olur (kardeş overlay testinde tam
    // olarak bu ölçüldü).
    expect(
      await focusInside(page, '[role="dialog"]'),
      `Diyalog açıldı ama odak dışarıda kaldı (${await focusHere(page)}) — odak hiç ` +
        'taşınmadığı için "kapanınca geri döner" sözleşmesi ölçülemiyor.',
    ).toBe(true);

    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(dialog).toHaveCount(0);

    expect(
      await focusHere(page),
      'Diyalog kapandıktan sonra odak tetikleyiciye dönmedi: kullanıcı sayfanın ' +
        'başına savruluyor ve kaldığı yeri kaybediyor.',
    ).toContain('Dışa Aktar');
  });

  test('kısayol yardımı AÇILINCA odak overlay\'in içine taşınır', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    await page.getByRole('button', { name: 'Klavye kısayolları (?)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    expect(
      await focusInside(page, '[role="dialog"]'),
      `Kısayol overlay'i açıldı ama odak dışarıda: ${await focusHere(page)}.`,
    ).toBe(true);
  });

  test('kısayol yardımı açıkken Tab odağı DIŞARI çıkaramaz (odak tuzağı)', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    await page.getByRole('button', { name: 'Klavye kısayolları (?)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const escapes = await tabsEscaping(page, '[role="dialog"]', 6);
    expect(
      escapes,
      'Odak kısayol overlay\'inin DIŞINA sızdı:\n' + escapes.join('\n'),
    ).toEqual([]);
  });

  test('kısayol yardımı Escape ile kapanınca odak "?" düğmesine döner', async ({ editor }) => {
    test.fail(true, FIXME_FOCUS);
    const page = editor.page;
    const trigger = page.getByRole('button', { name: 'Klavye kısayolları (?)' });
    await trigger.click();
    const overlay = page.getByRole('dialog');
    await expect(overlay).toBeVisible();

    // ÖN KOŞUL — ÖLÇÜLDÜ: bu satır olmadan test ürün odak yönetimi HİÇ
    // uygulamazken bile GEÇİYORDU. Nedeni basit: overlay tetikleyiciye
    // tıklanarak açılıyor, odak hiç taşınmadığı için kapanışta "hâlâ
    // tetikleyicide" olması bedava sağlanıyordu. Yani "odak geri döndü"
    // iddiası sahte yeşildi — denetimin şikayet ettiği türden bir kanıt.
    expect(
      await focusInside(page, '[role="dialog"]'),
      `Overlay açıldı ama odak dışarıda kaldı (${await focusHere(page)}) — odak hiç ` +
        'taşınmadığı için "kapanınca geri döner" sözleşmesi ölçülemiyor.',
    ).toBe(true);

    // Escape ile kapanma ZATEN ÇALIŞIYOR (dispatcher.ts) — bu testin iddiası
    // kapanma değil, kapandıktan SONRA odağın nereye gittiğidir.
    await page.keyboard.press('Escape');
    await expect(overlay, 'Escape kısayol overlay\'ini kapatmalı.').toHaveCount(0);

    expect(
      await focusHere(page),
      'Overlay kapandıktan sonra odak "?" düğmesine dönmedi.',
    ).toContain('Klavye kısayolları');
  });
});
