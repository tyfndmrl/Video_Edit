/**
 * Önizleme transform gizmo'su — GERÇEK fareyle (page.mouse.*).
 *
 * Neden bu dosya var: gizmo canvas ÜSTÜNDE çizilen bir SVG katmanı; "kutu
 * göründü" ile "kutu gerçekten sürüklenebiliyor" arasındaki fark yalnızca
 * gerçek pointer olaylarıyla (pointer capture, sürükleme eşiği, bırakma
 * anındaki click bastırması) ortaya çıkar. dispatchEvent YASAK.
 *
 * Kutu koordinatları UYGULAMADAN okunur (SVG'nin kendi polygon noktaları):
 * test kendi geometri matematiğini kurmaz, ekranda ne çizildiyse oraya tıklar.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { SECOND_US } from './fixtures/seed';

/** clipA [60s,66s) — playhead'i klibin ORTASINA getir ki gizmo görünsün. */
const INSIDE_CLIP_A_US = 63 * SECOND_US;

interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
}

interface GizmoScreenGeometry {
  /** Kutu köşeleri (nw, ne, se, sw) — SAYFA koordinatı. */
  corners: { x: number; y: number }[];
  centre: { x: number; y: number };
  rotate: { x: number; y: number };
  cornerSe: { x: number; y: number };
  /**
   * Sahnenin (gizmo katmanının) kendi kutusu — SAYFA koordinatı.
   *
   * NEDEN GEREKLİ: klip kutusu tipik olarak canvas'ın NEREDEYSE TAMAMINI kaplar
   * (kaynak en-boy oranı proje oranına eşitse birebir). "Kutunun dışı" diye
   * köşeden sabit bir offset çıkarmak testi sahnenin tamamen DIŞINA, komşu
   * panelin başlığına taşır ve test ürünü değil kendi aritmetiğini ölçer
   * (ilk yazımda tam olarak bu oldu: tıklama 248,38'e — kütüphane başlığına —
   * düştü). Doğru hedef letterbox bandıdır: sahnenin içi, kutunun dışı.
   */
  stage: { left: number; top: number; width: number; height: number };
}

/**
 * Sahnenin İÇİNDE ama klip kutusunun DIŞINDA bir nokta (letterbox bandı) —
 * SAYFA koordinatı. En kalın bandı seçer; hiçbiri tıklanabilir kalınlıkta
 * değilse testi anlaşılır bir mesajla düşürür (sessizce kutunun içine tıklayıp
 * sahte yeşil üretmesindense).
 */
function outsideBoxPoint(geo: GizmoScreenGeometry): { x: number; y: number } {
  const xs = geo.corners.map((p) => p.x);
  const ys = geo.corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const { left, top, width, height } = geo.stage;
  const midX = left + width / 2;
  const midY = top + height / 2;
  const bands = [
    { thickness: minY - top, point: { x: midX, y: (top + minY) / 2 } },
    { thickness: top + height - maxY, point: { x: midX, y: (maxY + top + height) / 2 } },
    { thickness: minX - left, point: { x: (left + minX) / 2, y: midY } },
    { thickness: left + width - maxX, point: { x: (maxX + left + width) / 2, y: midY } },
  ];
  bands.sort((a, b) => b.thickness - a.thickness);
  const best = bands[0]!;
  expect(
    best.thickness,
    'Klip kutusu sahnenin tamamını kaplıyor: "kutunun dışı" tıklanacak bir yer yok.',
  ).toBeGreaterThan(6);
  return best.point;
}

