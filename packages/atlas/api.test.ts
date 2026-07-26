import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchCallHierarchy,
  fetchReferences,
  fetchStatus,
  reindexAtlas,
} from './api';
import type { CallHierarchyResponse, ReferenceResponse } from './types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchReferences', () => {
  test('sends the exact one-based source position', async () => {
    let requestedUrl = '';
    const response: ReferenceResponse = {
      definitions: [],
      references: [],
      provider: {
        kind: 'lsp',
        name: 'typescript-language-server',
        status: 'ready',
      },
    };
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return Response.json(response);
    }) as typeof fetch;

    await fetchReferences('render', 'src/view.tsx', 42, 17);

    const url = new URL(requestedUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/atlas/references');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'render',
      path: 'src/view.tsx',
      line: '42',
      column: '17',
    });
  });
});

describe('fetchCallHierarchy', () => {
  test('sends the exact one-based source position', async () => {
    let requestedUrl = '';
    const response: CallHierarchyResponse = {
      root: null,
      callers: [],
      callees: [],
      truncated: false,
      provider: {
        kind: 'lsp',
        name: 'typescript-language-server',
        status: 'ready',
      },
    };
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return Response.json(response);
    }) as typeof fetch;

    await fetchCallHierarchy('src/view.tsx', 42, 17);

    const url = new URL(requestedUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/atlas/calls');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: 'src/view.tsx',
      line: '42',
      column: '17',
    });
  });
});

describe('Atlas index lifecycle', () => {
  test('reads the background index status contract', async () => {
    const response = {
      status: 'indexing' as const,
      phase: 'checking' as const,
      hasSnapshot: true,
      revision: 4,
      source: 'cache' as const,
      refreshing: true,
    };
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe('/api/atlas/status');
      return Response.json(response);
    }) as typeof fetch;

    expect(await fetchStatus()).toEqual(response);
  });

  test('uses the index endpoint for an explicit reindex', async () => {
    let requestedUrl = '';
    let requestedMethod = '';
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? 'GET';
      return Response.json({ ok: true });
    }) as typeof fetch;

    await reindexAtlas();

    expect(requestedUrl).toBe('/api/atlas/index');
    expect(requestedMethod).toBe('POST');
  });
});
