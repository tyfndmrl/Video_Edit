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
import { frameToUs, isOnFrameGrid, usToFrame, type Rational } from '@videoedit/timeline-schema';
import { test, expect } from './fixtures/test';
import { findClip, readProjectSettings, type AppState } from './support/appBridge';
import { SECOND_US } from './fixtures/seed';
import { EditorApp } from './support/editor';
import { LibraryPanelHarness, listProjectAssets } from './support/library';
import { ensureMisalignedVideo, FFMPEG_SKIP_REASON, ffmpegVersion } from './support/media';
import { createEmptyProject } from './support/projects';

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

/**
 * İkinci sınıf: KAYNAK SÜRESİ ızgara dışı olan GERÇEK medya.
 *
 * Yukarıdaki test bölmeyle üretilen ızgara dışı SÜREYİ kapsıyor; kapsamadığı
 * şey kırpmanın KAYNAK SINIRINA dayandığı an. Sağ tutamak kaynağın sonuna
 * kadar çekildiğinde klibin kenarı artık kullanıcının bıraktığı yere değil,
 * KAYNAĞIN süresine oturur — ve gerçek dosyaların süresi kare hizalı değildir
 * (ffprobe: 7.320000 sn). Takımdaki bütün fixture'lar kare hizalıydı (4 sn, 6
 * sn, 10 sn), yani 1134 birim + 125 e2e testinin hiçbiri bu sınıfa dokunmuyordu:
 * sınır zaten ızgaradaydı.
 *
 * Bu test o boşluğu GERÇEK yoldan kapatır: gerçek dosya -> gerçek yükleme ->
 * gerçek worker -> gerçek fare sürüklemesi (önce içeri, sonra kaynağın
 * ötesine) -> gerçek POST /exports. Beklenen 202; kusur yaşarken bu istek 422
 * döner ("edges are not on the project frame grid").
 */
