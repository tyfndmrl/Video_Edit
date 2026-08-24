/**
 * Ölçek ANİMASYONUNUN tabanı — GERÇEK fare ve klavye ile, GERÇEK worker'la (review-gate §3).
 *
 * ---------------------------------------------------------------------------
 * BU DOSYA NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * `degenerate-layer.spec.ts` ölçeğin STATİK alandan küçültüldüğü yolu kapatıyordu. Sonraki
 * denetim kapının ANİMASYONLU yolda hâlâ açık olduğunu GERÇEK fareyle ölçtü: derleyici
 * yerleşimi (ve dolayısıyla "kutu en az 2 piksel" kuralını) ölçeğin MAKSİMUMUNDAN kuruyor,
 * dejenerelik kuralını ise MİNİMUMUNDAN soruyordu — yani animasyonun TABANI hiçbir kapıya
 * görünmüyordu. Ölçülen iki varyant:
 *
 *   1) kutu n×1  — metin bbox'ı 223×104, taban 0.010 → kutu 2×1. POST /exports **202**,
 *      iş kuyruğa girdi ve worker'da `unsupported-feature:degenerate-layer` ile düştü.
 *   2) kutu 0×0  — içerik ".", punto 8 (bbox 6×20), taban 0.010 → kutu 0×0. POST **202**,
 *      filtergraph'a ALT-PİKSEL ölçek hedefi yazıldı (`scale=w='...*0.06'`) ve ffmpeg
 *      **99 kare yazdıktan SONRA** `Picture size 0x4 is invalid` ile öldü (exit -12).
 *
 * Kapanma kriteri "kart Başarısız göstermedi" DEĞİLDİR — o kriter işin kuyruğa girdiğini
 * kabul ederdi. Kriter: **POST'un KENDİSİ 422 döner** ve "Dışa Aktarmalar"da HİÇ satır
 * oluşmaz. Üstüne iki kontrol daha koşuyor:
 *   - SINIRIN ALTI: mesajın önerdiği sayının BİR IZGARA ADIMI altı hâlâ reddedilir
 *     (kapı "eşiğin altını" kesiyor, "küçük olan her şeyi" değil);
 *   - SINIRIN ÜSTÜ: önerilen sayının kendisi 202 alır ve iş GERÇEKTEN render edilir
 *     ("Tamamlandı"). Yalnız reddi göstermek, her şeyi reddeden bir kapıyla da yeşil kalırdı.
 *
 * Beklenen sayı HİÇBİR YERDE sabitlenmez: eşik metnin ÖLÇÜLEN kutusundan doğar ve o ölçüm
 * sunucunun fontuna bağlıdır. Test eşiği 422 mesajından OKUR ve iki yanını dener — böylece
 * "mesajın söylediği sayı" ile "kapının gerçekten kabul ettiği sayı" aynı olmak ZORUNDA kalır.
 *
 * `dispatchEvent`, sentetik PointerEvent ve doğrudan store çağrısı YOKTUR. Store yalnız
 * DOĞRULAMA için okunur (keyframe listesi ve transform canvas'ta okunamaz).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { EditorApp } from './support/editor';
import { createEmptyProject } from './support/projects';

/** Editörün ölçek ızgarası (TRANSFORM_SCALE_DECIMALS = 3) ve alanın tabanı. */
const SCALE_STEP = 0.001;
const SCALE_MIN = 0.01;

interface ClipProbe {
  id: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  transform: { scale: number };
  keyframes: Record<string, { timeUs: number; value: number }[] | undefined>;
}

async function readClip(page: Page, clipId: string): Promise<ClipProbe> {
  const clip = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: { tracks: { clips: { id: string }[] }[] } } } } };
    }).__ve;
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      const found = track.clips.find((c) => c.id === id);
      if (found) return JSON.parse(JSON.stringify(found)) as unknown;
    }
    return null;
  }, clipId);
  expect(clip, `Klip dokümanda yok: ${clipId}`).not.toBeNull();
  return clip as ClipProbe;
}

/** Gerçek fare tıklaması (panel kaydırılabilir: önce görünür alana getir). */
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

/** Alanı GERÇEK fareyle odakla, GERÇEK klavyeyle yaz. */
async function typeInto(page: Page, testId: string, value: string, enter = true): Promise<void> {
  await clickReal(page, testId);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
  if (enter) await page.keyboard.press('Enter');
  await page.waitForTimeout(180);
}

interface ExportAttempt {
  status: number;
  feature?: string;
  detail?: string;
}

/**
 * TopBar → diyalog → "Dışa aktar" (hepsi gerçek tıklama). POST'un KENDİSİNİ döndürür:
 * "kart hata göstermedi" değil, sunucunun isteğe verdiği yanıt ölçülüyor.
 */
