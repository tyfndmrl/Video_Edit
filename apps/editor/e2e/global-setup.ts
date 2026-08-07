/**
 * E2E ön kontrolü: Vite (5173) ve API (5000) ayakta mı?
 *
 * Playwright hiçbir süreci başlatmaz (playwright.config.ts'te webServer
 * varsayılan olarak YOK) — sunucular CI'da ayrı adımlarla, yerelde geliştirici
 * tarafından ayağa kaldırılır. Ayakta değillerse testler "ECONNREFUSED / 401"
 * gibi opak hatalarla düşerdi; burada erkenden ve net bir Türkçe mesajla
 * patlıyoruz.
 */
import type { FullConfig } from '@playwright/test';
import { E2E_BASE_URL } from './support/constants';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:5000';
const WAIT_MS = Number(process.env.E2E_WAIT_MS ?? 60_000);

const HINT = [
  '',
  'E2E GERÇEK bir API + GERÇEK bir Vite DEV sunucusu ister:',
  '  1) docker compose -f compose.dev.yml up -d postgres minio',
  '  2) dotnet run --project backend/src/VideoEdit.Api          (http://localhost:5000)',
  '  3) pnpm --filter @videoedit/editor dev                     (http://localhost:5173)',
  '',
  'Adresler: E2E_BASE_URL / E2E_API_URL. Vite\'ı Playwright başlatsın isterseniz: E2E_START_SERVER=1.',
].join('\n');

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, label: string, deadline: number): Promise<void> {
  for (;;) {
    if (await probe(url)) return;
    if (Date.now() >= deadline) {
      throw new Error(`E2E ön kontrolü başarısız: ${label} yanıt vermiyor (${url}).\n${HINT}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  await waitFor(`${API_URL}/health`, 'API sağlık ucu', deadline);
  // DEV sunucusu şart: store köprüsü Vite'ın modül grafiğinden okur
  // (e2e/support/appBridge.ts) — production preview'da modül yolları hash'lenir.
  await waitFor(E2E_BASE_URL, 'Vite dev sunucusu', deadline);
}
