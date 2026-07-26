import { afterEach, describe, expect, test } from 'bun:test';
import { fetchCallHierarchy, fetchReferences } from './api';
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