async function attemptExport(page: Page): Promise<ExportAttempt> {
  const posted = page.waitForResponse(
    (r) => r.url().includes('/exports') && r.request().method() === 'POST',
    { timeout: 90_000 },
  );
  const open = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Dışa aktar' }).click();

  const response = await posted;
  if (response.status() === 202) return { status: 202 };
  const problem = (await response.json()) as { detail?: string; feature?: string };
  return { status: response.status(), feature: problem.feature, detail: problem.detail ?? '' };
}

/** Reddedilen denemeden sonra diyalogu GERÇEK fareyle kapatır. */
async function dismissDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(dialog).toBeHidden();
}

/** Mesajın önerdiği ölçek ("… ölçeğini en az 0.015 yapın"). */
function suggestedScale(detail: string): number {
  const match = /en az ([0-9]+(?:\.[0-9]+)?) yapın/.exec(detail);
  expect(
    match,
    `422 mesajı EYLEM taşımalı ("ölçeğini en az N yapın"); gelen: ${detail}`,
  ).not.toBeNull();
  return Number(match![1]);
}

/**
 * İki varyant, TEK jest dizisi. Fark yalnız metnin kutusudur: varsayılan içerik kutuyu
 * n×1'e, tek noktalık 8 punto içerik ise 0×0'a indirir — ölçülen iki arıza tam olarak bu.
 */
const VARIANTS = [
  {
    name: 'kutu n×1 (worker\'da degenerate-layer ile ölüyordu)',
    content: null as string | null,
    fontSizePx: null as string | null,
  },
  {
    name: 'kutu 0×0 (ffmpeg render ORTASINDA "Picture size 0x4" ile ölüyordu)',
    content: '.',
    fontSizePx: '8',
  },
];

