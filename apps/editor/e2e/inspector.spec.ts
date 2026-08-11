/**
 * Inspector — seçili klip özellikleri, GERÇEK fare ile.
 *
 * Neden bu test var: panelin "çalıştığı" ancak gerçek girdiyle doğrulanmışsa
 * söylenebilir. Buradaki her etkileşim `page.mouse.*` / `page.keyboard.*`
 * üzerinden gider; `dispatchEvent` veya `locator.fill()` gibi sentetik yollar
 * KULLANILMAZ — slider'ın pointer olayı (transaction açan yol), sayı alanının
 * sürükleme bölgesi ve sağ tık menüsü tam olarak orada kırılırdı.
 *
 * Doğrulama store'dan okunur (canvas'ta ve panelde okunabilir tek kaynak o):
 * değer gerçekten dokümana yazıldı mı, kaç geçmiş girdisi oluştu, Ctrl+Z
 * gerçekten geri aldı mı.
 */
import type { Page } from '@playwright/test';
import { maxScaleFor, validateTimelineDoc } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';

/** Seed projesinin çıktı çözünürlüğü (fixtures/seed.ts). */
const SEED_SETTINGS = { width: 1920, height: 1080 };

interface ClipProbe {
  audio: { volume: number; fadeInUs: number; fadeOutUs: number; muted: boolean } | null;
  transform: { x: number; y: number; scale: number; rotationDeg: number };
  opacity: number;
  kind: string;
  timelineStartUs: number;
  timelineDurationUs: number;
  assetId?: string;
  sourceInUs?: number;
  sourceOutUs?: number;
}

interface TrackProbe {
  id: string;
  type: string;
  clipIds: string[];
}

/** Bir klibin doküman durumu (appBridge'in okumadığı ses/transform alanları). */
async function readClip(page: Page, clipId: string): Promise<ClipProbe> {
  const probe = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: { tracks: { clips: Record<string, unknown>[] }[] } } } } };
    }).__ve;
    const doc = bridge.doc.useDocStore.getState().doc;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === id) return JSON.parse(JSON.stringify(clip)) as unknown;
      }
    }
    return null;
  }, clipId);
  expect(probe, `Klip dokümanda bulunamadı: ${clipId}`).not.toBeNull();
  return probe as ClipProbe;
}

/**
 * Dokümanın TAMAMI. Editörün ürettiği belgeyi PAYLAŞILAN sözleşmeyle
 * (validateTimelineDoc) doğrulamak için: export compiler aynı kuralları
 * uygular, yani burada geçen bir doküman 422 yemez.
 */
async function readDoc(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { doc: unknown } } } };
    }).__ve;
    return JSON.parse(JSON.stringify(bridge.doc.useDocStore.getState().doc)) as unknown;
  });
}

function expectDocValid(doc: unknown, context: string): void {
  const result = validateTimelineDoc(doc);
  const issues = result.success
    ? ''
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  expect(result.success, `${context} — sözleşme ihlali:\n${issues}`).toBe(true);
}

async function readTracks(page: Page): Promise<TrackProbe[]> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): { doc: { tracks: { id: string; type: string; clips: { id: string }[] }[] } };
          };
        };
      };
    }).__ve;
    return bridge.doc.useDocStore.getState().doc.tracks.map((t) => ({
      id: t.id,
      type: t.type,
      clipIds: t.clips.map((c) => c.id),
    }));
  });
}

/**
 * Klavye kısayolları (Ctrl+Z dahil) bir input odaktayken BİLEREK devre dışıdır
 * (shortcuts/dispatcher.isEditableTarget). Slider sürükledikten sonra odak hâlâ
 * slider'dadır; kullanıcı da gerçekte önce başka bir yere tıklar. Panelin
 * etkileşimsiz başlık alanına gerçek tıklama tam olarak bunu yapar.
 */
async function blurPanel(page: Page): Promise<void> {
  const identity = page.getByTestId('clip-inspector-identity');
  const box = await identity.boundingBox();
  expect(box, 'Inspector kimlik bölümü görünmüyor.').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 6);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ''))
    .not.toBe('INPUT');
}

/** Gerçek fareyle bir öğe üzerinde yatay sürükleme (kademeli hareket). */
async function dragHorizontally(
  page: Page,
  from: { x: number; y: number },
  toX: number,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(toX - from.x || 1) * 4, from.y, { steps: 2 });
  await page.mouse.move(toX, from.y, { steps: 12 });
  await page.mouse.move(toX, from.y);
  await page.mouse.up();
  await page.waitForTimeout(120);
}

