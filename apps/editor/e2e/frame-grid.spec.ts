/**
 * Kare ızgarası uçtan uca — GERÇEK fare + GERÇEK klavye ile bölünen klip
 * GERÇEKTEN dışa aktarılabiliyor mu?
 *
 * Teslim değerlendirmesinde bulunan kusur tam olarak buydu ve birim testlerin
 * hiçbiri göremezdi: derleyici klibin SÜRESİNİN ızgarada olmasını istiyordu,
 * editör ise KENARLARI ızgaraya oturtuyordu. 30 fps'te (VARSAYILAN proje hızı)
 * ikisi aynı anda sağlanamaz — frame 1 = 33_333 µs, frame 2 = 66_667 µs, yani
 * bir karelik klip 33_334 µs sürer ve bu değer ızgarada YOKTUR. Sonuç:
 * kullanıcı klibi böler, doküman sorunsuz kaydedilir (PUT 200), export
 * "frame grid'inde değil" diye 422 döner.
 *
 * Bu test o zinciri baştan sona kurar:
 *   1. cetvelde gerçek fareyle scrub + ok tuşlarıyla TAM kare hizalama,
 *   2. sağ tık menüsünden iki kez "Playhead'de böl",
 *   3. ortaya çıkan klibin SÜRESİ ızgara dışı (eski kapının reddettiği belge),
 *      KENARLARI ızgarada (yeni kapının istediği belge) — iddia edilir,
 *   4. "Dışa Aktar" diyaloğundan gerçek istek: POST .../exports 202 olmalı.
 *      Bu uç nokta ExportCompiler.Validate'i SENKRON çağırır (422'yi orada
 *      döner), dolayısıyla 202 = derleyici bu belgeyi kabul etti demektir.
 */
import { isOnFrameGrid, usToFrame, type Rational } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { findClip, readProjectSettings, type AppState } from './support/appBridge';
import { SECOND_US } from './fixtures/seed';

