/**
 * appBridge — sayfa içindeki UYGULAMA store'larına salt-okunur erişim.
 *
 * Etkileşim DAİMA gerçek fare/klavyedir; bu modül yalnızca DOĞRULAMA içindir
 * ("tıkladım, gerçekten seçildi mi?"). Canvas timeline'ın seçili klip, zoom,
 * scroll gibi durumları için DOM'da okunabilir bir gösterge yok — tek güvenilir
 * kaynak store.
 *
 * Nasıl: Vite dev sunucusunda `import('/src/state/docStore.ts')` uygulamanın
 * import ettiği URL'nin AYNISIDIR, dolayısıyla aynı modül örneğini (aynı
 * zustand store'u) döndürür. Uygulama koduna test-only bir `window` kancası
 * eklemeye gerek kalmaz (paralel çalışan ajanlarla çakışma riski sıfır).
 *
 * Uygulama bir gün test kancası eklerse (`window.__videoeditTest`), köprü onu
 * tercih eder — ileri uyumluluk.
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

/**
 * Store modüllerini `window.__ve` altına bağlar. Her sayfa yüklemesinden sonra
 * bir kez çağrılmalı (modül grafiği navigasyonla sıfırlanır).
 */
export async function installAppBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('canvas') !== null || document.body.childElementCount > 0,
    undefined,
    { timeout: 30_000 },
  );
  const ok = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__ve) return true;
    // Uygulama kendi test kancasını sunuyorsa onu kullan.
    const hook = w.__videoeditTest as
      | { docStore?: unknown; editorStore?: unknown; projectSession?: unknown }
      | undefined;
    if (hook?.docStore && hook.editorStore) {
      w.__ve = {
        doc: { useDocStore: hook.docStore },
        editor: { useEditorStore: hook.editorStore },
        session: { useProjectSession: hook.projectSession },
      };
      return true;
    }
    // Vite dev modül grafiği üzerinden AYNI store örnekleri.
    // (Değişken üzerinden import: TS modül çözümlemesi devre dışı, runtime'da
    //  document URL'sine göre çözülür.)
    const imp = (specifier: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
    const [doc, editor, session] = await Promise.all([
      imp('/src/state/docStore.ts'),
      imp('/src/state/editorStore.ts'),
      imp('/src/state/projectSession.ts'),
    ]);
    w.__ve = { doc, editor, session };
    return true;
  });
  expect(
    ok,
    'appBridge kurulamadı — Vite DEV sunucusuna bağlanıldığından emin olun (production preview modül yollarını hash\'ler).',
  ).toBe(true);
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

export function findClip(state: AppState, clipId: string): { clip: ClipState; trackIndex: number } {
  for (let ti = 0; ti < state.tracks.length; ti++) {
    const clip = state.tracks[ti].clips.find((c) => c.id === clipId);
    if (clip) return { clip, trackIndex: ti };
  }
  throw new Error(`Klip dokümanda yok: ${clipId}`);
}