test.describe('Ölçek animasyonunun tabanı: metin katmanı kuyruğa GİRMEDEN reddedilir', () => {
  for (const variant of VARIANTS) {
    test(`metin + ölçek keyframe'i → taban ${SCALE_MIN}: POST 422, iş satırı YOK — ${variant.name}`,
      async ({ page, account }) => {
        // Kuyruk + gerçek ffmpeg render (pozitif kontrol) uzun sürebilir.
        test.setTimeout(480_000);

        // Metin klibi ASSET İSTEMEZ: proje yalnız bu katmanı taşır, dolayısıyla pozitif
        // kontroldeki "Tamamlandı" gerçekten BU belgenin render edildiğini söyler.
        const project = await createEmptyProject(
          account.context.request,
          account.accessToken,
          'E2E dejenere animasyon',
        );

        const app = new EditorApp(page);
        await app.open(project.projectId, { email: account.email, password: account.password });

        // ---- 1) Metin ekle (GERÇEK fare, TopBar düğmesi) ----
        await clickReal(page, 'add-text-clip');
        const added = await app.state();
        const overlay = added.tracks.find((t) => t.type === 'overlay');
        expect(overlay, '"Metin ekle" bir overlay track açmalı.').toBeDefined();
        expect(overlay!.clips[0].kind).toBe('text');
        const clipId = overlay!.clips[0].id;
        await expect(page.getByTestId('clip-inspector-visual')).toBeVisible();

        // ---- 2) Varyanta göre metnin KUTUSUNU küçült (gerçek klavye) ----
        if (variant.content !== null) {
          await typeInto(page, 'clip-text-content', variant.content, false);
        }
        if (variant.fontSizePx !== null) {
          await typeInto(page, 'clip-text-size', variant.fontSizePx);
        }

        // ---- 3) Ölçek kanalını animasyonlu yap (GERÇEK fare, elmas düğmesi) ----
        const diamond = page.getByTestId('clip-kf-scale');
        await expect(diamond, 'Ölçeğin yanında keyframe düğmesi olmalı.').toBeEnabled();
        await clickReal(page, 'clip-kf-scale');
        await expect(diamond).toHaveAttribute('data-animated', 'true');
        expect(
          (await readClip(page, clipId)).keyframes.scale,
          'Elmas düğmesi playhead\'e TEK keyframe yazmalı.',
        ).toHaveLength(1);

        // ---- 4) Playhead klibin SON karesine, ölçek tabanı GERÇEK klavyeyle ----
        const clip = await readClip(page, clipId);
        const frameUs = Math.round(1_000_000 / 30);
        const endUs = clip.timelineStartUs + clip.timelineDurationUs - frameUs;
        await app.timeline.scrubTo(endUs);
        await typeInto(page, 'clip-scale', String(SCALE_MIN));

        const animated = await readClip(page, clipId);
        const keys = animated.keyframes.scale ?? [];
        expect(keys, 'Yeni bir anda değer değiştirmek İKİNCİ keyframe\'i açmalı.').toHaveLength(2);
        expect(keys[1].value, 'Taban dokümana AYNEN geçmeliydi.').toBe(SCALE_MIN);
        expect(
          animated.transform.scale,
          'STATİK ölçek 1 kalmalı — kapının tam olarak GÖRMEDİĞİ durum buydu: tavan 1\'i '
            + 'görüyor, taban ise keyframe\'de saklı.',
        ).toBe(1);

        // ---- 5) GERÇEK dışa aktarma: POST'un KENDİSİ 422 ----
        const rejected = await attemptExport(page);
        expect(
          rejected.status,
          'KAPANMA KRİTERİ: iş kuyruğa HİÇ girmemeli. 202 dönerse belge kuyruğa girmiş ve '
            + 'kural yine worker\'a (ya da ffmpeg\'e) kalmış demektir — ölçülen eski davranış buydu.',
        ).toBe(422);
        expect(rejected.feature, 'Makine-okur hata kodu.').toBe('degenerate-layer');
        expect(
          rejected.detail ?? '',
          'Mesaj kullanıcıyı KEYFRAME\'e yönlendirmeli: statik alan 1.0 iken "ölçeğiniz çok '
            + 'küçük" demek panelde karşılığı olmayan bir cümledir.',
        ).toContain('en küçük keyframe değeri');

        // Diyalog AÇIK kalır ve gerekçeyi ekranda gösterir (sessiz başarısızlık yok).
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('alert'),
          'Kullanıcı 422\'nin gerekçesini ekranda görmeli.',
        ).toContainText('en az');

        // Ve HİÇ iş kartı oluşmamalı — "kuyruğa girmedi"nin görünür kanıtı.
        const exportsSection = page
          .locator('section')
          .filter({ has: page.getByRole('heading', { name: 'Dışa Aktarmalar' }) })
          .first();
        await expect(
          exportsSection.locator('li'),
          'Reddedilen belge için iş satırı oluşmamalı.',
        ).toHaveCount(0);

        const suggestion = suggestedScale(rejected.detail ?? '');
        await dismissDialog(page);

        // ---- 6) SINIRIN ALTI: önerinin bir ızgara adımı altı HÂLÂ reddedilir ----
        // Kapı "eşiğin altını" kesmeli, "küçük olan her şeyi" değil; aksi halde 5. adımdaki
        // yeşil, her belgeyi reddeden bir kapıyla da alınabilirdi.
        const below = Number((suggestion - SCALE_STEP).toFixed(3));
        if (below >= SCALE_MIN) {
          await app.timeline.click(await app.timeline.clipCenter(clipId, await app.state()));
          await app.timeline.scrubTo(endUs);
          await typeInto(page, 'clip-scale', below.toFixed(3));
          expect((await readClip(page, clipId)).keyframes.scale?.[1].value).toBe(below);

          const stillRejected = await attemptExport(page);
          expect(
            stillRejected.status,
            `Önerilen ${suggestion} değerinin bir ızgara adımı altı (${below}) hâlâ dejenere; `
              + 'kabul edilseydi mesajın önerdiği sayı gereğinden BÜYÜK olurdu.',
          ).toBe(422);
          expect(stillRejected.feature).toBe('degenerate-layer');
          await dismissDialog(page);
        }

        // ---- 7) SINIRIN ÜSTÜ: önerilen sayı kabul edilir ve GERÇEKTEN render edilir ----
        await app.timeline.click(await app.timeline.clipCenter(clipId, await app.state()));
        await app.timeline.scrubTo(endUs);
        await typeInto(page, 'clip-scale', suggestion.toFixed(3));
        expect(
          (await readClip(page, clipId)).keyframes.scale?.[1].value,
          'Önerilen ölçek dokümana AYNEN geçmeli — iddianın taşıyıcısı bu değerdir.',
        ).toBe(suggestion);

        const accepted = await attemptExport(page);
        expect(
          accepted.status,
          `Mesajın önerdiği ${suggestion} kabul edilmeli — aksi halde önerilen sayı YALAN olurdu.`,
        ).toBe(202);
        await expect(dialog, 'Başarılı başlatmada diyalog kapanır.').toBeHidden({ timeout: 30_000 });

        // 202 YETMEZ: eski davranışta da 202 dönüyordu. Kapanma kriteri işin DURUMUDUR.
        const jobRow = exportsSection.locator('li').first();
        await expect(jobRow).toBeVisible({ timeout: 20_000 });
        await expect(
          jobRow.getByText('Tamamlandı', { exact: true }),
          `Ölçek animasyonunun tabanı ${suggestion} → bu belge derleme kapısını geçmeli ve `
            + 'GERÇEKTEN render edilmelidir (worker + ffmpeg ayakta mı?).',
        ).toBeVisible({ timeout: 300_000 });
        await expect(
          jobRow.locator('p.text-danger'),
          'Başarısız bir iş sessizce geçmemeli.',
        ).toHaveCount(0);
      });
  }
});
