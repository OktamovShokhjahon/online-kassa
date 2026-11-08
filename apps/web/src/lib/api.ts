/**
 * API client. The access token lives in memory only (never in storage); the httpOnly refresh cookie
 * renews it. A 401 triggers exactly one refresh and a retry, concurrent callers share the refresh.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onAuthLost: (() => void) | null = null;
let language = 'uz';

export const setAccessToken = (t: string | null) => (accessToken = t);
export const getAccessToken = () => accessToken;
export const setApiLanguage = (l: string) => (language = l);
export const setAuthLostHandler = (fn: (() => void) | null) => (onAuthLost = fn);

let refreshCall: Promise<{ accessToken: string; [k: string]: any } | null> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Calls made while one is in flight share it:
 * two parallel calls would present the same (then rotated) refresh token twice, which the server
 * treats as token theft and answers by ending the session.
 */
export function refreshSession(): Promise<{ accessToken: string; [k: string]: any } | null> {
  refreshCall ??= (async () => {
    const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()).data;
    accessToken = body.accessToken;
    return body;
  })().finally(() => {
    refreshCall = null;
  });
  return refreshCall;
}

function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshSession()
    .then((b) => !!b)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface Page<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totals?: any };
}

async function parse(res: Response) {
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? res.statusText, json?.error?.details);
  return json;
}

export async function apiRaw(path: string, init: RequestInit & { json?: unknown; form?: FormData; auth?: boolean } = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept-Language', language);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  if (init.auth !== false && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.form ?? init.body,
  });
  if (res.status === 401 && retry && init.auth !== false) {
    if (await refreshOnce()) return apiRaw(path, init, false);
    onAuthLost?.();
  }
  return res;
}

/** JSON call; returns `data` (and `meta` for lists via apiPage). */
export async function api<T = any>(path: string, init: Parameters<typeof apiRaw>[1] = {}): Promise<T> {
  const json = await parse(await apiRaw(path, init));
  return json?.data as T;
}

export async function apiPage<T = any>(path: string, init: Parameters<typeof apiRaw>[1] = {}): Promise<Page<T>> {
  const json = await parse(await apiRaw(path, init));
  return { data: json.data, meta: json.meta };
}

export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const patch = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const put = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

/** Builds `?a=1&b=2` skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Downloads a file response (xlsx/pdf) through the authenticated client. */
export async function download(path: string, filename: string) {
  const res = await apiRaw(path);
  if (!res.ok) throw new ApiError(res.status, 'ERROR', res.statusText);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
