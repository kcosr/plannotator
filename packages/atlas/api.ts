import type { AtlasSnapshot, ReferenceResponse, SourceFile } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the HTTP error when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function fetchStatus(signal?: AbortSignal) {
  return request<{ status: 'indexing' | 'ready' | 'error'; error?: string }>('/api/atlas/status', { signal });
}

export function fetchSnapshot(signal?: AbortSignal) {
  return request<AtlasSnapshot>('/api/atlas', { signal });
}

export function fetchSource(path: string, signal?: AbortSignal) {
  return request<SourceFile>(`/api/atlas/source?path=${encodeURIComponent(path)}`, { signal });
}

export async function fetchReferences(symbol: string, path: string, signal?: AbortSignal): Promise<ReferenceResponse> {
  return request<ReferenceResponse>(
    `/api/atlas/references?symbol=${encodeURIComponent(symbol)}&path=${encodeURIComponent(path)}`,
    { signal },
  );
}

export function refreshAtlas() {
  return request<{ status?: string; ok?: boolean }>('/api/atlas/refresh', { method: 'POST' });
}

export function closeAtlas() {
  return request<{ ok: boolean }>('/api/atlas/close', { method: 'POST' });
}
