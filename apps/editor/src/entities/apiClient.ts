/**
 * apiClient — thin JSON fetch wrapper for the backend API.
 *
 * - Attaches the in-memory Bearer token (entities/auth.ts).
 * - On 401: attempts a single token refresh, then retries the request once.
 * - Throws ApiError (with HTTP status) for non-2xx responses.
 *
 * Part PUTs to R2 do NOT go through this client — they use presigned URLs and
 * raw XHR (upload progress); see features/library/upload/uploadEngine.ts.
 */
import { getAccessToken, refreshAccessToken } from './auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialized request body. */
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  const run = (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return fetch(path, { method, headers, body: payload, signal });
  };

  let res = await run();
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await run();
  }

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      // non-JSON error body — ignore
    }
    throw new ApiError(res.status, path, `${method} ${path} failed with HTTP ${res.status}`, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
