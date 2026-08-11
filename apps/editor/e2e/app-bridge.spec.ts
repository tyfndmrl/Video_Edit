/**
 * Store köprüsünün KENDİSİNİN testi.
 *
 * NEDEN (M4 denetimi, yüksek bulgu): bu depodaki UI kanıtının tamamı — gerçek
 * fareyle yapılan her jestin SONUCU — store'lardan okunuyor. O okuma yanlış
 * modül örneğine bağlanırsa elde kanıt kalmaz. Eski köprü tek bir dolaylı ize
 * dayanıyordu: tarayıcının Resource Timing tamponundan uygulamanın yüklediği
 * `/src/state/docStore.ts?t=...` URL'sini bulmak. O tampon VARSAYILAN 250
 * kayıtta dolar (denetçi ölçtü: 250'de sabit, 135 kez 'resourcetimingbufferfull')
 * ve kayıt düşerse köprü damgasız yola dönüp BOŞ bir store okur.
 *
 * Buradaki testler üç şeyi kanıtlar:
 *  1. Köprü BİRİNCİL katmandan kuruluyor (uygulamanın DEV kancası) ve o kanca
 *     uygulamanın GERÇEKTEN kullandığı store örneğini veriyor.
 *  2. Resource Timing tamponu kaybolsa/dolsa bile köprü ayakta kalıyor
 *     (kanca yoksa tampondan bağımsız PerformanceObserver kaydı devreye giriyor).
 *  3. Kopma SESSİZ YEŞİL olamıyor: ölü bir köprü anında ve gerekçesiyle kırmızı.
 */
import { test, expect } from './fixtures/test';
import { findClip, installAppBridge, resetAppBridge, bridgeSource } from './support/appBridge';

/** Sayfa içinden kancayı okuyan yardımcılar (test tarafında tip gürültüsü olmasın). */
interface HookShape {
  version: number;
  docStore: { getState(): { doc: { tracks: { clips: { id: string }[] }[] } } };
  editorStore: { getState(): { selection: Set<string> } };
  projectSession: { getState(): { status: string } };
}

