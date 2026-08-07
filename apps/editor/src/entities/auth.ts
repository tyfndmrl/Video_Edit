/**
 * auth — minimal auth layer for M1.
 *
 * There is no login UI yet; the access token lives in memory and can be
 * injected from the outside (dev console, future login screen) via
 * setAccessToken(). apiClient consults getAccessToken() on every request and
 * asks refreshAccessToken() exactly once when it sees a 401.
 *
 * The refresh call relies on an httpOnly refresh-token cookie, hence
 * credentials: 'include'.
 */

import { problemDetailsMessage } from './problemDetails';

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

/** Inject a token from outside (login flow, tests, dev tooling). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Register succeeded but the follow-up automatic login failed. The account
 * EXISTS — the UI must not present this as a registration failure; it should
 * switch to the login form instead (see LoginGate).
 */
export class AutoLoginFailedError extends Error {
  constructor(cause: unknown) {
    super('Account created, but automatic sign-in failed', { cause });
    this.name = 'AutoLoginFailedError';
  }
}

/**
 * Kayıt hatası -> kullanıcı mesajı. ValidationProblem errors sözlüğü (Identity
 * şifre kuralları dahil) düzleştirilir; jenerik başlık yerine asıl açıklamalar
 * gösterilir. Gövde çözülemezse durum koduyla jenerik Türkçe mesaj.
 */
export function registerErrorMessage(status: number, body: unknown): string {
  return problemDetailsMessage(body) ?? `Kayıt başarısız (HTTP ${status}).`;
}

/**
 * Giriş hatası -> kullanıcı mesajı. Backend 401'i bilinçli olarak jeneriktir
 * (hesap varlığı sızdırılmaz) — kullanıcıya net Türkçe karşılığı gösterilir.
 */
export function loginErrorMessage(status: number, body: unknown): string {
  if (status === 401) return 'E-posta veya şifre hatalı.';
  return problemDetailsMessage(body) ?? `Giriş başarısız (HTTP ${status}).`;
}

/** Register a new account, then log in to obtain an access token. */
export async function register(email: string, password: string, displayName: string): Promise<void> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(registerErrorMessage(res.status, body));
  }
  try {
    await login(email, password);
  } catch (err) {
    // Distinct error type: the caller must be able to tell "register failed"
    // (retry register) apart from "registered but not signed in" (go log in).
    throw new AutoLoginFailedError(err);
  }
}

/** Password login. Stores the returned access token in memory. */
export async function login(email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // let the server set the refresh cookie
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(loginErrorMessage(res.status, body));
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error('Login response did not include an access token');
  }
  accessToken = data.accessToken;
}

/**
 * Logout: sunucudaki refresh token'lar iptal edilir (POST /api/auth/logout),
 * yerel access token temizlenir. Sunucu çağrısı best-effort — ağ hatasında
 * bile yerel oturum kapanmış olur. Raw fetch: apiClient bu modülü import
 * ettiği için buradan apiFetch kullanmak döngü yaratırdı.
 */
export async function logout(): Promise<void> {
  const token = accessToken;
  accessToken = null;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
  } catch {
    // best effort — yerel oturum zaten temizlendi
  }
}

/**
 * Try to refresh the access token via the refresh cookie. Single-flight:
 * concurrent 401s share one refresh request. Resolves true when a new access
 * token was obtained.
 */
export function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { accessToken?: string } | null;
    if (!data?.accessToken) return false;
    accessToken = data.accessToken;
    return true;
  } catch {
    return false;
  }
}
