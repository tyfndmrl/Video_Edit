/**
 * Test fixture'ları: worker başına BİR oturum, test başına TAZE proje + sayfa.
 *
 * Neden worker-scope oturum: API'nin auth uçları IP başına dakikada 10 istekle
 * sınırlı (Program.cs, "auth" policy — brute-force freni). Test başına
 * register/login yapmak 17 testlik bir koşuda 429 üretiyordu. Gerçek kullanıcı
 * modeli zaten budur: bir kez giriş yap, sekmeler/projeler arasında gez.
 * Refresh cookie her sayfa açılışında DÖNDÜRÜLDÜĞÜ için (LoginGate -> /refresh,
 * RotateAsync) tek bir context zinciri doğru çalışır; storageState kopyalamak
 * ise ikinci testte kırılırdı.
 *
 * Bu yüzden yerleşik `context`/`page` fixture'ları override edilir. Playwright'ın
 * otomatik trace/screenshot toplayıcısı yerleşik context fixture'ına bağlı
 * olduğundan, aynı davranış (trace: on-first-retry + screenshot: only-on-failure)
 * burada elle uygulanır.
 *
 * Proje HER TEST İÇİN TAZE'dir (API üzerinden oluşturulup timeline seed edilir):
 * testler birbirinin dokümanını bozamaz.
 *
 * E2E_PROJECT_ID verilirse HAZIR bir proje kullanılır (gerçek medyalı senaryolar
 * için); o projede en az 2 klipli bir track yoksa testler nedeniyle atlanır.
 */
import { test as base, expect, type BrowserContext } from '@playwright/test';
import { EditorApp } from '../support/editor';
import { E2E_BASE_URL, E2E_VIEWPORT } from '../support/constants';
import {
  buildSeedDoc,
  createProject,
  getProject,
  loginUser,
  registerUser,
  saveTimeline,
  type SeededProject,
} from './seed';

export interface WorkerFixtures {
  account: {
    context: BrowserContext;
    email: string;
    password: string;
    accessToken: string;
  };
}

export interface Fixtures {
  seed: SeededProject;
  editor: EditorApp;
}

const EXTERNAL_PROJECT_ID = process.env.E2E_PROJECT_ID;
const EXTERNAL_EMAIL = process.env.E2E_EMAIL;
const EXTERNAL_PASSWORD = process.env.E2E_PASSWORD;

export const test = base.extend<Fixtures, WorkerFixtures>({
  account: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        baseURL: E2E_BASE_URL,
        viewport: E2E_VIEWPORT,
      });
      try {
        if (EXTERNAL_PROJECT_ID) {
          if (!EXTERNAL_EMAIL || !EXTERNAL_PASSWORD) {
            throw new Error(
              'E2E_PROJECT_ID verildi ama E2E_EMAIL/E2E_PASSWORD yok — hazır projeye giriş yapılamıyor.',
            );
          }
          const accessToken = await loginUser(context.request, EXTERNAL_EMAIL, EXTERNAL_PASSWORD);
          await use({ context, email: EXTERNAL_EMAIL, password: EXTERNAL_PASSWORD, accessToken });
        } else {
          const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const email = `e2e-${stamp}@videoedit.test`;
          const password = 'e2epass1234';
          const accessToken = await registerUser(context.request, email, password);
          await use({ context, email, password, accessToken });
        }
      } finally {
        await context.close();
      }
    },
    { scope: 'worker' },
  ],

  context: async ({ account }, use) => {
    await use(account.context);
  },

  // Not: trace/screenshot toplama ELLE yapılmaz. Playwright'ın artefakt
  // yöneticisi `browser.newContext()` çağrısını kendisi sarmalar, dolayısıyla
  // worker-scope context'te de `trace: 'on-first-retry'` ve
  // `screenshot: 'only-on-failure'` ayarları çalışır (doğrulandı: kasıtlı
  // kırmızı bir testte retry'da trace.zip üretildi).
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },

  seed: async ({ account }, use) => {
    const request = account.context.request;

    if (EXTERNAL_PROJECT_ID) {
      const detail = (await getProject(
        request,
        account.accessToken,
        EXTERNAL_PROJECT_ID,
      )) as unknown as {
        id: string;
        timeline: { tracks: { id: string; clips: { id: string }[] }[] };
      };
      const track = detail.timeline.tracks.find((t) => t.clips.length >= 2);
      if (!track) {
        test.skip(
          true,
          `E2E_PROJECT_ID=${EXTERNAL_PROJECT_ID} projesinde en az 2 klipli bir track yok — ` +
            'timeline etkileşim testleri çalıştırılamıyor.',
        );
        return;
      }
      const other = detail.timeline.tracks.find((t) => t.id !== track.id);
      await use({
        projectId: EXTERNAL_PROJECT_ID,
        email: account.email,
        password: account.password,
        accessToken: account.accessToken,
        trackTopId: track.id,
        trackBottomId: other?.id ?? track.id,
        clipAId: track.clips[0].id,
        clipBId: track.clips[1].id,
        external: true,
      });
      return;
    }

    const project = await createProject(
      request,
      account.accessToken,
      `E2E ${Date.now().toString(36)}`,
    );
    const seedDoc = buildSeedDoc(project.id);
    await saveTimeline(request, account.accessToken, project.id, seedDoc.timeline, project.revisionNumber);

    await use({
      projectId: project.id,
      email: account.email,
      password: account.password,
      accessToken: account.accessToken,
      trackTopId: seedDoc.trackTopId,
      trackBottomId: seedDoc.trackBottomId,
      clipAId: seedDoc.clipAId,
      clipBId: seedDoc.clipBId,
      external: false,
    });
  },

  editor: async ({ page, seed }, use) => {
    const app = new EditorApp(page);
    await app.open(seed.projectId, { email: seed.email, password: seed.password });
    await use(app);
  },
});

export { expect };
