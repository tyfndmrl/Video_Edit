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

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

/** Inject a token from outside (login flow, tests, dev tooling). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
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
    throw new Error(`Login failed (${res.status})`);
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error('Login response did not include an access token');
  }
  accessToken = data.accessToken;
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
