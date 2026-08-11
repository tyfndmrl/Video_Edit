/**
 * appBridge — sayfa içindeki UYGULAMA store'larına salt-okunur erişim.
 *
 * Etkileşim DAİMA gerçek fare/klavyedir; bu modül yalnızca DOĞRULAMA içindir
 * ("tıkladım, gerçekten seçildi mi?"). Canvas timeline'ın seçili klip, zoom,
 * scroll gibi durumları için DOM'da okunabilir bir gösterge yok — tek güvenilir
 * kaynak store.
 *
 * ---------------------------------------------------------------------------
 * KÖPRÜ NASIL KURULUR (M4 denetimi, yüksek bulgu sonrası ÜÇ KATMANLI)
 * ---------------------------------------------------------------------------
 * Kritik olan, uygulamanın KULLANDIĞI modül örneğine (aynı zustand store'una)
 * ulaşmaktır. Yanlış örneğe bağlanmak bomboş bir doküman okumak demektir.
 *
 *  1. `window.__videoeditTest` — uygulamanın DEV-only kancası
 *     (src/state/testBridge.ts). BİRİNCİL yol: tarayıcı tamponuna, HMR
 *     damgasına, hiçbir dolaylı iz'e bağlı değil.
 *  2. `window.__veModuleUrls` — sayfa açılışında kurulan PerformanceObserver'ın
 *     kaydettiği modül URL'leri (fixtures/test.ts init script'i). Observer
 *     Resource Timing TAMPONUNDAN BAĞIMSIZ çalışır (tampon yalnız
 *     `getEntriesByType` içindir), dolayısıyla 250 kayıt sınırından etkilenmez.
 *  3. `performance.getEntriesByType('resource')` taraması — eski yol; tampon
 *     dolduysa (varsayılan 250 kayıt) ilgili kayıt düşmüş olabilir.
 *  4. Damgasız düz yol (`/src/state/docStore.ts`) — son çare. HMR sonrası AYRI
 *     bir modül örneği döndürebilir.
 *
 * Katman 3/4'e düşülse bile sonuç SESSİZ YEŞİL olamaz: kurulum bittikten sonra
 * köprünün CANLI olduğu doğrulanır (`assertBridgeLive`) — proje oturumu 'ready'
 * ve dokümanda en az bir track görülmelidir. Ölü bir köprü, hangi katmandan
 * geldiği yazılı olarak, ANINDA kırmızı verir.
 */
import { expect, type Page } from '@playwright/test';

export interface ClipState {
  id: string;
  kind: string;
  timelineStartUs: number;
  timelineDurationUs: number;
}

export interface TrackState {
  id: string;
  type: string;
  locked: boolean;
  clips: ClipState[];
}

export interface AppState {
  sessionStatus: string;
  projectId: string | null;
  /** editorStore */
  pxPerUs: number;
  scrollUs: number;
  playheadUs: number;
  selection: string[];
  snappingEnabled: boolean;
  /** docStore */
  tracks: TrackState[];
  historyLabels: string[];
  cursor: number;
  clipCount: number;
}

/** Köprünün hangi katmandan kurulduğu — testler bunu doğrudan iddia eder. */
export type BridgeSource = 'app-hook' | 'observer-url' | 'resource-timing' | 'plain-path';

const SOURCE_RANK: Record<BridgeSource, number> = {
  'app-hook': 0,
  'observer-url': 1,
  'resource-timing': 2,
  'plain-path': 3,
};

/**
 * Sayfa açılmadan ÖNCE kurulması gereken kayıt betiği (fixtures/test.ts
 * içinden `page.addInitScript` ile). İki iş yapar:
 *  - Resource Timing tamponunu büyütür ve dolduğunda temizler (yoksa 250'de
 *    donar ve sonraki tüm kayıtlar düşer — denetçinin ölçtüğü davranış).
 *  - Tampondan BAĞIMSIZ bir PerformanceObserver ile modül URL'lerini
 *    `window.__veModuleUrls` altında pathname -> tam URL olarak biriktirir.
 */
export function bridgeRecorderInitScript(): () => void {
  return () => {
    const w = window as unknown as { __veModuleUrls?: Record<string, string> };
    const urls: Record<string, string> = w.__veModuleUrls ?? {};
    w.__veModuleUrls = urls;
    const record = (name: string): void => {
      try {
        urls[new URL(name, location.href).pathname] = name;
      } catch {
        /* mutlak olmayan/garip isimler yok sayılır */
      }
    };
    try {
      performance.setResourceTimingBufferSize(5000);
    } catch {
      /* eski tarayıcı: observer yolu yine çalışır */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record(entry.name);
      }).observe({ type: 'resource', buffered: true });
    } catch {
      /* observer yoksa tampon taramasına düşülür */
    }
    window.addEventListener('resourcetimingbufferfull', () => {
      // Kayıtlar zaten observer'da; tamponu boşalt ki sonraki kayıtlar düşmesin.
      try {
        performance.clearResourceTimings();
      } catch {
        /* yok sayılır */
      }
    });
  };
}