test.describe('appBridge — kanıtın kanıtı', () => {
  test('köprü BİRİNCİL katmandan kurulur (uygulamanın DEV test kancası)', async ({ editor }) => {
    expect(
      editor.bridgeSource,
      'Köprü uygulamanın kancasından kurulmalı; tarayıcı tamponuna düşmek 250 kayıtlık ' +
        'bir sınırın arkasına saklanmaktır.',
    ).toBe('app-hook');
    expect(await bridgeSource(editor.page)).toBe('app-hook');

    const hook = await editor.page.evaluate(() => {
      const h = (window as unknown as { __videoeditTest?: { version?: number } }).__videoeditTest;
      return h ? { version: h.version ?? null } : null;
    });
    expect(hook, 'window.__videoeditTest DEV\'de var olmalı (src/state/testBridge.ts).').not.toBeNull();
    expect(hook?.version, 'Sözleşme sürümü uyuşmazsa köprü kancayı reddeder.').toBe(1);
  });

  test('kanca uygulamanın GERÇEKTEN kullandığı store örneğini verir (canlı okuma)', async ({
    editor,
    seed,
  }) => {
    // Gerçek fare ile seç — sonucu KANCADAN (window.__ve'den değil) oku.
    await editor.timeline.click(await editor.timeline.clipCenter(seed.clipAId));

    const live = await editor.page.evaluate(() => {
      const h = (window as unknown as { __videoeditTest: HookShape }).__videoeditTest;
      return {
        selection: [...h.editorStore.getState().selection],
        status: h.projectSession.getState().status,
        clipIds: h.docStore
          .getState()
          .doc.tracks.flatMap((t) => t.clips.map((c) => c.id)),
      };
    });

    expect(
      live.selection,
      'Kanca ayrı bir modül örneğine bağlıysa seçim burada BOŞ görünürdü.',
    ).toEqual([seed.clipAId]);
    expect(live.status).toBe('ready');
    expect(live.clipIds).toContain(seed.clipAId);
    expect(live.clipIds).toContain(seed.clipBId);
  });

  test('Resource Timing kayıtları TAMAMEN kaybolsa da köprü kurulur (1. savunma yeter)', async ({
    editor,
    seed,
  }) => {
    // Tamponun dolup ilgili kaydı düşürdüğü durumun en sert hali: hepsini sil
    // ve tamponu kapat. Gözlemci kaydını da sil ki YALNIZ kanca kalsın.
    await editor.page.evaluate(() => {
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(0);
      delete (window as unknown as Record<string, unknown>).__veModuleUrls;
    });
    await resetAppBridge(editor.page);

    const source = await installAppBridge(editor.page, { timeoutMs: 10_000 });
    expect(source).toBe('app-hook');

    // Köprü hâlâ CANLI: seed dokümanı okunuyor.
    const state = await editor.state();
    expect(state.sessionStatus).toBe('ready');
    expect(findClip(state, seed.clipAId).clip.timelineStartUs).toBeGreaterThan(0);
  });

  test('kanca YOKKEN bile tampon kaybı köprüyü kırmaz (2. savunma: gözlemci kaydı)', async ({
    editor,
    seed,
  }) => {
    // Kancayı kaldır -> köprü modül grafiği yoluna düşmek zorunda.
    // Tampondaki kayıtları da sil -> eski (tek) yol artık ÇALIŞAMAZ.
    await editor.page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__videoeditTest;
      performance.clearResourceTimings();
    });
    await resetAppBridge(editor.page);

    const source = await installAppBridge(editor.page, { timeoutMs: 15_000 });
    expect(
      source,
      'Tampon boşken bile gözlemcinin kaydettiği HMR damgalı URL kullanılmalı.',
    ).toBe('observer-url');

    const state = await editor.state();
    expect(state.sessionStatus).toBe('ready');
    expect(findClip(state, seed.clipBId).clip.timelineDurationUs).toBeGreaterThan(0);
  });

  test('tampon 250 kayıtta DONMAZ ve dolsa bile modül URL\'si korunur', async ({ editor }) => {
    // Denetçinin ölçtüğü sayı buydu: varsayılan tampon 250 kayıtta sabitleniyor.
    // Init script tamponu büyüttüğü için 250'yi aşabilmeliyiz; aşamıyorsak
    // ayar geri alınmış demektir ve köprü yine tek dolaylı ize kalır.
    const before = await editor.page.evaluate(
      () => performance.getEntriesByType('resource').length,
    );
    const added = await editor.page.evaluate(async () => {
      const jobs: Promise<unknown>[] = [];
      for (let i = 0; i < 320; i++) {
        jobs.push(fetch(`/index.html?ve-probe=${i}`).then((r) => r.text()).catch(() => null));
      }
      await Promise.all(jobs);
      return performance.getEntriesByType('resource').length;
    });

    expect(added).toBeGreaterThan(before);
    expect(
      added,
      'Kayıt sayısı 250\'de takılıyorsa setResourceTimingBufferSize devre dışı kalmış demektir.',
    ).toBeGreaterThan(250);

    const recorded = await editor.page.evaluate(() => {
      const urls = (window as unknown as { __veModuleUrls?: Record<string, string> })
        .__veModuleUrls;
      return urls?.['/src/state/docStore.ts'] ?? null;
    });
    expect(
      recorded,
      'Gözlemci kaydı tampondan bağımsızdır: 320 yeni istek sonrası da durmalı.',
    ).not.toBeNull();
    expect(recorded).toContain('/src/state/docStore.ts');
  });

  test('ÖLÜ köprü SESSİZCE kabul edilmez (yanlış store\'a bağlanmak anında kırmızı)', async ({
    editor,
  }) => {
    // Sözleşmeye uyan ama BOŞ store'lar sunan sahte bir kanca: eski kurulum
    // bunu memnuniyetle kabul eder, sonraki her test "proje hazır olmadı" diye
    // opak biçimde düşerdi. Artık kurulum kendisi patlar ve NEDENİNİ söyler.
    await editor.page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__videoeditTest = {
        version: 1,
        docStore: { getState: () => ({ doc: { tracks: [] }, history: [], cursor: 0 }) },
        editorStore: {
          getState: () => ({
            pxPerUs: 0.0001,
            scrollUs: 0,
            playheadUs: 0,
            selection: new Set<string>(),
            snappingEnabled: true,
          }),
        },
        projectSession: { getState: () => ({ status: 'idle', projectId: null }) },
      };
    });
    await resetAppBridge(editor.page);

    await expect(
      installAppBridge(editor.page, { timeoutMs: 3_000 }),
      'Boş bir store\'a bağlanmak kabul edilmemeli.',
    ).rejects.toThrow(/ÖLÜ/);
  });
});
