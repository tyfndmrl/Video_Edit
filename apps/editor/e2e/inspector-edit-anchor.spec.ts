/**
 * "Bir düzenleme YAZILDIĞI ana aittir" — GERÇEK fare ve klavye ile.
 *
 * ---------------------------------------------------------------------------
 * NEYİ KANITLIYOR
 * ---------------------------------------------------------------------------
 * Inspector alanları yazıyı BLUR'da işler. Blur'u tetikleyen tıklama ise
 * çoğu zaman dünyayı çoktan değiştirmiş olur: cetvele basmak playhead'i
 * taşır, başka bir klibe basmak seçimi değiştirir — ve ikisi de blur'DAN ÖNCE
 * olur (pointerdown işleyicisi çalışır, odak ondan sonra taşınır). Aynı şekilde
 * bir kaydırıcı/etiket sürüklemesi düğme basılı olduğu SÜRECE değer yazar;
 * oynatma sırasında playhead altından akıp gider.
 *
 * Düzeltmeden ÖNCE bu dosyadaki senaryolar şunu üretiyordu (hepsi bu ortamda,
 * gerçek fareyle ölçüldü):
 *  - 63 sn'de `-0.30` yazıp cetvele tıklamak: 65 sn'ye İKİNCİ bir keyframe
 *    yazıyor, 63 sn'deki 0 olarak kalıyordu;
 *  - oynatma sırasında TEK bir etiket sürüklemesi klibe DÖRT keyframe serpiyordu;
 *  - bir klibin alanına yazıp BAŞKA bir klibe tıklamak sayıyı/rengi o başka
 *    klibe yazıyordu;
 *  - alana hiç yazmadan odaklanıp playhead'i oynatmak yeni ana gereksiz bir
 *    keyframe ekliyordu.
 *
 * KURAL (docs/review-gate.md §3): yalnız page.mouse.* / page.keyboard.*.
 * Sentetik olay ve doğrudan store çağrısı YOK; store sadece DOĞRULAMA için
 * okunur (keyframe listesi ekranda okunamaz, tek kaynak dokümandır).
 *
 * KAPSAM DIŞI (bilinçli): oynatma sırasında GİZMO sürüklemesi — gizmo çapayı
 * zaten pointerdown'da donduruyor (TransformGizmo `drag.clipTimeUs`), bu dosya
 * onu ölçmez; metin içeriği alanı (burst) her tuş vuruşunda yazdığı için
 * ertelenmiş bir commit'i yoktur.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** Şekil klibi buraya doğar: [63 s, 68 s). */
const SHAPE_START_US = 63 * SECOND_US;
/** Seed projesi 30 fps — bir kare 33333 µs (tolerans hesapları için). */
const FRAME_US = SECOND_US / 30;

interface KeyframeProbe {
  timeUs: number;
  value: number;
}

async function readKeyframes(
  page: Page,
  clipId: string,
  channel: string,
): Promise<KeyframeProbe[]> {
  return page.evaluate(
    ({ id, ch }) => {
      const bridge = (
        window as unknown as {
          __ve: {
            doc: {
              useDocStore: {
                getState(): {
                  doc: { tracks: { clips: { id: string; keyframes: Record<string, unknown> }[] }[] };
                };
              };
            };
          };
        }
      ).__ve;
      for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
        for (const clip of track.clips) {
          if (clip.id === id) {
            return JSON.parse(JSON.stringify(clip.keyframes[ch] ?? [])) as KeyframeProbe[];
          }
        }
      }
      return [] as KeyframeProbe[];
    },
    { id: clipId, ch: channel },
  );
}

/** Şekil kliplerinin (başlangıç zamanına göre sıralı) yazılabilir alanları. */
async function readShapes(
  page: Page,
): Promise<{ id: string; startUs: number; fill: string; x: number }[]> {
  return page.evaluate(() => {
    const bridge = (
      window as unknown as {
        __ve: {
          doc: {
            useDocStore: {
              getState(): {
                doc: {
                  tracks: {
                    clips: {
                      id: string;
                      kind: string;
                      timelineStartUs: number;
                      shape?: { fill: string };
                      transform: { x: number };
                    }[];
                  }[];
                };
              };
            };
          };
        };
      }
    ).__ve;
    const out: { id: string; startUs: number; fill: string; x: number }[] = [];
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'shape') continue;
        out.push({
          id: clip.id,
          startUs: clip.timelineStartUs,
          fill: clip.shape?.fill ?? '',
          x: clip.transform.x,
        });
      }
    }
    return out.sort((a, b) => a.startUs - b.startUs);
  });
}

