/**
 * Kimlik doğrulama akışı — GERÇEK klavye/fare ile kayıt, giriş, çıkış ve
 * yenilemede oturumun korunması.
 *
 * Neden ayrı bir dosya ve neden SERİ: diğer tüm spec'ler worker-scope bir
 * oturumu paylaşır (fixtures/test.ts) ve giriş formunu hiç görmez. Ürünün ilk
 * ekranı ise burasıdır ve bugüne kadar tek bir gerçek tuş vuruşuyla
 * denenmemişti.
 *
 * RATE LIMIT (bağlayıcı kısıt): backend'de login/register IP başına dakikada
 * 10 istekle sınırlı (Program.cs "auth" policy). Bu yüzden testler tek bir
 * tarayıcı context'ini SIRAYLA paylaşır ve dosya toplamda 5 kayıt/giriş
 * isteği yapar; her testin kendi hesabını açması 429 üretirdi. Kota AYNI
 * MAKİNEDEKİ her şeyle paylaşıldığı için (bkz. submitAuthForm) 429 görüldüğünde
 * pencere beklenir ve istek yinelenir — ölçülmüş bir çakışma, varsayım değil.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_VIEWPORT } from './support/constants';

test.describe.configure({ mode: 'serial' });

test.describe('Kimlik doğrulama — gerçek girdi', () => {
  let context: BrowserContext;
  let page: Page;

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-auth-${stamp}@videoedit.test`;
  const password = 'e2epass1234';

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ baseURL: E2E_BASE_URL, viewport: E2E_VIEWPORT });
    page = await context.newPage();
  });

  // 429 yenileme dalı devreye girerse (aşağıdaki submitAuthForm) bir pencere
  // boyunca beklenir — varsayılan 60 sn'lik test süresi buna yetmez.
  test.beforeEach(() => {
    test.setTimeout(200_000);
  });

  test.afterAll(async () => {
    await context.close();
  });

  /** Alanı gerçek fareyle odakla, içeriğini temizle, gerçek klavyeyle yaz. */
  async function typeInto(testId: string, value: string): Promise<void> {
    await page.getByTestId(testId).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type(value);
  }

  const loginForm = () => page.getByTestId('auth-submit');
  const projectsHeading = () => page.getByRole('heading', { name: 'Projeler', exact: true });
  const formError = () => page.locator('form p.text-red-400');

  /** Sabit pencere 1 dk (Program.cs "auth" policy) — sıfırlanması beklenir. */
  const RATE_LIMIT_WINDOW_MS = 62_000;

  /**
   * Formu gönder ve YERLEŞMESİNİ bekle; 429 görürsen pencere sıfırlanınca
   * TEKRAR dene.
   *
   * Neden: auth kotası IP başınadır ve bu makinedeki HER şeyle paylaşılır
   * (paralel çalışan başka bir suite, geliştiricinin tarayıcısı, ikinci bir
   * ajan...). Ölçüldü: eşzamanlı bir başka koşum kotayı tüketince bu dosya
   * "Giriş başarısız (HTTP 429)" ile kırmızıya döndü — bu bir ÜRÜN hatası
   * değil, paylaşılan kaynak çakışmasıdır. 429'u yutmuyoruz: pencerenin
   * geçmesini bekleyip gerçek yanıtı almaya devam ediyoruz, beklenen mesaj
   * yine aynen iddia ediliyor.
   */
  async function submitAuthForm(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await loginForm().click();
      const deadline = Date.now() + 15_000;
      for (;;) {
        if ((await projectsHeading().count()) > 0) return; // içeri alındı
        if ((await formError().count()) > 0) {
          const text = (await formError().innerText()).trim();
          if (!/429|too many/i.test(text)) return; // gerçek (ürün) mesajı
          break; // kota doldu -> pencereyi bekle, yeniden dene
        }
        if (Date.now() > deadline) return; // yerleşmedi; iddialar konuşsun
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(RATE_LIMIT_WINDOW_MS);
    }
  }

  test('kayıt: ZAYIF şifre sunucunun kuralını gösterir (sessizce yutulmaz)', async () => {
    await page.goto('/');
    await expect(loginForm()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Hesabın yok mu? Kayıt ol' }).click();
    await expect(page.getByTestId('auth-displayname')).toBeVisible();

    await typeInto('auth-displayname', 'E2E Kullanıcı');
    await typeInto('auth-email', email);
    await typeInto('auth-password', '123');
    await submitAuthForm();

    // Sunucunun ProblemDetails/Identity mesajı ekrana DÜŞMELİ — jenerik
    // "başarısız" değil, şifrenin NEDEN reddedildiği.
    await expect(formError()).toBeVisible({ timeout: 15_000 });
    const message = (await formError().innerText()).trim();
    expect(message, `Sunucu mesajı: "${message}"`).toMatch(/8|char|karakter|password|şifre/i);
    // Ve kullanıcı hâlâ formda (sessizce içeri alınmadı).
    await expect(page.getByTestId('auth-password')).toBeVisible();
  });

  test('kayıt: geçerli bilgilerle hesap açılır ve proje seçici görünür', async () => {
    await typeInto('auth-password', password);
    await submitAuthForm();

    await expect(projectsHeading()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('auth-submit')).toHaveCount(0);
  });

  test('sayfa yenilendiğinde oturum KORUNUR (httpOnly refresh cookie)', async () => {
    await page.reload();
    await expect(projectsHeading()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('auth-submit')).toHaveCount(0);
  });

  test('çıkış yapınca oturum kapanır ve giriş formu döner', async () => {
    // "Çıkış yap" sunucudaki refresh token'ları iptal eder ve sayfayı
    // yeniler; yenilemeden sonra cookie denemesi 401 almalı.
    await page.getByRole('button', { name: 'Çıkış yap' }).click();
    await expect(loginForm()).toBeVisible({ timeout: 20_000 });
    await expect(projectsHeading()).toHaveCount(0);

    // Sadece "form göründü" yetmez: yenileme de içeri almamalı.
    await page.reload();
    await expect(loginForm()).toBeVisible({ timeout: 20_000 });
  });

  test('giriş: yanlış şifre net mesaj verir, doğrusu içeri alır', async () => {
    await typeInto('auth-email', email);
    await typeInto('auth-password', `${password}-yanlis`);
    await submitAuthForm();

    await expect(formError()).toBeVisible({ timeout: 15_000 });
    await expect(formError()).toHaveText('E-posta veya şifre hatalı.');

    await typeInto('auth-password', password);
    await submitAuthForm();
    await expect(projectsHeading()).toBeVisible({ timeout: 20_000 });
  });
});