test.describe('Inspector — seçili klip özellikleri', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('klibe tıklayınca panel klip özelliklerini gösterir', async ({ editor, seed }) => {
    await expect(
      editor.page.getByTestId('clip-inspector-empty'),
      'Seçim yokken panel boş durum metnini göstermeli.',
    ).toBeVisible();

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    expect((await editor.state()).selection, 'Klibe tıklamak onu seçmeli.').toEqual([seed.clipAId]);

    await expect(editor.page.getByTestId('clip-inspector-identity')).toBeVisible();
    await expect(editor.page.getByTestId('clip-inspector-audio')).toBeVisible();
    await expect(editor.page.getByTestId('clip-inspector-visual')).toBeVisible();
    // Klip 60 sn'de başlıyor, 6 sn sürüyor (seed) — timecode gerçekten türetiliyor mu?
    await expect(editor.page.getByTestId('clip-inspector-identity')).toContainText('00:01:00:00');
    await expect(editor.page.getByTestId('clip-inspector-identity')).toContainText('00:00:06:00');

    // Kapsam dürüstlüğü (review-gate kural 4): panelin KAPSAMADIĞI alanlar
    // sessizce eksik bırakılmaz, ekranda hedef milestone'uyla yazar.
    const scope = editor.page.getByTestId('clip-inspector-scope');
    await expect(scope).toBeVisible();
    await expect(scope).toContainText(/anchor/i);
    await expect(scope).toContainText(/M5/);
  });

  test('ses seviyesi gerçek fareyle değişir, tek geçmiş girdisi bırakır ve Ctrl+Z geri alır', async ({
    editor,
    seed,
  }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    expect((await readClip(editor.page, seed.clipAId)).audio?.volume).toBe(1);

    const before = await editor.state();
    const slider = editor.page.getByTestId('clip-volume');
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box, 'Ses seviyesi slider\'ı görünmüyor.').not.toBeNull();

    // Thumb'ı (0..2 aralığında 1 = orta) sola sürükle -> yaklaşık 0.5.
    const y = box!.y + box!.height / 2;
    await dragHorizontally(
      editor.page,
      { x: box!.x + box!.width / 2, y },
      box!.x + box!.width * 0.25,
    );

    const after = await readClip(editor.page, seed.clipAId);
    expect(after.audio, 'Klibin ses ayarları kaybolmamalı.').not.toBeNull();
    expect(
      after.audio!.volume,
      'Slider\'ı sola sürüklemek ses seviyesini düşürmeli (gerçek fare).',
    ).toBeLessThan(1);
    expect(after.audio!.volume).toBeGreaterThanOrEqual(0);

    const afterState = await editor.state();
    expect(
      afterState.historyLabels.length,
      'Sürükleme boyunca üretilen onlarca değişiklik TEK geçmiş girdisine katlanmalı.',
    ).toBe(before.historyLabels.length + 1);
    expect(afterState.historyLabels.at(-1)).toMatch(/ses seviyesi/i);

    // Panelde dB etiketi de güncellenmeli (lineer gain -> dB, §8.1).
    await expect(editor.page.getByTestId('clip-inspector-audio')).toContainText('dB');

    await blurPanel(editor.page);
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(120);

    expect(
      (await readClip(editor.page, seed.clipAId)).audio?.volume,
      'Ctrl+Z ses seviyesini eski değerine döndürmeli.',
    ).toBe(1);
  });

  test('"Sessize al" düğmesi gerçek tıklamayla klibi susturur', async ({ editor, seed }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    const toggle = editor.page.getByTestId('clip-muted');
    await expect(toggle).toBeVisible();

    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    await editor.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await editor.page.mouse.down();
    await editor.page.mouse.up();
    await editor.page.waitForTimeout(120);

    expect((await readClip(editor.page, seed.clipAId)).audio?.muted).toBe(true);
    expect((await editor.state()).historyLabels.at(-1)).toMatch(/sessize/i);
  });

  test('Konum X etiketini sürüklemek transform\'u tek geçmiş girdisiyle değiştirir', async ({
    editor,
    seed,
  }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    expect((await readClip(editor.page, seed.clipAId)).transform.x).toBe(0);

    const before = await editor.state();
    const scrub = editor.page.getByTestId('clip-x-scrub');
    await expect(scrub).toBeVisible();
    const box = await scrub.boundingBox();
    expect(box, 'Konum X sürükleme alanı görünmüyor.').not.toBeNull();

    const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    await dragHorizontally(editor.page, start, start.x + 60);

    const after = await readClip(editor.page, seed.clipAId);
    expect(
      after.transform.x,
      'Etiketi sağa sürüklemek normalize X konumunu artırmalı (§2).',
    ).toBeGreaterThan(0);
    const afterState = await editor.state();
    expect(afterState.historyLabels.length).toBe(before.historyLabels.length + 1);
    expect(afterState.historyLabels.at(-1)).toMatch(/konum/i);

    // "Sıfırla" gerçek tıklamayla varsayılanlara döner.
    const reset = editor.page.getByTestId('clip-transform-reset');
    const resetBox = await reset.boundingBox();
    expect(resetBox).not.toBeNull();
    await editor.page.mouse.move(
      resetBox!.x + resetBox!.width / 2,
      resetBox!.y + resetBox!.height / 2,
    );
    await editor.page.mouse.down();
    await editor.page.mouse.up();
    await editor.page.waitForTimeout(120);

    expect((await readClip(editor.page, seed.clipAId)).transform.x).toBe(0);
    expect((await editor.state()).historyLabels.at(-1)).toMatch(/sıfırlandı/i);
  });

  /**
   * Ölçek alanının tavanı SABİT DEĞİL: export compiler tek katmanı 8192 piksele
   * sınırlıyor (LayerGeometry.MaxLayerDimension), yani 1080p'de ~4.266.
   * Panelde 10 yazıp compiler'ın reddettiği bir doküman üretmek mümkündü.
   * Burada gerçek klavyeyle 50 yazılır ve dokümana projeye özgü tavanın
   * yazıldığı doğrulanır.
   */
  test('Ölçek alanı proje çözünürlüğünden türeyen tavana kırpar (gerçek klavye)', async ({
    editor,
    seed,
  }) => {
    const expectedMax = maxScaleFor(SEED_SETTINGS);
    expect(expectedMax, '1080p tavanı 8192/1920 = 4.266 olmalı.').toBe(4.266);

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    const field = editor.page.getByTestId('clip-scale');
    await expect(field).toBeVisible();
    // Alanın kendi sözleşmesi de DOM'da görünür olmalı (kullanıcı stepper ile
    // de tavana çarpar).
    await expect(field).toHaveAttribute('max', String(expectedMax));
    await expect(editor.page.getByTestId('clip-scale-limit-note')).toContainText('4.266');

    const box = await field.boundingBox();
    expect(box, 'Ölçek alanı görünmüyor.').not.toBeNull();
    await editor.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await editor.page.mouse.down();
    await editor.page.mouse.up();
    await editor.page.keyboard.press('Control+a');
    await editor.page.keyboard.type('50');
    await editor.page.keyboard.press('Enter');
    await editor.page.waitForTimeout(150);

    expect(
      (await readClip(editor.page, seed.clipAId)).transform.scale,
      '50 yazmak dokümana projenin tavanını yazmalı, 50 veya 10 değil.',
    ).toBe(expectedMax);
    // Compiler'ın ölçtüğü katman kutusu: roundHalfUp(1920 * scale) <= 8192.
    expect(Math.floor(SEED_SETTINGS.width * expectedMax + 0.5)).toBeLessThanOrEqual(8192);
    expectDocValid(await readDoc(editor.page), 'ölçek tavanına kırpma sonrası');

    // Aynı alan tabanda da pozitif kalmalı: scale <= 0 compiler'da 422.
    await editor.page.keyboard.press('Control+a');
    await editor.page.keyboard.type('0');
    await editor.page.keyboard.press('Enter');
    await editor.page.waitForTimeout(150);
    expect(
      (await readClip(editor.page, seed.clipAId)).transform.scale,
      '0 yazmak klibi görünmez yapmamalı — pozitif tabana kırpılmalı.',
    ).toBeGreaterThan(0);
    expectDocValid(await readDoc(editor.page), 'ölçek tabanına kırpma sonrası');
  });

  /**
   * Fade kırpma regresyonu: fade'ler yalnız YAZILDIKLARI yerde kırpılıyordu,
   * klibi KISALTAN işlemler (trim) onları olduğu gibi bırakıyordu →
   * fadeIn + fadeOut > süre → export 422. Burada fade gerçek fareyle
   * büyütülür, klip gerçek fareyle kırpılır ve doküman paylaşılan sözleşmeyle
   * doğrulanır.
   */
  test('fade büyütülüp klip kırpılınca doküman geçerli kalır (gerçek fare)', async ({
    editor,
    seed,
  }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    const before = await readClip(editor.page, seed.clipAId);
    expect(before.timelineDurationUs, 'Seed klibi 6 sn olmalı.').toBe(6_000_000);

    // Fade in slider'ını sonuna kadar sürükle (tavan: min(5 sn, klip süresi)).
    const slider = editor.page.getByTestId('clip-fade-in');
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box, 'Fade in slider\'ı görünmüyor.').not.toBeNull();
    const y = box!.y + box!.height / 2;
    await dragHorizontally(
      editor.page,
      { x: box!.x + box!.width / 2, y },
      box!.x + box!.width + 40,
    );

    const faded = await readClip(editor.page, seed.clipAId);
    expect(faded.audio, 'Klibin sesi kaybolmamalı.').not.toBeNull();
    expect(
      faded.audio!.fadeInUs,
      'Slider\'ı sağa sürüklemek fade in süresini büyütmeli.',
    ).toBeGreaterThan(3_000_000);
    expectDocValid(await readDoc(editor.page), 'fade büyütüldükten sonra');

    // Klibi 6 sn -> ~2 sn'ye kırp (sağ kenar tutamağı, gerçek fare).
    await editor.timeline.dragRightEdgeByTime(seed.clipAId, -4_000_000);

    const trimmed = await readClip(editor.page, seed.clipAId);
    expect(
      trimmed.timelineDurationUs,
      'Sağ kenarı sola sürüklemek klibi gerçekten kısaltmalı.',
    ).toBeLessThan(before.timelineDurationUs);
    expect(trimmed.audio).not.toBeNull();
    expect(
      trimmed.audio!.fadeInUs + trimmed.audio!.fadeOutUs,
      'Kırpma sonrası fade\'ler klibe sığmalı — aksi halde export 422 verir.',
    ).toBeLessThanOrEqual(trimmed.timelineDurationUs);
    expectDocValid(await readDoc(editor.page), 'fade + kırpma sonrası');

    // Geri alma da geçerli bir dokümana dönmeli.
    await blurPanel(editor.page);
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(150);
    expect((await readClip(editor.page, seed.clipAId)).timelineDurationUs).toBe(
      before.timelineDurationUs,
    );
    expectDocValid(await readDoc(editor.page), 'Ctrl+Z sonrası');
  });

  test('sağ tık > "Sesi ayır" sesi yeni bir ses track\'ine taşır', async ({ editor, seed }) => {
    const source = await readClip(editor.page, seed.clipAId);
    expect(source.audio, 'Seed klibinin gömülü sesi olmalı.').not.toBeNull();
    const tracksBefore = await readTracks(editor.page);
    expect(tracksBefore.some((t) => t.type === 'audio')).toBe(false);

    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.contextMenuItem(/sesi ayır/i).click();
    await editor.page.waitForTimeout(200);

    const tracksAfter = await readTracks(editor.page);
    const audioTrack = tracksAfter.find((t) => t.type === 'audio');
    expect(audioTrack, 'Ses için yeni bir audio track oluşturulmalı.').toBeDefined();
    expect(audioTrack!.clipIds).toHaveLength(1);

    const detached = await readClip(editor.page, audioTrack!.clipIds[0]);
    expect(detached.kind).toBe('audio');
    expect(detached.timelineStartUs).toBe(source.timelineStartUs);
    expect(detached.timelineDurationUs).toBe(source.timelineDurationUs);
    expect(detached.assetId).toBe(source.assetId);
    expect(detached.sourceInUs).toBe(source.sourceInUs);
    expect(detached.sourceOutUs).toBe(source.sourceOutUs);

    // Video klip resmi korur, sesi bırakır.
    expect((await readClip(editor.page, seed.clipAId)).audio).toBeNull();

    // Tek geçmiş girdisi + tek Ctrl+Z ile tamamen geri alınır.
    const state = await editor.state();
    expect(state.historyLabels.at(-1)).toMatch(/ses ayrıldı/i);
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(150);
    expect((await readTracks(editor.page)).some((t) => t.type === 'audio')).toBe(false);
    expect((await readClip(editor.page, seed.clipAId)).audio).not.toBeNull();
  });
});
