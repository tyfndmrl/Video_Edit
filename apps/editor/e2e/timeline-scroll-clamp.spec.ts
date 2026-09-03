/**
 * Dikey kaydırma kelepçesi — SINIR DEĞİŞTİĞİNDE (panel-2a).
 *
 * Kusur (keşifte ölçüldü): `scrollY` yalnız İKİ jestte yazılıyordu (wheel +
 * orta-tuş pan) ve üst sınır formülü ikisine kopyalanmıştı. Track sayısı ya da
 * gövde yüksekliği değişince scrollY YENİDEN kelepçelenmiyordu; kullanıcı
 * aşağı kaydırıp track'leri geri aldığında (Ctrl+Z) eski scrollY sınırın
 * dışında kalıyor, iki şey birden bozuluyordu:
 *   (a) GÖRÜNTÜ — başlık kolonu ve canvas gövdesi yukarıda takılı kalıyor,
 *       altta boş şerit görünüyordu,
 *   (b) HIT-TEST — `contentY = y - RULER_H + scrollY` bayat scrollY ile
 *       hesaplandığı için tıklama BAŞKA bir satıra düşüyordu (kullanıcı
 *       kliplere tıklıyor, hiçbir şey seçilmiyordu).
 *
 * Bu dosya ikisini de GERÇEK girdiyle ölçer: `+V` düğmesine gerçek tıklama,
 * gerçek wheel, gerçek Ctrl+Z, gerçek fare tıklaması. Kelepçe yalnız jestin
 * içinde kalırsa (a) ve (b) kırmızı düşer.
 *
 * Piksel beklentileri uygulamanın KENDİ geometry modülünden türetilir —
 * testte ikinci bir düzen aritmetiği yoktur.
 */
import { test, expect } from './fixtures/test';
import { RULER_H, tracksContentHeight } from '../src/features/timeline/geometry';

/** Kaydırmayı gövdenin dibine götürmeye fazlasıyla yeten wheel miktarı. */
const WHEEL_TO_BOTTOM_PX = 1200;

test.describe('Timeline dikey kaydırma kelepçesi', () => {
  test('track sayısı azalınca (Ctrl+Z) scrollY yeniden kelepçelenir: kolon hizası + hit-test', async ({
    editor,
    seed,
  }) => {
    const page = editor.page;
    const timeline = editor.timeline;
    await editor.ensureContentVisible(seed.clipAId);

    const wrap = await timeline.wrapBox();
    // Uygulama viewport'u TAM SAYIYA yuvarlar (measure(): Math.floor(rect.height));
    // sınır beklentisi de aynı sayıdan türetilmeli, yoksa yarım piksellik bir
    // fark testi kelepçeden bağımsız olarak kırmızıya düşürür.
    const bodyH = Math.floor(wrap.height) - RULER_H;
    const before = await editor.state();
    expect(before.tracks.length, 'seed 2 track ile başlar').toBe(2);

    // ÖN KOŞUL 1: 2 track'lik belgede içerik gövdeye SIĞAR (kaydıracak bir şey
    // yok). Sığmasaydı Ctrl+Z sonrası sınır 0'a düşmezdi ve test boşa çıkardı.
    expect(
      tracksContentHeight(2),
      `2 track'lik içerik gövdeye sığmalı (gövde ${bodyH.toFixed(1)} px).`,
    ).toBeLessThanOrEqual(bodyH);

    // Üç track ekle (gerçek tıklama) -> içerik gövdeyi aşar.
    const addVideoTrack = page.locator('button[title="Video track ekle"]');
    for (let i = 0; i < 3; i++) {
      await addVideoTrack.click();
      await page.waitForTimeout(80);
    }
    const grown = await editor.state();
    expect(grown.tracks.length).toBe(5);

    const maxScroll = tracksContentHeight(5) - bodyH;
    // ÖN KOŞUL 2: 5 track'lik içerik gerçekten taşıyor.
    expect(maxScroll, '5 track içerik gövdeyi aşmalı (aksi halde test boş).').toBeGreaterThan(20);

    // Başlık kolonu canvas ile aynı scrollY'yi kullanır (translateY):
    // scrollY = (sarmalayıcı üstü + RULER_H) - ilk başlığın üstü.
    const observedScrollY = async (): Promise<number> =>
      wrap.y + RULER_H - (await timeline.trackHeaderTop(0));

    expect(await observedScrollY(), 'başlangıçta kaydırma yok').toBeCloseTo(0, 0);

    // Gerçek wheel ile dibe kaydır.
    await timeline.wheel(WHEEL_TO_BOTTOM_PX);
    const scrolled = await observedScrollY();
    // ÖN KOŞUL 3: wheel gerçekten kaydırdı ve SINIRDA durdu.
    expect(
      scrolled,
      `Wheel kaydırması sınıra oturmadı (beklenen ${maxScroll.toFixed(1)} px).`,
    ).toBeCloseTo(maxScroll, 0);

    // Üç Ctrl+Z: eklenen track'ler geri gider, üst sınır 0'a düşer.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(120);
    }
    const undone = await editor.state();
    expect(undone.tracks.length, 'Ctrl+Z x3 belgeyi 2 track\'e döndürmeli').toBe(2);

    // (a) GÖRÜNTÜ: kelepçe yeniden çalıştıysa kolon tepeye oturmuştur.
    // `soft`: bu iddia düşse bile (b) hit-test iddiası KOŞSUN — kusurun iki
    // yüzü (görüntü + tıklama hedefi) tek koşumda birlikte raporlansın.
    expect.soft(
      await timeline.trackHeaderTop(0),
      `Track başlığı kolonu bayat scrollY (${scrolled.toFixed(1)} px) ile yukarıda takılı ` +
        'kaldı: sınır küçüldüğünde scrollY yeniden kelepçelenmiyor (altta boş şerit).',
    ).toBeCloseTo(wrap.y + RULER_H, 0);

    // (b) HIT-TEST: satır 0'daki klibe GERÇEK tıklama doğru klibi seçer.
    // Bayat scrollY ile aynı piksel contentY'de bir satır aşağıya düşer ve
    // hiçbir klibe denk gelmez (seçim temizlenir).
    const state = await editor.state();
    const clip = state.tracks[0].clips.find((c) => c.id === seed.clipAId);
    expect(clip, 'clipA ilk track\'te olmalı').toBeDefined();
    const midUs = clip!.timelineStartUs + clip!.timelineDurationUs / 2;
    await timeline.click(await timeline.point(midUs, 0, state));

    expect(
      (await editor.state()).selection,
      'Satır 0\'daki klibe tıklandı ama seçim beklenen klip değil: hit-test bayat ' +
        'scrollY yüzünden başka satıra düşüyor.',
    ).toEqual([seed.clipAId]);
  });
});