/**
 * ---------------------------------------------------------------------------
 * NİCEL İDDİA KURALI (M4 denetimi, yüksek bulgu)
 * ---------------------------------------------------------------------------
 * Bu dosya eskiden yalnız YÖN kanıtlıyordu ("x arttı", "ölçek küçüldü").
 * Sürükleme ile dokümana yazılan miktar arasındaki katsayı ikiye bölünse ya da
 * ekran ölçeği hesaba katılmasa test yine yeşil kalırdı. Beklenen değerler
 * rendering-semantics §2.3'ten türetilir:
 *
 *   P = (W/2 + x*W, H/2 + y*H)   ->   Δx_doc = Δx_komp / W
 *   ekran -> kompozisyon dönüşümü TEK ÜNİFORM ölçektir (viewport.ts):
 *   Δx_komp = Δx_ekran / mappingScale,  ve  kutu_genişliği = W * mappingScale
 *   =>  Δx_doc = Δx_ekran / kutu_genişliği           (ölçekten bağımsız!)
 *
 * Yani beklenen değer, EKRANDA ölçülen kutu genişliğine bölünmüş piksel
 * mesafesidir; testin ikinci bir geometri matematiği kurmasına gerek yok.
 * Bu türetme kutunun kompozisyon dikdörtgeni olmasını varsayar (kaynak boyutu
 * bilinmediğinde "fit" kutusu tam olarak budur); `expectBoxIsCompRect` bunu
 * her testte ayrıca doğrular, varsayım sessizce çürüyemez.
 *
 * Tolerans neden ~2 px: fare koordinatı girdi hattında tam sayıya
 * yuvarlanabilir (basma + bırakma) ve doküman değerleri 4/3/2 ondalığa
 * yuvarlanarak saklanır. 2 px'ten büyük hiçbir sapma affedilmez.
 */
const TOLERANCE_PX = 2;

/** Kutunun eksen hizalı ekran boyutu (rotasyon 0 iken kutunun kendisi). */
function boxSize(geo: GizmoScreenGeometry): { w: number; h: number } {
  const xs = geo.corners.map((p) => p.x);
  const ys = geo.corners.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * "Kutu = kompozisyon dikdörtgeni" varsayımının denetimi. Kaynak en-boy oranı
 * proje oranıyla aynıysa fit kutusu birebir kompozisyon kutusudur ve
 * `Δx_doc = Δx_ekran / kutu_genişliği` türetmesi geçerlidir. Değilse beklenen
 * değerler sessizce kayardı — bu yüzden iddia edilir, varsayılmaz.
 */
async function expectBoxIsCompRect(page: Page, geo: GizmoScreenGeometry): Promise<void> {
  const comp = await page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: { getState(): { doc: { settings: { width: number; height: number } } } };
        };
      };
    }).__ve;
    const s = bridge.doc.useDocStore.getState().doc.settings;
    return { width: s.width, height: s.height };
  });
  const box = boxSize(geo);
  expect(
    box.w / box.h,
    'Gizmo kutusu proje en-boy oranını taşımalı; taşımıyorsa beklenen değer ' +
      'türetmesi (Δx_doc = Δx_ekran / kutu_genişliği) geçersizdir.',
  ).toBeCloseTo(comp.width / comp.height, 2);
}

/** Dokümandaki transform (store, salt okunur doğrulama). */
async function clipTransform(page: Page, clipId: string): Promise<ClipTransform> {
  const value = await page.evaluate((id: string) => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): {
              doc: {
                tracks: { clips: { id: string; transform: ClipTransformLike }[] }[];
              };
            };
          };
        };
      };
    }).__ve;
    interface ClipTransformLike {
      x: number;
      y: number;
      scale: number;
      rotationDeg: number;
    }
    for (const track of bridge.doc.useDocStore.getState().doc.tracks) {
      for (const clip of track.clips) {
        if (clip.id === id) return clip.transform;
      }
    }
    return null;
  }, clipId);
  expect(value, `Klip dokümanda yok: ${clipId}`).not.toBeNull();
  return value as ClipTransform;
}

async function isPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { editor: { useEditorStore: { getState(): { isPlaying: boolean } } } };
    }).__ve;
    return bridge.editor.useEditorStore.getState().isPlaying;
  });
}

/**
 * docStore'da AÇIK bir transaction var mı?
 *
 * Bu bayrak bu dosyadaki en önemli doğrulama: açık kalan bir transaction
 * autosave'i süresiz erteler ve SONRAKİ her mutate/undo'yu THROW ettirir
 * (docStore.assertNoActiveTransaction). Yani "kutu kayboldu ama jest kapanmadı"
 * hatası ekranda görünmez — yalnız buradan yakalanır.
 */