/** Bir track'teki klipleri başlangıca göre sıralı verir. */
function clipsOf(state: AppState, trackIndex = 0): AppState['tracks'][number]['clips'] {
  return [...state.tracks[trackIndex].clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
}

test.describe('Kare ızgarası — bölünen klip dışa aktarılabilir', () => {
  test.beforeEach(async ({ editor, seed }) => {
    await editor.ensureContentVisible(seed.clipAId);
  });

  test('gerçek fareyle iki kez bölünen klip export isteğinde 202 alır (422 DEĞİL)', async ({
    editor,
    seed,
  }) => {
    test.setTimeout(120_000);
    const settings = await readProjectSettings(editor.page);
    const fps: Rational = settings.fps;
    const before = await editor.state();
    const clipA = findClip(before, seed.clipAId).clip;

    // --- 1. playhead'i klibin ortasına GERÇEK fareyle taşı ---
    await editor.timeline.scrubTo(clipA.timelineStartUs + 2 * SECOND_US);
    let st = await editor.state();
    expect(st.playheadUs).toBeGreaterThan(clipA.timelineStartUs);
    expect(st.playheadUs).toBeLessThan(clipA.timelineStartUs + clipA.timelineDurationUs);

    /**
     * Kare hizalama GERÇEK klavyeyle: ok tuşu tam bir proje karesi adımlar
     * (shortcuts/dispatcher). Hedef, klibin başlangıç karesinden AŞAĞIDAKİ
     * kalıntıya sahip bir kare — 30 fps'te ızgara deseni 3 karede bir tekrar
     * eder (100_000 µs), yani ilk bölmenin ikinci yarısı "faz dışı" bir karede
     * başlasın diye kalıntının 0 OLMAMASI gerekir. Tek fare tıklamasıyla bunu
     * hedeflemek imkânsızdır: bu yakınlıkta bir kare ~3 pikseldir.
     */
    const startFrame = usToFrame(clipA.timelineStartUs, fps);
    for (let guard = 0; guard < 4; guard++) {
      st = await editor.state();
      if ((usToFrame(st.playheadUs, fps) - startFrame) % 3 === 1) break;
      await editor.page.keyboard.press('ArrowRight');
      await editor.page.waitForTimeout(60);
    }
    st = await editor.state();
    expect(
      (usToFrame(st.playheadUs, fps) - startFrame) % 3,
      'Playhead ok tuşlarıyla istenen kareye hizalanamadı.',
    ).toBe(1);

    // --- 2. ilk bölme: sağ tık > "Playhead'de böl" ---
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId, st), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.contextMenuItem(/playhead.?de b[öo]l/i).click();
    await editor.page.waitForTimeout(150);

    st = await editor.state();
    expect(st.clipCount, 'İlk bölme klip sayısını artırmalı.').toBe(before.clipCount + 1);
    const cutUs = st.playheadUs;
    const secondHalf = clipsOf(st).find((c) => c.timelineStartUs === cutUs);
    expect(secondHalf, 'Bölmenin ikinci yarısı playhead\'de başlamalı.').toBeDefined();

    // --- 3. bir kare ileri + ikinci bölme: TAM BİR KARELİK klip ---
    await editor.page.keyboard.press('ArrowRight');
    await editor.page.waitForTimeout(60);
    st = await editor.state();
    expect(st.playheadUs).toBeGreaterThan(cutUs);

    await editor.timeline.click(await editor.timeline.clipCenter(secondHalf!.id, st), 'right');
    await expect(editor.contextMenu).toBeVisible();
    await editor.contextMenuItem(/playhead.?de b[öo]l/i).click();
    await editor.page.waitForTimeout(150);

    st = await editor.state();
    expect(st.clipCount, 'İkinci bölme de klip sayısını artırmalı.').toBe(before.clipCount + 2);

    // --- 4. üretilen belge: SÜRE ızgara dışı, KENARLAR ızgarada ---
    const oneFrameClip = clipsOf(st).find((c) => c.id === secondHalf!.id);
    expect(oneFrameClip, 'Bir karelik klip dokümanda olmalı.').toBeDefined();
    expect(
      usToFrame(oneFrameClip!.timelineStartUs + oneFrameClip!.timelineDurationUs, fps) -
        usToFrame(oneFrameClip!.timelineStartUs, fps),
      'İki bölme arasında tam 1 kare kalmalıydı.',
    ).toBe(1);
    expect(
      isOnFrameGrid(oneFrameClip!.timelineDurationUs, fps),
      'Bu senaryonun anlamı SÜRENİN ızgara dışı olmasıdır — eski kapı tam olarak bunu ' +
        'reddediyordu. Süre ızgaradaysa test yanlış kareyi hedeflemiştir.',
    ).toBe(false);
    for (const clip of clipsOf(st)) {
      expect(isOnFrameGrid(clip.timelineStartUs, fps), `klip ${clip.id} başlangıcı`).toBe(true);
      expect(
        isOnFrameGrid(clip.timelineStartUs + clip.timelineDurationUs, fps),
        `klip ${clip.id} bitişi`,
      ).toBe(true);
    }

    // --- 5. GERÇEK export isteği: 202 (422 değil) ---
    const openExport = editor.page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();
    const dialog = editor.page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const responsePromise = editor.page.waitForResponse(
      (res) => res.url().includes('/exports') && res.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    const response = await responsePromise;
    const body = await response.text();

    // Ayakta olan API ESKİ derlemeyse hata mesajı bunu ele verir: "is not
    // aligned to the project frame grid" metni artık kaynakta YOKTUR (yeni kapı
    // "edges are not on the project frame grid" der). Teşhisi testin içine
    // yazıyoruz ki kırmızı bir koşum "kod bozuk" gibi okunmasın.
    const staleApi = body.includes('is not aligned to the project frame grid');
    expect(
      response.status(),
      staleApi
        ? 'API ESKİ derlemeyi koşuyor (hata metni kaynakta artık yok). ' +
          'ExportCompiler.cs değişti — API yeniden başlatılmalı.'
        : `Export isteği ${response.status()} döndü: ${body}`,
    ).toBe(202);
    // Diyalog kapanır; içeride kırmızı bir 422 mesajı kalmaz.
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });
});
