/**
 * Proje seçici — kullanıcının editöre girdiği kapı.
 *
 * Kapsanan sözleşme: seçici <-> editör geçişi activeProjectId ile YAPILIR ve
 * adres çubuğundaki `?project=` derin bağlantısı her iki yönde senkron kalır
 * (features/projects/projectPickerLogic). Bağlantı paylaşılabilir olduğu için
 * GEÇERSİZ bir id ile açılma da gerçek bir kullanıcı yolu: o durumda ekran
 * sessizce boş kalmamalı, hata + "Tekrar dene" göstermeli.
 *
 * Etkileşimler gerçek fare/klavyedir; doğrulama URL + DOM üzerinden yapılır.
 */
import { test, expect } from './fixtures/test';
import { createProject } from './fixtures/seed';
import { createEmptyProject } from './support/projects';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.describe('Proje seçici', () => {
  test('yeni proje oluşturmak editörü açar ve ?project= adres çubuğuna yazılır', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projeler', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const name = `E2E seçici ${Date.now().toString(36)}`;
    await page.getByTestId('project-name-input').click();
    await page.keyboard.type(name);
    await page.getByTestId('project-create-button').click();

    // Editör grid'i (canvas timeline) açılır ve derin bağlantı yazılır.
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('project') ?? '', {
        timeout: 10_000,
        message: 'Proje açıldı ama ?project= adres çubuğuna yazılmadı (bağlantı paylaşılamaz).',
      })
      .toMatch(UUID_RE);
    // Üst çubuk projenin ADINI gösterir (doğru proje açıldı).
    await expect(page.getByTitle(name)).toBeVisible();
  });

  test('boş ad reddedilir ve proje OLUŞTURULMAZ', async ({ page }) => {
    await page.goto('/');
    const createButton = page.getByTestId('project-create-button');
    await expect(createButton).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('project-name-input').click();
    await page.keyboard.type('   ');
    await createButton.click();

    await expect(page.getByText('Proje adı boş olamaz.')).toBeVisible();
    // Hâlâ seçicideyiz: canvas yok, ?project= yazılmadı.
    await expect(page.locator('canvas')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  });

  test('liste mevcut projeyi gösterir; satıra tıklamak onu açar', async ({ page, account }) => {
    const name = `E2E liste ${Date.now().toString(36)}`;
    const created = await createProject(account.context.request, account.accessToken, name);

    await page.goto('/');
    const row = page.getByTestId(`project-row-${created.id}`);
    await expect(row, 'Yeni proje seçici listesinde görünmüyor.').toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(name);
    await expect(row).toContainText('Son değişiklik:');

    await row.click();
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('project')).toBe(created.id);
  });

  test('TopBar "Projeler" seçiciye döner ve ?project= temizlenir', async ({ page, account }) => {
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E dönüş',
    );
    await page.goto(`/?project=${project.projectId}`);
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30_000 });

    await page.getByRole('button', { name: 'Projeler', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Projeler', exact: true })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    expect(
      new URL(page.url()).searchParams.get('project'),
      'Seçiciye dönüldü ama ?project= adres çubuğunda kaldı.',
    ).toBeNull();
  });

  test('geçersiz ?project= id: hata görünür ve "Tekrar dene" isteği GERÇEKTEN yeniler', async ({
    page,
  }) => {
    // Biçimi geçerli ama sahibi olmayan bir id -> 404.
    const ghostId = crypto.randomUUID();
    await page.goto(`/?project=${ghostId}`);

    await expect(page.getByText('Proje yüklenemedi.')).toBeVisible({ timeout: 20_000 });
    const retry = page.getByRole('button', { name: 'Tekrar dene' }).first();
    await expect(retry).toBeVisible();
    // Timeline da durumu söyler (kullanıcı canvas'a bakıyorsa da görür).
    await expect(page.getByText('Proje yüklenemedi', { exact: true })).toBeVisible();

    // "Tekrar dene" gerçekten yeni bir istek atmalı — dekoratif bir düğme değil.
    //
    // Eşleşme TAM YOL üzerinden: `includes('/api/projects/<id>')` demek,
    // aynı projenin `/assets` ve `/media-urls` uçlarını da yakalamak demekti
    // (react-query o sorguları KENDİ BAŞINA yeniden dener) — negatif kontrol
    // bunu yakaladı: tıklamadan da "istek geldi" diyen sahte bir yeşil.
    const isProjectDetailGet = (r: { url(): string; request(): { method(): string } }): boolean =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/projects/${ghostId}`;
    const retried = page.waitForResponse(isProjectDetailGet, { timeout: 15_000 });
    await retry.click();
    const response = await retried;
    expect(response.status()).toBe(404);
    // Proje hâlâ yok: hata ekranda kalır (yanlış bir "başarılı" hali yok).
    await expect(page.getByText('Proje yüklenemedi.')).toBeVisible();
  });
});