async function transactionOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: { doc: { useDocStore: { getState(): { transactionOpen: boolean } } } };
    }).__ve;
    return bridge.doc.useDocStore.getState().transactionOpen === true;
  });
}

/** Gerçek fare: bas + kademeli hareket — BIRAKMADAN (jest havada kalır). */
async function beginDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 6, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.move(to.x, to.y);
  await page.waitForTimeout(100);
}

/**
 * Bu projenin ölçek TAVANI — uygulamanın KENDİ yetkili fonksiyonundan okunur
 * (state/timelineOps.maxClipScale). Test burada formülü tekrar kurmaz: tavan
 * proje çözünürlüğünden türüyor (derleyici katman kutusunu 8192 px ile
 * sınırlıyor) ve tam da "gizmo kendi sabitini mi kullanıyor, yoksa dokümanın
 * gerçekten kabul ettiği sınırı mı?" sorusunu yanıtlamak için gerekiyor.
 * maxClipScale saf bir fonksiyon olduğu için modül örneği kimliği önemsizdir.
 */
async function projectMaxScale(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): { doc: { settings: { width: number; height: number } } };
          };
        };
      };
    }).__ve;
    // Değişken üzerinden import (appBridge ile aynı desen): TS modül
    // çözümlemesi devre dışı kalır, runtime'da Vite dev grafiğinden çözülür.
    const specifier = '/src/state/timelineOps.ts';
    const ops = (await import(/* @vite-ignore */ specifier)) as unknown as {
      maxClipScale(s: { width: number; height: number }): number;
    };
    return ops.maxClipScale(bridge.doc.useDocStore.getState().doc.settings);
  });
}

/** Oynatma sürüyorsa GERÇEK klavyeyle duraklat. */
async function ensurePaused(page: Page): Promise<void> {
  if (!(await isPlaying(page))) return;
  await page.keyboard.press('Space');
  await expect.poll(() => isPlaying(page), { message: 'Duraklatılamadı.' }).toBe(false);
}

/**
 * Gizmo'nun EKRANDAKİ geometrisi — SVG'nin kendi çizdiği noktalardan okunur.
 * Böylece test "uygulama kutuyu nereye çizdiyse" oraya tıklar; test tarafında
 * ikinci bir koordinat matematiği (ve onunla birlikte sahte bir yeşil) yok.
 */
async function gizmoGeometry(page: Page): Promise<GizmoScreenGeometry> {
  const geo = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="player-gizmo"]');
    const box = document.querySelector('[data-testid="player-gizmo-box"]');
    const rotate = document.querySelector('[data-testid="player-gizmo-rotate"]');
    const se = document.querySelector('[data-testid="player-gizmo-corner-se"]');
    if (!svg || !box || !rotate || !se) return null;
    const r = svg.getBoundingClientRect();
    const corners = (box.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x: r.left + x, y: r.top + y };
      });
    if (corners.length !== 4) return null;
    const centre = {
      x: corners.reduce((s, p) => s + p.x, 0) / 4,
      y: corners.reduce((s, p) => s + p.y, 0) / 4,
    };
    return {
      corners,
      centre,
      rotate: {
        x: r.left + Number(rotate.getAttribute('cx')),
        y: r.top + Number(rotate.getAttribute('cy')),
      },
      cornerSe: {
        x: r.left + Number(se.getAttribute('x')) + Number(se.getAttribute('width')) / 2,
        y: r.top + Number(se.getAttribute('y')) + Number(se.getAttribute('height')) / 2,
      },
      stage: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  });
  expect(geo, 'Gizmo ekranda bulunamadı (player-gizmo* testid\'leri yok).').not.toBeNull();
  return geo as GizmoScreenGeometry;
}

