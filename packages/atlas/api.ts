import type {
  AtlasSnapshot,
  CallHierarchyResponse,
  ReferenceResponse,
  SourceFile,
} from './types';
import type { CodeAnnotation } from '@plannotator/shared/code-annotation';

export interface AtlasIndexStatus {
  status: 'indexing' | 'ready' | 'error';
  phase: 'checking' | 'indexing' | 'ready' | 'error';
  hasSnapshot: boolean;
  revision: number;
  source?: 'cache' | 'fresh';
  refreshing: boolean;
  persistent: boolean;
  persistenceError?: string;
  error?: string;
  capability?: AtlasCapability;
}

export interface AtlasCapability {
  available: boolean;
  code?: string;
  message?: string;
  retryable?: boolean;
}

interface AtlasErrorResponse {
  error?: string;
  capability?: AtlasCapability;
}

export class AtlasRequestError extends Error {
  readonly status: number;
  readonly capability?: AtlasCapability;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    capability?: AtlasCapability,
  ) {
    super(message);
    this.name = 'AtlasRequestError';
    this.status = status;
    this.capability = capability;
    this.retryable = capability?.retryable ?? status >= 500;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let capability: AtlasCapability | undefined;
    try {
      const body = await response.json() as AtlasErrorResponse;
      capability = body.capability;
      message = capability?.message || body.error || message;
    } catch {
      // Preserve the HTTP error when the response is not JSON.
    }
    throw new AtlasRequestError(message, response.status, capability);
  }
  return response.json() as Promise<T>;
}

export function fetchStatus(signal?: AbortSignal) {
  return request<AtlasIndexStatus>('/api/atlas/status', { signal });
}

export function fetchSnapshot(signal?: AbortSignal) {
  return request<AtlasSnapshot>('/api/atlas', { signal });
}

export function fetchSource(path: string, signal?: AbortSignal) {
  return request<SourceFile>(`/api/atlas/source?path=${encodeURIComponent(path)}`, { signal });
}

export async function fetchReferences(
  symbol: string,
  path: string,
  line: number,
  column: number,
  signal?: AbortSignal,
): Promise<ReferenceResponse> {
  const params = new URLSearchParams({
    symbol,
    path,
    line: String(line),
    column: String(column),
  });
  return request<ReferenceResponse>(
    `/api/atlas/references?${params}`,
    { signal },
  );
}

export function fetchCallHierarchy(
  path: string,
  line: number,
  column: number,
  signal?: AbortSignal,
): Promise<CallHierarchyResponse> {
  const params = new URLSearchParams({
    path,
    line: String(line),
    column: String(column),
  });
  return request<CallHierarchyResponse>(
    `/api/atlas/calls?${params}`,
    { signal },
  );
}

export function reindexAtlas() {
  return request<AtlasIndexStatus>('/api/atlas/index', { method: 'POST' });
}

export function closeAtlas() {
  return request<{ ok: boolean }>('/api/atlas/close', { method: 'POST' });
}

export function submitAtlasFeedback(feedback: {
  annotations: CodeAnnotation[];
  markdown: string;
}) {
  return request<{ annotations: CodeAnnotation[]; markdown: string }>('/api/atlas/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback),
  });
}