/** Gerçek fare tıklaması (scrollIntoViewIfNeeded OLAY ÜRETMEZ, yalnız kaydırır). */
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

/** Alana gerçek fareyle odaklan, içeriğini seç ve GERÇEK klavyeyle yaz. */
async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  const field = page.getByTestId(testId);
  await expect(field, `Alan ekranda yok: ${testId}`).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  expect(box, `Alanın kutusu okunamadı: ${testId}`).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

/** İmleç çapalı Ctrl+wheel — klip ekranda büyük kalsın (tıklama hedefleri rahat). */
async function zoomOnClip(
  editor: {
    timeline: {
      clipCenter(id: string): Promise<{ x: number; y: number }>;
      ctrlWheel(d: number, at: { x: number; y: number }): Promise<void>;
    };
  },
  clipId: string,
  steps: number,
): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await editor.timeline.ctrlWheel(-120, await editor.timeline.clipCenter(clipId));
  }
}

/**
 * Basılı tut + kademeli hareket + bırak; her adımda playhead'i ÖRNEKLER.
 *
 * Neden örnekleme: oynatma sırasında canlı doküman düzenlemesi playhead'i
 * düzgün ilerletmiyor, ileri-geri SEKİYOR (bu ortamda ölçüldü — motorun saat
 * davranışı, bu dilimin konusu DEĞİL). "Baştan sona ne kadar aktı" ölçüsü bu
 * yüzden güvenilmez; jestin gördüğü playhead KÜMESİ güvenilirdir.
 */
async function dragWhilePlayhead(
  page: Page,
  editor: { state(): Promise<{ playheadUs: number }> },
  startX: number,
  startY: number,
  stepAt: (i: number) => { x: number; y: number },
): Promise<number[]> {
  const seen: number[] = [];
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  seen.push((await editor.state()).playheadUs);
  for (let i = 1; i <= 8; i++) {
    const p = stepAt(i);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(70);
    seen.push((await editor.state()).playheadUs);
  }
  await page.mouse.up();
  return seen;
}

/**
 * ÖN KOŞUL: playhead jest boyunca gerçekten hareket etti. Etmediyse test
 * hiçbir şey ölçmüyor demektir ve sessizce yeşile dönmemeli.
 */
function assertPlayheadMoved(seen: number[]): void {
  expect(
    new Set(seen).size,
    `oynatma jest boyunca playhead'i hiç taşımadı (okunanlar: ${seen.join(',')}) — ` +
      'test boşa koşmuş olurdu',
  ).toBeGreaterThanOrEqual(3);
}

/** "Şekil ekle" düğmesine gerçek tık — playhead'in olduğu yere şekil klibi. */
async function addShapeAt(
  editor: {
    page: Page;
    timeline: { scrubTo(us: number): Promise<void> };
    state(): Promise<{ tracks: { type: string; clips: { id: string; kind: string }[] }[] }>;
  },
  atUs: number,
): Promise<string> {
  await editor.timeline.scrubTo(atUs);
  const before = (await editor.state()).tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.kind === 'shape')
    .map((c) => c.id);
  await clickReal(editor.page, 'add-shape-clip');
  const after = (await editor.state()).tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'shape');
  const fresh = after.find((c) => !before.includes(c.id));
  expect(fresh, '"Şekil ekle" yeni bir şekil klibi üretmedi.').toBeDefined();
  return fresh!.id;
}