/** Gerçek fare: bas → kademeli hareket (eşiği aşacak şekilde) → bırak. */
async function dragMouse(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Sürükleme eşiği (3 px) aşılsın diye önce küçük bir hareket.
  await page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 6, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

test.describe('Player transform gizmo — gerçek fare', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('gizmo yalnız seçim VE playhead klibin üstündeyken görünür', async ({ editor, seed }) => {
    const gizmo = editor.page.getByTestId('player-gizmo');

    // Seçim yok -> kutu yok.
    await expect(gizmo, 'Seçim yokken gizmo görünmemeli.').toHaveCount(0);

    // Seçim var ama playhead 0'da (klip 60. saniyede) -> hâlâ yok.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    expect((await editor.state()).selection).toEqual([seed.clipAId]);
    await expect(
      gizmo,
      'Playhead klibin dışındayken (klip ekranda çizilmiyorken) gizmo görünmemeli.',
    ).toHaveCount(0);

    // Playhead klibin içine -> kutu belirir.
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(gizmo).toHaveCount(1);
    await expect(gizmo).toHaveAttribute('data-clip-id', seed.clipAId);

    // Seçim kalkınca kaybolur.
    await editor.page.keyboard.press('Escape');
    await editor.timeline.click(await editor.timeline.point(70 * SECOND_US, 1));
    await expect(gizmo, 'Seçim temizlenince gizmo kaybolmalı.').toHaveCount(0);
  });

  test('oynatırken gizmo gizlenir, duraklayınca geri gelir', async ({ editor, seed }) => {
    const gizmo = editor.page.getByTestId('player-gizmo');
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(gizmo, 'Duraklamışken ve seçim varken gizmo görünmeli.').toHaveCount(1);

    // Gerçek klavye: Space transport'u başlatır.
    await editor.page.keyboard.press('Space');
    await expect
      .poll(() => isPlaying(editor.page), { message: 'Space oynatmayı başlatmalıydı.' })
      .toBe(true);
    await expect(
      gizmo,
      'Oynatırken gizmo GİZLENMELİ (hareket eden bir hedef sürüklenemez).',
    ).toHaveCount(0);

    await editor.page.keyboard.press('Space');
    await expect.poll(() => isPlaying(editor.page)).toBe(false);
    await expect(gizmo, 'Duraklayınca gizmo geri gelmeli.').toHaveCount(1);
  });

  test('kutuyu sürüklemek transform.x değerini değiştirir, Ctrl+Z geri alır', async ({
    editor,
    seed,
  }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(editor.page.getByTestId('player-gizmo')).toHaveCount(1);

    const before = await clipTransform(editor.page, seed.clipAId);
    const historyBefore = await editor.state();
    expect(before.x).toBe(0);

    const geo = await gizmoGeometry(editor.page);
    await expectBoxIsCompRect(editor.page, geo);
    const box = boxSize(geo);
    const dragPx = { x: 120, y: 40 };
    await dragMouse(editor.page, geo.centre, {
      x: geo.centre.x + dragPx.x,
      y: geo.centre.y + dragPx.y,
    });

    const after = await clipTransform(editor.page, seed.clipAId);
    // §2.3: P = W/2 + x*W  ->  Δx_doc = Δx_ekran / kutu_genişliği.
    const expectedX = dragPx.x / box.w;
    const expectedY = dragPx.y / box.h;
    expect(
      Math.abs(after.x - expectedX),
      `120 px sağa sürükleme transform.x'i TAM ${expectedX.toFixed(4)} yapmalı ` +
        `(gerçek ${after.x}); "arttı" yetmez.`,
    ).toBeLessThan(TOLERANCE_PX / box.w);
    expect(
      Math.abs(after.y - expectedY),
      `40 px aşağı sürükleme transform.y'yi TAM ${expectedY.toFixed(4)} yapmalı ` +
        `(gerçek ${after.y}).`,
    ).toBeLessThan(TOLERANCE_PX / box.h);
    // Yatay/dikey oran korunmalı: eksenler karışırsa (x'e y katsayısı) yön
    // testleri yine yeşil kalırdı.
    expect(after.x / after.y).toBeCloseTo((dragPx.x / box.w) / (dragPx.y / box.h), 1);
    expect(after.scale, 'Taşıma ölçeğe dokunmamalı.').toBe(before.scale);
    expect(after.rotationDeg, 'Taşıma döndürmeye dokunmamalı.').toBe(before.rotationDeg);

    // TEK undo girdisi (sürükleme boyunca onlarca pointermove olmasına rağmen).
    const afterState = await editor.state();
    expect(
      afterState.cursor - historyBefore.cursor,
      'Bir sürükleme = BİR geçmiş girdisi (transaction coalescing).',
    ).toBe(1);
    expect(afterState.historyLabels.at(-1)).toMatch(/konum/i);

    // Sürükleme bittiğinde click bastırılmalı: oynatma başlamamalı, kutu durmalı.
    expect(await isPlaying(editor.page), 'Sürükleme sonundaki click oynatmayı başlatmamalı.').toBe(
      false,
    );
    await expect(editor.page.getByTestId('player-gizmo')).toHaveCount(1);

    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(150);
    const undone = await clipTransform(editor.page, seed.clipAId);
    expect(undone.x, 'Ctrl+Z sürüklemeyi geri almalı.').toBe(before.x);
    expect(undone.y).toBe(before.y);
    expect((await editor.state()).cursor).toBe(historyBefore.cursor);
  });

  test('köşe tutamağı ölçeği değiştirir (konumu değil)', async ({ editor, seed }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    const before = await clipTransform(editor.page, seed.clipAId);

    const geo = await gizmoGeometry(editor.page);
    await expectBoxIsCompRect(editor.page, geo);
    // Sağ-alt köşeyi çapaya (merkez) DOĞRU çek: ölçek küçülür.
    // Ölçek faktörü, çapa->imleç vektörünün çapa->köşe vektörüne izdüşümüdür
    // (core/gizmo.ts). Köşeyi çapaya doğru %40 çekmek faktörü TAM 0.6 yapar —
    // yani beklenen ölçek, başlangıç ölçeğinin 0.6 katı, tahmin değil hesap.
    const pull = 0.4;
    const inward = {
      x: geo.cornerSe.x - (geo.cornerSe.x - geo.centre.x) * pull,
      y: geo.cornerSe.y - (geo.cornerSe.y - geo.centre.y) * pull,
    };
    const armPx = Math.hypot(geo.cornerSe.x - geo.centre.x, geo.cornerSe.y - geo.centre.y);
    await dragMouse(editor.page, geo.cornerSe, inward);

    const after = await clipTransform(editor.page, seed.clipAId);
    const expectedScale = before.scale * (1 - pull);
    expect(expectedScale).toBeCloseTo(0.6, 10);
    expect(
      Math.abs(after.scale - expectedScale),
      `Ölçek TAM ${expectedScale} olmalı (gerçek ${after.scale}); "küçüldü" yetmez.`,
    ).toBeLessThan(TOLERANCE_PX / armPx);
    expect(after.x, 'Ölçekleme konuma dokunmamalı (çapa sabit nokta, §2.3).').toBe(before.x);
    expect(after.y).toBe(before.y);
    expect((await editor.state()).historyLabels.at(-1)).toMatch(/ölçek/i);

    // Kutu da gerçekten küçülmeli: doküman değişip ekran değişmiyorsa gizmo
    // pointer'ı takip etmiyor demektir.
    const geoAfter = await gizmoGeometry(editor.page);
    expect(boxSize(geoAfter).w / boxSize(geo).w).toBeCloseTo(1 - pull, 1);
  });

  test('üst tutamak klibi döndürür', async ({ editor, seed }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    const before = await clipTransform(editor.page, seed.clipAId);
    expect(before.rotationDeg).toBe(0);

    const geo = await gizmoGeometry(editor.page);
    // Tutamak çapanın TAM ÜSTÜNDE (açı -90°); imleci çapa etrafında -45°'ye
    // taşımak TAM 45° saat yönü dönüş demektir (core/gizmo.ts: atan2 farkı).
    // Yarıçap açıyı etkilemez, bu yüzden beklenen değer birebir hesaplanabilir.
    const radius = geo.centre.y - geo.rotate.y;
    const targetAngleDeg = -45;
    const targetRad = (targetAngleDeg * Math.PI) / 180;
    await dragMouse(editor.page, geo.rotate, {
      x: geo.centre.x + radius * Math.cos(targetRad),
      y: geo.centre.y + radius * Math.sin(targetRad),
    });

    const after = await clipTransform(editor.page, seed.clipAId);
    const expectedDeg = targetAngleDeg - -90; // 45
    expect(expectedDeg).toBe(45);
    // Tolerans: yarıçap üzerinde ~2 px'lik imleç yuvarlaması kadar açı.
    const toleranceDeg = ((TOLERANCE_PX / radius) * 180) / Math.PI;
    expect(
      Math.abs(after.rotationDeg - expectedDeg),
      `Dönüş TAM ${expectedDeg}° olmalı (gerçek ${after.rotationDeg}°, ` +
        `tolerans ±${toleranceDeg.toFixed(2)}°); "pozitif oldu" yetmez.`,
    ).toBeLessThan(toleranceDeg);
    expect(after.x, 'Döndürme konuma dokunmamalı.').toBe(before.x);
    expect(after.scale, 'Döndürme ölçeğe dokunmamalı.').toBe(before.scale);
    expect((await editor.state()).historyLabels.at(-1)).toMatch(/döndür/i);
  });

  test('köşeyi dışarı taşırmak PROJEDEN türeyen tavanda durur (kendi sabitinde değil)', async ({
    editor,
    seed,
  }) => {
    // M4 denetimi: gizmo kendi MAX_SCALE sabitini taşıyordu. Sabit, op'un
    // gerçekte kabul ettiği sınırdan ayrıldığı anda kutu pointer'ı takip etmeyi
    // sessizce bırakır (ya da doküman export'ta reddedilecek bir değer saklar).
    // Burada tavan uygulamanın kendi maxClipScale'inden okunuyor.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    const ceiling = await projectMaxScale(editor.page);
    expect(
      ceiling,
      'Tavan çözünürlükten türemeli (1080p projede sabit 10 değil).',
    ).toBeLessThan(10);

    const geo = await gizmoGeometry(editor.page);
    // Köşeyi çapadan UZAĞA, ekranın çok ötesine taşı: tavan zorlanır.
    const outward = {
      x: geo.centre.x + (geo.cornerSe.x - geo.centre.x) * 40,
      y: geo.centre.y + (geo.cornerSe.y - geo.centre.y) * 40,
    };
    await dragMouse(editor.page, geo.cornerSe, outward);

    const after = await clipTransform(editor.page, seed.clipAId);
    expect(
      after.scale,
      'Kaçak sürükleme TAM OLARAK projenin tavanına oturmalı — op\'un kırpacağı bir değer önerilmemeli.',
    ).toBe(ceiling);

    // Aynı yönde bir sürükleme daha: tavan gerçekten tavansa değer değişmez.
    const geo2 = await gizmoGeometry(editor.page);
    await dragMouse(editor.page, geo2.cornerSe, {
      x: geo2.centre.x + (geo2.cornerSe.x - geo2.centre.x) * 40,
      y: geo2.centre.y + (geo2.cornerSe.y - geo2.centre.y) * 40,
    });
    expect((await clipTransform(editor.page, seed.clipAId)).scale).toBe(ceiling);
  });

  test('sürükleme ortasında Escape jesti İPTAL eder (gerçek klavye)', async ({ editor, seed }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(editor.page.getByTestId('player-gizmo')).toHaveCount(1);

    const before = await clipTransform(editor.page, seed.clipAId);
    const cursorBefore = (await editor.state()).cursor;

    const geo = await gizmoGeometry(editor.page);
    await expectBoxIsCompRect(editor.page, geo);
    const box = boxSize(geo);
    const dragPx = 140;
    await beginDrag(editor.page, geo.centre, { x: geo.centre.x + dragPx, y: geo.centre.y + 60 });

    // Ön koşul: jest GERÇEKTEN canlı olmalı, yoksa "Escape çalıştı" iddiası
    // hiçbir şey kanıtlamaz (hiç başlamamış bir sürüklemeyi iptal etmek kolay).
    // Ön koşul da NİCEL: yazılan miktar sürüklenen mesafeye eşit olmalı, yoksa
    // "canlı" dediğimiz şey bambaşka bir şey olabilir.
    const during = await clipTransform(editor.page, seed.clipAId);
    expect(
      Math.abs(during.x - (before.x + dragPx / box.w)),
      'Escape testinin anlamlı olması için sürükleme TAM sürüklenen kadar yazıyor olmalı.',
    ).toBeLessThan(TOLERANCE_PX / box.w);
    expect(await transactionOpen(editor.page), 'Sürükleme bir transaction açmalı.').toBe(true);

    await editor.page.keyboard.press('Escape');
    await editor.page.waitForTimeout(150);

    const afterEsc = await clipTransform(editor.page, seed.clipAId);
    expect(afterEsc.x, 'Escape sürüklemeyi TAM olarak geri almalı.').toBe(before.x);
    expect(afterEsc.y).toBe(before.y);
    expect(afterEsc.scale).toBe(before.scale);
    expect(await transactionOpen(editor.page), 'İptal transaction\'ı KAPATMALI.').toBe(false);
    expect(
      (await editor.state()).cursor,
      'İptal edilen jest geçmişte iz bırakmamalı.',
    ).toBe(cursorBefore);

    // Fare HÂLÂ basılı. Bırakmak yeni bir yazma başlatmamalı ve iptal edilen
    // jesti diriltmemeli.
    await editor.page.mouse.move(geo.centre.x + 220, geo.centre.y + 90, { steps: 6 });
    await editor.page.mouse.up();
    await editor.page.waitForTimeout(200);

    expect(
      (await clipTransform(editor.page, seed.clipAId)).x,
      'İptalden sonraki hareket/bırakma dokümana dokunmamalı.',
    ).toBe(before.x);
    expect((await editor.state()).cursor).toBe(cursorBefore);
    expect(await transactionOpen(editor.page)).toBe(false);
    expect(
      await isPlaying(editor.page),
      'İptal edilen sürüklemenin bırakma tıklaması oynatmayı başlatmamalı.',
    ).toBe(false);
  });

  test('sürükleme ortasında Space: kutu kaybolsa da jest KAPANIR (gerçek klavye)', async ({
    editor,
    seed,
  }) => {
    // M4 denetimi (yüksek): pointerdown transaction açıyor, ama SVG koşullu
    // render ediliyor. Space oynatmayı başlatınca gizmo DOM'dan gidiyor,
    // pointerup ona ULAŞAMIYOR ve transaction sonsuza dek açık kalıyordu:
    // autosave duruyor, sonraki her mutate/undo THROW ediyordu. Bu test tam o
    // sırayı gerçek fare + gerçek klavyeyle koşar.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(editor.page.getByTestId('player-gizmo')).toHaveCount(1);

    const before = await clipTransform(editor.page, seed.clipAId);
    const cursorBefore = (await editor.state()).cursor;

    const geo = await gizmoGeometry(editor.page);
    await beginDrag(editor.page, geo.centre, { x: geo.centre.x + 140, y: geo.centre.y + 50 });
    expect(await transactionOpen(editor.page), 'Sürükleme bir transaction açmalı.').toBe(true);

    // GERÇEK klavye: Space oynatmayı başlatır -> hareket eden hedef -> kutu gider.
    await editor.page.keyboard.press('Space');
    await expect
      .poll(() => isPlaying(editor.page), { message: 'Space oynatmayı başlatmalıydı.' })
      .toBe(true);
    await expect(
      editor.page.getByTestId('player-gizmo'),
      'Oynatırken gizmo gizlenmeli (hatanın ön koşulu).',
    ).toHaveCount(0);

    // Bırakma artık gizmo'ya DEĞİL, altındaki sahneye gidiyor.
    await editor.page.mouse.up();
    await editor.page.waitForTimeout(250);

    expect(
      await transactionOpen(editor.page),
      'Yarıda kesilen jest transaction\'ı AÇIK bırakmamalı — açık kalırsa autosave durur ve sonraki her mutate/undo patlar.',
    ).toBe(false);
    expect(
      (await clipTransform(editor.page, seed.clipAId)).x,
      'Kullanıcının bitiremediği jest iptal edilmeli (sürükleme öncesi durum).',
    ).toBe(before.x);
    expect(
      (await editor.state()).cursor,
      'Yarım jest geçmişe girmemeli.',
    ).toBe(cursorBefore);

    // ---- ASIL İDDİA: store hâlâ KULLANILABİLİR ----
    await ensurePaused(editor.page);
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    await expect(editor.page.getByTestId('player-gizmo')).toHaveCount(1);

    const geo2 = await gizmoGeometry(editor.page);
    const box2 = boxSize(geo2);
    const dragPx = 110;
    await dragMouse(editor.page, geo2.centre, { x: geo2.centre.x + dragPx, y: geo2.centre.y });
    const after = await clipTransform(editor.page, seed.clipAId);
    expect(
      Math.abs(after.x - (before.x + dragPx / box2.w)),
      'Yarıda kesilen jestten SONRA yeni sürükleme TAM sürüklenen kadar yazmalı ' +
        '(beginTransaction patlamamalı, yarım jestin kalıntısı da eklenmemeli).',
    ).toBeLessThan(TOLERANCE_PX / box2.w);
    expect(after.y, 'Yatay sürükleme dikey konuma dokunmamalı.').toBe(before.y);
    expect(
      (await editor.state()).cursor - cursorBefore,
      'Yalnızca ikinci (tamamlanmış) sürükleme geçmişe girmeli.',
    ).toBe(1);

    // Undo da açık transaction'da THROW ediyordu — gerçek klavyeyle doğrula.
    await editor.page.keyboard.press('Control+z');
    await editor.page.waitForTimeout(200);
    expect(
      (await clipTransform(editor.page, seed.clipAId)).x,
      'Geri al çalışmalı (açık transaction undo\'yu da patlatıyordu).',
    ).toBe(before.x);
    expect((await editor.state()).cursor).toBe(cursorBefore);
  });

  test('kutunun DIŞINA tıklamak hâlâ oynat/duraklat yapar (gizmo tıklamayı yutmaz)', async ({
    editor,
    seed,
  }) => {
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));
    await editor.timeline.scrubTo(INSIDE_CLIP_A_US);
    const geo = await gizmoGeometry(editor.page);
    const historyBefore = (await editor.state()).cursor;

    // Sahnenin içi, kutunun dışı (letterbox bandı) — gerçek geometriden.
    const outside = outsideBoxPoint(geo);
    await editor.page.mouse.move(outside.x, outside.y);
    await editor.page.mouse.down();
    await editor.page.mouse.up();
    await editor.page.waitForTimeout(200);

    // Oynatma denemesi doküman DEĞİŞTİRMEZ; asıl iddia: tıklama yutulmadı,
    // yani transport durumu ya oynuyor ya da (autoplay engeli varsa) "engellendi"
    // ipucu gösteriliyor — her iki durumda da doküman ve geçmiş el değmemiş.
    expect((await editor.state()).cursor, 'Boş alana tıklama doküman değiştirmemeli.').toBe(
      historyBefore,
    );
    const playing = await isPlaying(editor.page);
    const blockedHint = await editor.page.getByText(/Oynatmak için tıklayın/i).count();
    expect(
      playing || blockedHint > 0,
      'Gizmo açıkken kutunun dışına tıklamak oynatmayı tetiklemeli (ya da autoplay engeli ipucunu göstermeli).',
    ).toBe(true);
  });
});
