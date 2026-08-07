/**
 * Playwright — GERÇEK tarayıcıda GERÇEK fare olaylarıyla uçtan uca testler.
 *
 * Neden var: bugüne kadar "E2E" denen testler store'u doğrudan çağırıyordu;
 * canvas'a hiç gerçek pointer olayı gitmedi. Kullanıcının "kırpma/taşıma/sağ
 * tık çalışmıyor" şikayeti tam da bu boşluktan geçti. Buradaki testler
 * page.mouse.* kullanır — sentetik dispatchEvent YASAK (bkz. e2e/support/mouse.ts).
 *
 * Sunucular: Vite 5173 ve API 5000 AYRI adımlarla ayağa kaldırılır (CI'da
 * ci.yml, yerelde `pnpm dev` + `dotnet run`). `reuseExistingServer: true`
 * sayesinde ayaktaysa ona bağlanılır, hiçbir süreç öldürülmez/yeniden
 * başlatılmaz. API'nin ayakta olduğu global-setup'ta net bir mesajla doğrulanır.
 *
 * Testler DEV sunucusuna bağlanır (production preview'a değil): store'lar
 * e2e/support/appBridge.ts içinden Vite'ın modül grafiği üzerinden okunur
 * (`import('/src/state/docStore.ts')` — uygulamanın kullandığı AYNI modül
 * örneği). Etkileşim daima gerçek faredir; store yalnızca DOĞRULAMA içindir.
 */
import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_VIEWPORT } from './e2e/support/constants';

const baseURL = E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts/test-results',
  // Timeline testleri aynı canvas/klavye odağını paylaşan ağır etkileşimler:
  // tek worker deterministik kalır (ve dev sunucusunu HMR ile boğmaz).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.artifacts/report' }]]
    : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    video: 'off',
    screenshot: 'only-on-failure',
    viewport: E2E_VIEWPORT,
    // Canvas etkileşimlerinde "gerçek" fare hızını taklit et: adımlı hareket
    // support/mouse.ts'te; burada yalnız varsayılan eylem gecikmesi kapalı.
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: E2E_VIEWPORT },
    },
  ],
  // Ayakta olan 5173'e BAĞLANIR (reuseExistingServer). Ayakta değilse yerel
  // geliştiricinin işini kolaylaştırmak için dev sunucusunu başlatır; CI'da bu
  // dal çalışmaz çünkü sunucu önceki adımda başlatılmış olur.
  // Varsayılan: webServer YOK — sunucular ayrı adımlarla ayağa kaldırılır ve
  // Playwright hiçbir süreci başlatmaz/öldürmez. Hazır olup olmadıkları
  // global-setup.ts'te net mesajlarla doğrulanır.
  //
  // E2E_START_SERVER=1 verilirse (yalnız yerel kolaylık) ayakta değilse dev
  // sunucusunu başlatır; ayaktaysa `reuseExistingServer` ile ona BAĞLANIR,
  // asla yeniden başlatmaz. (cwd varsayılanı bu config dosyasının dizini.)
  webServer: process.env.E2E_START_SERVER
    ? {
        command: 'pnpm exec vite --port 5173 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
});