const STORE_PATHS = {
  doc: '/src/state/docStore.ts',
  editor: '/src/state/editorStore.ts',
  session: '/src/state/projectSession.ts',
} as const;

export interface InstallOptions {
  /** Köprünün canlı olduğunu doğrulama süresi (ms). */
  timeoutMs?: number;
  /**
   * Canlılık doğrulaması dokümanda en az bir track bekler. E2E projelerinin
   * hepsinde track vardır; kapatmak yalnız köprünün KENDİSİNİ test eden
   * senaryolar içindir.
   */
  requireTracks?: boolean;
}

/**
 * Store modüllerini `window.__ve` altına bağlar ve köprünün CANLI olduğunu
 * doğrular. Her sayfa yüklemesinden sonra bir kez çağrılmalı (modül grafiği
 * navigasyonla sıfırlanır). Kullanılan katmanı döndürür.
 */
export async function installAppBridge(
  page: Page,
  opts: InstallOptions = {},
): Promise<BridgeSource> {
  await page.waitForFunction(
    () => document.querySelector('canvas') !== null || document.body.childElementCount > 0,
    undefined,
    { timeout: 30_000 },
  );

  const source = await page.evaluate(async (paths: typeof STORE_PATHS) => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__ve && typeof w.__veBridgeSource === 'string') return w.__veBridgeSource as string;

    // --- 1. Uygulamanın kendi DEV kancası (birincil) ---------------------
    const hook = w.__videoeditTest as
      | { version?: number; docStore?: unknown; editorStore?: unknown; projectSession?: unknown }
      | undefined;
    if (hook?.version === 1 && hook.docStore && hook.editorStore && hook.projectSession) {
      w.__ve = {
        doc: { useDocStore: hook.docStore },
        editor: { useEditorStore: hook.editorStore },
        session: { useProjectSession: hook.projectSession },
      };
      w.__veBridgeSource = 'app-hook';
      return 'app-hook';
    }

    // --- 2/3/4. Modül grafiği üzerinden -----------------------------------
    // Vite'ın HMR damgası (`?t=...`) tarayıcı için modül KİMLİĞİNİN parçasıdır:
    // damgasız `import('/src/state/docStore.ts')` AYRI bir örnek (ayrı zustand
    // store'u) döndürür. Uygulamanın GERÇEKTEN yüklediği URL bulunmalı.
    const recorded = (w.__veModuleUrls as Record<string, string> | undefined) ?? {};
    const resolve = (path: string): { url: string; via: string } => {
      const fromObserver = recorded[path];
      if (typeof fromObserver === 'string' && fromObserver.length > 0) {
        return { url: fromObserver, via: 'observer-url' };
      }
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name;
        if (name.split('?')[0].endsWith(path)) return { url: name, via: 'resource-timing' };
      }
      return { url: path, via: 'plain-path' };
    };

    const picks = [resolve(paths.doc), resolve(paths.editor), resolve(paths.session)];
    // En ZAYIF katman raporlanır: bir modül düz yoldan geldiyse köprünün
    // güvencesi o kadardır.
    const rank: Record<string, number> = {
      'observer-url': 1,
      'resource-timing': 2,
      'plain-path': 3,
    };
    const via = picks.reduce((worst, p) => (rank[p.via] > rank[worst] ? p.via : worst), 'observer-url');

    // (Değişken üzerinden import: TS modül çözümlemesi devre dışı, runtime'da
    //  document URL'sine göre çözülür.)
    const imp = (specifier: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
    const [doc, editor, session] = await Promise.all(picks.map((p) => imp(p.url)));
    w.__ve = { doc, editor, session };
    w.__veBridgeSource = via;
    return via;
  }, STORE_PATHS);

  await assertBridgeLive(page, source as BridgeSource, opts);
  return source as BridgeSource;
}

/** Köprünün hangi katmandan kurulduğu (kurulmadıysa null). */
export async function bridgeSource(page: Page): Promise<BridgeSource | null> {
  return page.evaluate(
    () => ((window as unknown as { __veBridgeSource?: string }).__veBridgeSource ?? null) as BridgeSource | null,
  );
}

/** Köprüyü söker — yeniden kurulum senaryoları (ve köprü testleri) için. */
export async function resetAppBridge(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.__ve;
    delete w.__veBridgeSource;
  });
}

interface LivenessProbe {
  ok: boolean;
  status: string | null;
  trackCount: number | null;
  error: string | null;
}

/**
 * "Bağlandım" ile "DOĞRU store'a bağlandım" arasındaki farkı kapatan kontrol.
 *
 * Ölü bir köprü (HMR damgası kaçmış, kanca uyumsuz, tampon dolmuş) boş bir
 * store okur: `status` asla 'ready' olmaz, doküman boş kalır. Eskiden bu,
 * çağıran taraftaki 30 sn'lik opak bir `waitForFunction` zaman aşımı olarak
 * görünüyordu; artık hangi katmanın kullanıldığını söyleyen bir hata verir.
 */