test.describe('Inspector düzenlemesi yazıldığı ana çapalıdır', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('yazılan sayı, blur\'u tetikleyen cetvel tıklaması playhead\'i taşısa bile YAZILDIĞI keyframe\'e gider', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAt(editor, SHAPE_START_US);
    await zoomOnClip(editor, clipId, 3);

    // Konum X'i animasyonlu yap: playhead klibin başında, yani kf(0) = 0.
    await clickReal(page, 'clip-kf-x');
    expect(await readKeyframes(page, clipId, 'x')).toEqual([
      expect.objectContaining({ timeUs: 0, value: 0 }),
    ]);

    // Kullanıcı yazar ama ENTER'a BASMAZ — commit'i cetvel tıklaması tetikleyecek.
    await typeInto(page, 'clip-x', '-0.30');
    expect(
      await readKeyframes(page, clipId, 'x'),
      'yazmak tek başına dokümana yazmamalı (commit blur/Enter ile olur)',
    ).toEqual([expect.objectContaining({ timeUs: 0, value: 0 })]);

    // GERÇEK cetvel tıklaması: önce playhead 65 sn'ye gider, SONRA blur düşer.
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await page.waitForTimeout(250);
    expect((await editor.state()).playheadUs, 'cetvel tıklaması playhead\'i taşımalıydı').toBe(
      SHAPE_START_US + 2 * SECOND_US,
    );

    const after = await readKeyframes(page, clipId, 'x');
    expect(
      after,
      'yazılan değer YAZILDIĞI ana (klip başı) yazılmalı; yeni playhead\'e İKİNCİ bir keyframe açmamalı',
    ).toEqual([expect.objectContaining({ timeUs: 0, value: -0.3 })]);

    // Alan artık YENİ playhead'in örneğini gösterir (kanal tek keyframe'li -> sabit).
    await expect.poll(() => page.getByTestId('clip-x').inputValue()).toBe('-0.3000');
  });

  test('aynı düzenleme Enter ile de, blur ile de AYNI dokümanı üretir', async ({ editor }) => {
    const page = editor.page;
    const clipId = await addShapeAt(editor, SHAPE_START_US);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-x');

    // Kontrol grubu: Enter ile commit (playhead hiç oynamaz).
    await typeInto(page, 'clip-x', '-0.30');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await readKeyframes(page, clipId, 'x')).toEqual([
      expect.objectContaining({ timeUs: 0, value: -0.3 }),
    ]);
  });

  test('sadece odaklanıp playhead\'i taşımak (hiç yazmadan) keyframe DE geçmiş kaydı DA üretmez', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAt(editor, SHAPE_START_US);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-x');
    const historyBefore = (await editor.state()).historyLabels.length;

    // Alana yalnız odaklan: gerçek tık, tuş YOK.
    const field = page.getByTestId('clip-x');
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(120);

    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    await page.waitForTimeout(250);

    expect(
      await readKeyframes(page, clipId, 'x'),
      'blur bir düzenleme DEĞİLDİR: kullanıcının seçmediği bir değer yazılmamalı',
    ).toEqual([expect.objectContaining({ timeUs: 0, value: 0 })]);
    expect(
      (await editor.state()).historyLabels.length,
      'yazılmayan bir alan geçmişe satır eklememeli',
    ).toBe(historyBefore);
  });

  test('OYNATMA sırasında tek bir etiket sürüklemesi TEK yeni keyframe bırakır', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAt(editor, SHAPE_START_US);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-x');
    // Oynatmayı klibin BAŞINDA değil ortasında başlat: jestin çapası klip
    // başındaki mevcut keyframe'e (t=0) denk gelirse test onu güncellemekle
    // yenisini eklemeyi ayırt edemezdi.
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    const before = await readKeyframes(page, clipId, 'x');

    // GERÇEK klavye: Space oynatır.
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);

    const scrub = page.getByTestId('clip-x-scrub');
    await scrub.scrollIntoViewIfNeeded();
    const box = await scrub.boundingBox();
    expect(box, 'Konum X etiketi (scrub alanı) görünmüyor.').not.toBeNull();
    const y = box!.y + box!.height / 2;
    const seen = await dragWhilePlayhead(page, editor, box!.x + box!.width / 2, y, (i) => ({
      x: box!.x + box!.width / 2 + i * 6,
      y,
    }));
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);

    assertPlayheadMoved(seen);
    const after = await readKeyframes(page, clipId, 'x');
    expect(
      after.length - before.length,
      `tek jest = tek yeni keyframe; okunan zamanlar: ${after.map((k) => k.timeUs).join(',')}`,
    ).toBe(1);
    const added = after.find((k) => !before.some((b) => b.timeUs === k.timeUs));
    expect(added, 'yeni keyframe bulunamadı').toBeDefined();
    expect(
      added!.timeUs,
      'yeni keyframe jestin gördüğü playhead penceresinin İÇİNDE olmalı',
    ).toBeGreaterThanOrEqual(Math.min(...seen) - SHAPE_START_US - FRAME_US);
    expect(added!.timeUs).toBeLessThanOrEqual(Math.max(...seen) - SHAPE_START_US + FRAME_US);
    expect(added!.value, 'sürükleme değeri gerçekten değiştirmeliydi').toBeGreaterThan(0);
  });

  test('OYNATMA sırasında tek bir opaklık sürüklemesi TEK yeni keyframe bırakır', async ({
    editor,
  }) => {
    const page = editor.page;
    const clipId = await addShapeAt(editor, SHAPE_START_US);
    await zoomOnClip(editor, clipId, 3);
    await clickReal(page, 'clip-kf-opacity');
    await editor.timeline.scrubTo(SHAPE_START_US + 2 * SECOND_US);
    const before = await readKeyframes(page, clipId, 'opacity');

    await page.keyboard.press('Space');
    await page.waitForTimeout(150);

    const slider = page.getByTestId('clip-opacity');
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    expect(box, 'Opaklık kaydırıcısı görünmüyor.').not.toBeNull();
    const y = box!.y + box!.height / 2;
    const seen = await dragWhilePlayhead(page, editor, box!.x + box!.width - 4, y, (i) => ({
      x: box!.x + box!.width - 4 - i * 8,
      y,
    }));
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);

    assertPlayheadMoved(seen);
    const after = await readKeyframes(page, clipId, 'opacity');
    expect(
      after.length - before.length,
      `tek jest = tek yeni keyframe; okunan zamanlar: ${after.map((k) => k.timeUs).join(',')}`,
    ).toBe(1);
    const added = after.find((k) => !before.some((b) => b.timeUs === k.timeUs));
    expect(added, 'yeni keyframe bulunamadı').toBeDefined();
    expect(added!.value, 'kaydırıcı opaklığı gerçekten düşürmeliydi').toBeLessThan(1);
  });

  test('yazıp BAŞKA klibe tıklamak sayıyı yazıldığı klibe koyar (komşuyu kirletmez)', async ({
    editor,
  }) => {
    const page = editor.page;
    const first = await addShapeAt(editor, SHAPE_START_US);
    const second = await addShapeAt(editor, 70 * SECOND_US);
    const shapes = await readShapes(page);
    expect(shapes.map((s) => s.id)).toEqual([first, second]);

    // İlk şekli seç, alana yaz, sonra İKİNCİ şekle GERÇEK tık (blur onu tetikler).
    await editor.timeline.click(await editor.timeline.clipCenter(first));
    await page.waitForTimeout(200);
    await typeInto(page, 'clip-x', '0.25');
    await editor.timeline.click(await editor.timeline.clipCenter(second));
    await page.waitForTimeout(300);

    const after = await readShapes(page);
    expect(after[0].x, 'sayı YAZILDIĞI klibe gitmeli').toBeCloseTo(0.25, 6);
    expect(after[1].x, 'sonradan seçilen klip DEĞİŞMEMELİ').toBe(0);
  });

  test('yazıp BAŞKA klibe tıklamak rengi yazıldığı klibe koyar (komşuyu kirletmez)', async ({
    editor,
  }) => {
    const page = editor.page;
    const first = await addShapeAt(editor, SHAPE_START_US);
    const second = await addShapeAt(editor, 70 * SECOND_US);
    const before = await readShapes(page);
    const defaultFill = before[0].fill;

    await editor.timeline.click(await editor.timeline.clipCenter(first));
    await page.waitForTimeout(200);
    await typeInto(page, 'clip-shape-fill', '#123456');
    await editor.timeline.click(await editor.timeline.clipCenter(second));
    await page.waitForTimeout(300);

    const after = await readShapes(page);
    expect(after[0].id).toBe(first);
    expect(after[0].fill, 'renk YAZILDIĞI klibe gitmeli').toBe('#123456');
    expect(after[1].fill, 'sonradan seçilen klip DEĞİŞMEMELİ').toBe(defaultFill);
  });
});