test.describe('Kare ızgarası — ızgara DIŞI süreli GERÇEK kaynak', () => {
  test('sağ tutamak kaynağın sonuna kadar çekilince kenarlar ızgarada kalır ve export 202 alır', async ({
    page,
    account,
  }) => {
    test.skip(ffmpegVersion() === null, FFMPEG_SKIP_REASON);
    // Yükleme + worker işleme + iki sürükleme + export isteği.
    test.setTimeout(420_000);

    // Süresi ölçülmüş (tahmin edilmemiş) ızgara dışı kaynak.
    const video = ensureMisalignedVideo();
    const project = await createEmptyProject(
      account.context.request,
      account.accessToken,
      'E2E ızgara dışı kaynak',
    );

    /**
     * Belge kapısı (docStore.assertDocGateDev) DEV sunucusunda CANLIDIR ve
     * ihlalde pointer handler'ının içinden fırlar. Sayfa hatalarını topluyoruz
     * ki kapı sürükleme sırasında ateşlerse test bunu SÖYLESİN — aksi halde
     * ihlal yalnız konsola düşer ve sessiz kalır.
     */
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    const app = new EditorApp(page);
    await app.open(project.projectId, { email: account.email, password: account.password });
    const library = new LibraryPanelHarness(page);

    /**
     * KANARYA: kapı BU tarayıcı derlemesinde gerçekten çalışıyor mu?
     *
     * Kapı `import.meta.env.DEV` arkasındadır. DEV kapalı olsaydı aşağıdaki
     * "hiç ihlal görülmedi" iddiası bedavaya yeşil olurdu — kapı hiç
     * koşmadığı için. Bu yüzden sayfanın içinde, ATILACAK bir dokümanla
     * (gerçek belgeye dokunmadan) kapının fırlattığı doğrulanır.
     */
    const gateProbe = await page.evaluate(async () => {
      const w = window as unknown as { __veModuleUrls?: Record<string, string> };
      const url = w.__veModuleUrls?.['/src/state/docStore.ts'] ?? '/src/state/docStore.ts';
      const mod = (await import(/* @vite-ignore */ url)) as {
        assertDocGateDev?: (d: unknown, ctx: string) => void;
        createEmptyDoc?: (id: string, s: unknown) => Record<string, unknown>;
        defaultProjectSettings?: unknown;
      };
      if (typeof mod.assertDocGateDev !== 'function') return 'kapı fonksiyonu dışa aktarılmamış';
      const base = mod.createEmptyDoc!('01890000-0000-7000-8000-000000000000', {
        ...(mod.defaultProjectSettings as object),
      });
      // 30 fps'te 3_000_040 µs bir kare sınırı DEĞİLDİR (kare 90 = 3_000_000).
      const doc = {
        ...base,
        tracks: [
          {
            id: '01890000-0000-7000-8000-0000000000a0',
            type: 'video',
            name: 'V1',
            muted: false,
            hidden: false,
            locked: false,
            clips: [
              {
                id: '01890000-0000-7000-8000-0000000000c0',
                kind: 'video',
                assetId: '01890000-0000-7000-8000-0000000000e0',
                timelineStartUs: 1_000_000,
                timelineDurationUs: 2_000_040,
                sourceInUs: 0,
                sourceOutUs: 2_000_040,
                speed: { rate: 1 },
                audio: { volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false },
                transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
                keyframes: {},
                effects: [],
                opacity: 1,
              },
            ],
          },
        ],
      };
      try {
        mod.assertDocGateDev(doc, 'kanarya');
        return 'FIRLAMADI';
      } catch (e) {
        return (e as Error).message.slice(0, 80);
      }
    });
    expect(
      gateProbe,
      'Belge kapısı bu derlemede ÇALIŞMIYOR — aşağıdaki "ihlal görülmedi" iddiası ' +
        'anlamsız olurdu.',
    ).toContain('Export frame-grid violation');

    // --- 1. gerçek medya: dosya seçici -> yükleme -> worker ---
    await library.pickFiles([video.path]);
    await library.waitForReady(video.fileName);

    const settings = await readProjectSettings(page);
    const fps: Rational = settings.fps;
    const assets = await listProjectAssets(
      account.context.request,
      account.accessToken,
      project.projectId,
    );
    const asset = assets.find((a) => a.fileName === video.fileName);
    expect(asset, 'Yüklenen asset sunucu listesinde yok.').toBeTruthy();
    expect(asset!.status).toBe('ready');
    const assetDurationUs = asset!.durationMicros ?? 0;

    // Fixture'ın ANLAMI: sunucunun ölçtüğü süre de ızgara dışı olmalı. (Aynı
    // değeri yerelde ffprobe ile ölçtük; ikisi ayrışırsa test yanlış şeyi
    // kanıtlıyor demektir.)
    expect(assetDurationUs, 'Sunucu ve yerel ffprobe farklı süre ölçtü.').toBe(video.durationUs);
    expect(
      isOnFrameGrid(assetDurationUs, fps),
      `Kaynak süresi (${assetDurationUs} µs) proje ızgarasına DENK GELDİ — bu testin ` +
        'kapsadığı sınıf tam olarak bunun tersiydi (bkz. support/media.ts).',
    ).toBe(false);

    // --- 2. timeline'a ekle (gerçek çift tık) ---
    await library.doubleClickAsset(video.fileName);
    await expect
      .poll(async () => (await app.state()).clipCount, {
        timeout: 15_000,
        message: 'Çift tık sonrası timeline\'a klip eklenmedi.',
      })
      .toBe(1);

    const st = await app.state();
    const clipId = st.tracks.flatMap((t) => t.clips)[0].id;
    const startUs = findClip(st, clipId).clip.timelineStartUs;

    /**
     * `timeUs` canvas'ın İÇİNDE kalana kadar GERÇEK Ctrl+tekerlek ile uzaklaş.
     *
     * Neden EditorApp.ensureContentVisible değil: o yardımcı, içerik ekrana
     * sığmıyorsa "Sığdır" düğmesine basar — ama düğmenin erişilebilir adı
     * "Fit"tir (title="Sığdır (Shift+Z)", metin "Fit"), yani locator hiç
     * eşleşmez ve 15 sn sonra düşer. Diğer testlerde bu dal hiç çalışmadığı
     * için (açılıştaki auto-fit zaten yetiyor) fark edilmemişti. Burada
     * gereken şey zaten kırpma hedefinin GÖRÜNÜR olması, o da gerçek fare
     * jestiyle sağlanır.
     */
    const ensureTimeVisible = async (timeUs: number): Promise<void> => {
      for (let guard = 0; guard < 8; guard++) {
        const zoomState = await app.state();
        const wrap = await app.timeline.wrapBox();
        const targetX = wrap.x + (timeUs - zoomState.scrollUs) * zoomState.pxPerUs;
        if (targetX <= wrap.x + wrap.width - 40) return;
        await app.timeline.ctrlWheel(240); // uzaklaş (1/1.2)
      }
      throw new Error(`${timeUs} µs 8 zoom adımında da ekrana getirilemedi.`);
    };

    // Kırpmanın gideceği EN UZAK nokta baştan görünür olsun: hedef, kaynağın
    // sonundan da ileride (sınırın ötesine çekeceğiz).
    const beyondSourceUs = startUs + assetDurationUs + 2 * SECOND_US;
    await ensureTimeVisible(beyondSourceUs);

    /** Klibin o anki kenarları + ızgara iddiası. */
    const expectEdgesOnGrid = async (label: string): Promise<{ start: number; end: number }> => {
      const state = await app.state();
      const clip = findClip(state, clipId).clip;
      const endUs = clip.timelineStartUs + clip.timelineDurationUs;
      expect(isOnFrameGrid(clip.timelineStartUs, fps), `${label}: klip başlangıcı ızgarada değil`).toBe(
        true,
      );
      expect(isOnFrameGrid(endUs, fps), `${label}: klip bitişi ızgarada değil`).toBe(true);
      return { start: clip.timelineStartUs, end: endUs };
    };

    const initial = await expectEdgesOnGrid('ekleme sonrası');

    // --- 3. GERÇEK fare: sağ tutamağı İÇERİ çek ---
    await app.timeline.dragRightEdgeToTime(clipId, startUs + 3 * SECOND_US);
    const trimmedIn = await expectEdgesOnGrid('içeri kırpma sonrası');
    expect(trimmedIn.end, 'İçeri kırpma klibi kısaltmadı.').toBeLessThan(initial.end);

    // --- 4. GERÇEK fare: sağ tutamağı KAYNAĞIN ÖTESİNE çek ---
    // Hedef, kaynağın sonundan da ileride: kırpma kaynak sınırına DAYANIR ve
    // kenar oraya oturur. Kusur burada doğuyordu (sınır ızgarada değil).
    await ensureTimeVisible(beyondSourceUs);
    await app.timeline.dragRightEdgeToTime(clipId, beyondSourceUs);

    const grown = await expectEdgesOnGrid('kaynak sınırına dayanan kırpma sonrası');
    expect(grown.end, 'Dışarı kırpma klibi uzatmadı.').toBeGreaterThan(trimmedIn.end);
    // Gerçekten SINIRA dayandı mı: kaynağın sonuna bir kareden az kaldıysa
    // evet. (Yoksa test sınırı hiç zorlamamış, dolayısıyla hiçbir şey
    // kanıtlamamış olurdu.)
    const maxEndUs = startUs + assetDurationUs;
    expect(grown.end, 'Klip kaynağın süresini AŞTI.').toBeLessThanOrEqual(maxEndUs);
    expect(
      maxEndUs - grown.end,
      `Kırpma kaynak sınırına dayanmadı (bitiş ${grown.end}, sınır ${maxEndUs}) — ` +
        'sürükleme hedefe ulaşmamış olabilir.',
    ).toBeLessThan(frameToUs(1, fps));

    // --- 5. GERÇEK export isteği: 202 (422 DEĞİL) ---
    const openExport = page.getByRole('button', { name: 'Dışa Aktar', exact: true });
    await expect(openExport).toBeEnabled();
    await openExport.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const responsePromise = page.waitForResponse(
      (res) => res.url().includes('/exports') && res.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await dialog.getByRole('button', { name: 'Dışa aktar' }).click();
    const response = await responsePromise;
    const body = await response.text();
    expect(
      response.status(),
      `Export isteği ${response.status()} döndü: ${body}`,
    ).toBe(202);
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // --- 6. kapı sürükleme sırasında ateşlemedi mi? ---
    const gateErrors = pageErrors.filter((t) =>
      /frame-grid violation|invariant violation/i.test(t),
    );
    expect(
      gateErrors,
      'Belge kapısı sürükleme sırasında ihlal gördü (docStore taahhüt kapısı fırlattı).',
    ).toEqual([]);
  });
});