export async function assertBridgeLive(
  page: Page,
  source: BridgeSource,
  opts: InstallOptions = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 30_000;
  const requireTracks = opts.requireTracks ?? true;
  const probe = async (): Promise<LivenessProbe> =>
    page.evaluate((needTracks: boolean) => {
      try {
        const bridge = (window as unknown as {
          __ve?: {
            doc: { useDocStore: { getState(): { doc?: { tracks?: unknown[] } } } };
            session: { useProjectSession: { getState(): { status?: string } } };
          };
        }).__ve;
        if (!bridge) return { ok: false, status: null, trackCount: null, error: 'window.__ve yok' };
        const status = bridge.session.useProjectSession.getState().status ?? null;
        const tracks = bridge.doc.useDocStore.getState().doc?.tracks;
        const trackCount = Array.isArray(tracks) ? tracks.length : null;
        return {
          ok: status === 'ready' && (!needTracks || (trackCount ?? 0) > 0),
          status,
          trackCount,
          error: null,
        };
      } catch (e) {
        return { ok: false, status: null, trackCount: null, error: String(e) };
      }
    }, requireTracks);

  await expect
    .poll(async () => (await probe()).ok, {
      timeout,
      message:
        `appBridge ÖLÜ: '${source}' katmanından bağlanılan store uygulamanınki değil ` +
        '(oturum "ready" olmuyor / doküman boş). Beklenen birincil katman "app-hook" ' +
        '(src/state/testBridge.ts, yalnız DEV). Vite DEV sunucusuna bağlanıldığından ' +
        'emin olun — production preview\'da modül yolları hash\'lenir ve kanca derlenmez.',
    })
    .toBe(true);
}

type Store<T> = { getState(): T };

interface Bridge {
  doc: { useDocStore: Store<Record<string, unknown>> };
  editor: { useEditorStore: Store<Record<string, unknown>> };
  session: { useProjectSession: Store<Record<string, unknown>> };
}

/** Tüm ilgili store durumlarının anlık, serileştirilebilir bir kopyası. */
export async function readAppState(page: Page): Promise<AppState> {
  return page.evaluate(() => {
    const bridge = (window as unknown as { __ve: Bridge }).__ve;
    const d = bridge.doc.useDocStore.getState() as {
      doc: {
        tracks: {
          id: string;
          type: string;
          locked: boolean;
          clips: {
            id: string;
            kind: string;
            timelineStartUs: number;
            timelineDurationUs: number;
          }[];
        }[];
      };
      history: { label: string }[];
      cursor: number;
    };
    const e = bridge.editor.useEditorStore.getState() as {
      pxPerUs: number;
      scrollUs: number;
      playheadUs: number;
      selection: Set<string>;
      snappingEnabled: boolean;
    };
    const s = bridge.session.useProjectSession.getState() as {
      status: string;
      projectId: string | null;
    };
    const tracks = d.doc.tracks.map((t) => ({
      id: t.id,
      type: t.type,
      locked: t.locked,
      clips: t.clips.map((c) => ({
        id: c.id,
        kind: c.kind,
        timelineStartUs: c.timelineStartUs,
        timelineDurationUs: c.timelineDurationUs,
      })),
    }));
    return {
      sessionStatus: s.status,
      projectId: s.projectId,
      pxPerUs: e.pxPerUs,
      scrollUs: e.scrollUs,
      playheadUs: e.playheadUs,
      selection: [...e.selection],
      snappingEnabled: e.snappingEnabled,
      tracks,
      historyLabels: d.history.map((h) => h.label),
      cursor: d.cursor,
      clipCount: tracks.reduce((n, t) => n + t.clips.length, 0),
    };
  });
}

/** Proje ayarları (fps/çözünürlük) — nicel beklenen değerleri hesaplamak için. */
export async function readProjectSettings(
  page: Page,
): Promise<{ width: number; height: number; fps: { num: number; den: number } }> {
  return page.evaluate(() => {
    const bridge = (window as unknown as {
      __ve: {
        doc: {
          useDocStore: {
            getState(): {
              doc: { settings: { width: number; height: number; fps: { num: number; den: number } } };
            };
          };
        };
      };
    }).__ve;
    const s = bridge.doc.useDocStore.getState().doc.settings;
    return { width: s.width, height: s.height, fps: { num: s.fps.num, den: s.fps.den } };
  });
}

export function findClip(state: AppState, clipId: string): { clip: ClipState; trackIndex: number } {
  for (let ti = 0; ti < state.tracks.length; ti++) {
    const clip = state.tracks[ti].clips.find((c) => c.id === clipId);
    if (clip) return { clip, trackIndex: ti };
  }
  throw new Error(`Klip dokümanda yok: ${clipId}`);
}

/** Katman sıralaması — testler "en az bu kadar güçlü" diye iddia edebilsin. */
export function sourceRank(source: BridgeSource): number {
  return SOURCE_RANK[source];
}
