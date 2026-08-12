/**
 * Dayanıklılık — WebGL2 OLMAYAN makinede editör açılır mı?
 *
 * Neden bu test var: önizleme motoru WebGL2 zorunlu tutuyor
 * (`player/compositor/compositor.ts` — "WebGL2 is not available" fırlatır) ve
 * bu hata `PlayerPanel`'in mount effect'inden geçiyordu. React'te bir hata
 * sınırı yoksa effect'ten fırlayan hata KÖK AĞACI söker: kullanıcı BEYAZ EKRAN
 * görür. Donanım hızlandırması kapalı bir dizüstünde, uzak masaüstü
 * oturumunda ve kara listedeki GPU'larda editör HİÇ açılmıyordu.
 *
 * Burada kanıtlanan sözleşme:
 *  1. Uygulama açılır (kök ağaç sökülmez, hata sınırı paneli TETİKLENMEZ).
 *  2. Oynatıcı, gerekçeyi gösteren bir panel çizer (sessiz siyah tuval yok).
 *  3. Uygulamanın GERİ KALANI çalışır: timeline GERÇEK fareyle düzenlenir,
 *     inspector seçimi yansıtır, dışa aktarma diyaloğu açılır.
 *
 * KURAL (docs/review-gate.md): etkileşimlerin tamamı `page.mouse` /
 * `page.keyboard` — `dispatchEvent` YASAK. Aşağıdaki tek init script bir
 * ETKİLEŞİM değil, ORTAM simülasyonudur: tarayıcıya WebGL2'siz bir makine
 * kılığı giydirir (Playwright'ın `--disable-gpu` bayrağı Chromium'da SwiftShader
 * yedeğine düştüğü için WebGL2'yi gerçekten kapatmıyor — ölçüldü).
 */
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { SECOND_US } from './fixtures/seed';

/**
 * WebGL2'yi kapatan sayfa-öncesi betik: `getContext('webgl2')` null döner,
 * 2D bağlamı (timeline'ın çizim yolu) dokunulmadan kalır.
 */
function disableWebgl2() {
  const original = HTMLCanvasElement.prototype.getContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = function patched(
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
    return (original as unknown as (t: string, ...r: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

test.describe('WebGL2 yok — editör yine de kullanılabilir', () => {
  test('beyaz ekran YOK: oynatıcı gerekçe gösterir, timeline/inspector/export çalışır', async ({
    page,
    seed,
  }) => {
    await page.addInitScript(disableWebgl2);

    const app = new EditorApp(page);
    await app.open(seed.projectId, { email: seed.email, password: seed.password });

    // --- 1. Kök ağaç ayakta: beyaz ekran yok, hata sınırı tetiklenmedi -----
    // WebGL2 gerçekten kapalı olmalı — yoksa test kendi ön koşulunu doğrulamadan yeşil olurdu.
    expect(
      await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null),
      'Init script WebGL2\'yi kapatamadı — test ön koşulu geçersiz.',
    ).toBe(false);
    expect(
      await page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0),
      'Uygulama kökü BOŞ — React ağacı söküldü (beyaz ekran).',
    ).toBeGreaterThan(0);
    await expect(
      page.getByTestId('app-error-boundary'),
      'Hata sınırı paneli açıldı: WebGL2 hatası tüm uygulamayı düşürüyor (yerel kalmalıydı).',
    ).toHaveCount(0);

    // --- 2. Oynatıcı sessiz kalmıyor: gerekçe + eylem ekranda --------------
    const enginePanel = page.getByTestId('player-engine-error');
    await expect(
      enginePanel,
      'WebGL2 yokken oynatıcı hiçbir şey söylemiyor (sessiz siyah tuval).',
    ).toBeVisible();
    await expect(enginePanel).toContainText(/WebGL2/i);
    await expect(enginePanel).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('player-engine-retry')).toBeVisible();
    // Oynat düğmesi ölü bir düğme olarak durmaz.
    await expect(page.getByRole('button', { name: /^(Oynat|Duraklat)$/ })).toBeDisabled();

    // --- 3. Timeline GERÇEK fareyle düzenlenebilir ------------------------
    const before = await app.state();
    const clip = before.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === seed.clipAId);
    expect(clip, 'Seed klibi timeline durumunda yok.').toBeDefined();
    const startBefore = clip!.timelineStartUs;

    await app.ensureContentVisible(seed.clipAId);
    // Gerçek fare: klibi gövdesinden yakala, 2 sn ileri sürükle, bırak.
    await app.timeline.dragClipByTime(seed.clipAId, 2 * SECOND_US);

    const after = await app.state();
    const moved = after.tracks.flatMap((t) => t.clips).find((c) => c.id === seed.clipAId);
    expect(moved, 'Klip sürükleme sonrası kayboldu.').toBeDefined();
    expect(
      moved!.timelineStartUs,
      'WebGL2 yokken timeline düzenlemesi çalışmıyor — klip hiç kıpırdamadı.',
    ).toBeGreaterThan(startBefore);
    // Seçim de gerçek tıklamayla oluşmuş olmalı (sürükleme klibi seçer).
    expect(after.selection, 'Sürükleme klibi seçmedi.').toContain(seed.clipAId);

    // Cetvelde gerçek tıklama -> playhead taşınır (motor yokken de).
    // Hedef, sığdırma sonrası GÖRÜNÜR aralıkta olmalı: klipler 60–82 sn'de.
    const scrubTargetUs = 70 * SECOND_US;
    await app.timeline.scrubTo(scrubTargetUs);
    const scrubbed = await app.state();
    const tolerance = 4 / scrubbed.pxPerUs; // 4 px'lik tıklama belirsizliği
    expect(
      Math.abs(scrubbed.playheadUs - scrubTargetUs),
      `WebGL2 yokken cetvel tıklaması playhead'i taşımıyor (playhead=${scrubbed.playheadUs}).`,
    ).toBeLessThan(tolerance);

    // --- 4. Inspector seçili klibi gösteriyor -----------------------------
    const scope = page.getByTestId('clip-inspector-scope');
    await expect(scope, 'Seçili klip varken inspector klip panelini çizmiyor.').toBeVisible();
    // Aynı yerde KAPSAM DÜRÜSTLÜĞÜ de doğrulanır (teslim denetimi bulgusu):
    // panel "LUT efekti → M6" diyordu; M6 teslim edildi ve LUT gelmedi. Bir
    // milestone vaadi geçtikten sonra ekranda kalırsa metin yalan söyler.
    await expect(
      scope,
      'Inspector hâlâ LUT için teslim edilmiş bir milestone (M6) vaat ediyor.',
    ).not.toContainText(/LUT[\s\S]{0,60}→\s*M6/);
    await expect(
      scope,
      'LUT\'un MVP kapsamı dışında olduğu ve önizleme shader\'ının bulunmadığı yazmıyor.',
    ).toContainText(/LUT[\s\S]{0,60}MVP KAPSAMI DIŞINDA/);

    // --- 5. Dışa aktarma yolu açık (gerçek tıklama) -----------------------
    const exportButton = page.getByRole('button', { name: 'Dışa Aktar' }).first();
    const box = await exportButton.boundingBox();
    expect(box, 'Dışa Aktar düğmesi görünmüyor.').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(
      page.getByRole('dialog'),
      'WebGL2 yokken dışa aktarma diyaloğu açılmıyor.',
    ).toBeVisible();
  });
});
