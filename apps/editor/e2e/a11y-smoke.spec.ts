/**
 * Erişilebilirlik dumanı — klavyeyle dolaşım ve rol/aria sözleşmesi.
 *
 * Kapsam dürüstlüğü: bu bir WCAG denetimi DEĞİL. Burada doğrulanan üç şey var
 * ve üçü de gerçek girdiyle ölçülür:
 *  1. Ana kontrollere fare olmadan (yalnız Tab ile) ULAŞILABİLİYOR mu,
 *  2. Menü/diyalog/durum bölgeleri doğru ROL'ü taşıyor mu (ekran okuyucunun
 *     "menü açıldı", "iletişim kutusu", "durum" diyebilmesi bunlara bağlı),
 *  3. Menü ve diyalog klavyeyle GEZİLİP kapatılabiliyor mu (fare tuzağı yok).
 * Kontrast, odak halkası görünürlüğü ve canvas timeline'ın klavyeyle
 * düzenlenmesi kapsam DIŞI (docs/backlog.md).
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
