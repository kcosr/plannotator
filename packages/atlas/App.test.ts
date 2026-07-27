import { describe, expect, test } from 'bun:test';
import type { AtlasIndexStatus } from './api';
import { atlasIndexFailure } from './App';

describe('atlasIndexFailure', () => {
  test('ends polling when a later request fails before the first snapshot', () => {
    const indexing: AtlasIndexStatus = {
      status: 'indexing',
      phase: 'indexing',
      hasSnapshot: false,
      revision: 0,
      refreshing: true,
      persistent: false,
    };

    const failure = atlasIndexFailure(indexing, new Error('status endpoint disconnected'));

    expect(failure.message).toBe('status endpoint disconnected');
    expect(failure.status).toMatchObject({
      status: 'error',
      phase: 'error',
      hasSnapshot: false,
      refreshing: false,
      error: 'status endpoint disconnected',
    });
  });

  test('retains snapshot availability while ending a failed refresh', () => {
    const refreshing: AtlasIndexStatus = {
      status: 'indexing',
      phase: 'indexing',
      hasSnapshot: true,
      revision: 3,
      refreshing: true,
      persistent: true,
    };

    const failure = atlasIndexFailure(refreshing, 'refresh failed');

    expect(failure.status).toMatchObject({
      status: 'error',
      phase: 'error',
      hasSnapshot: true,
      revision: 3,
      refreshing: false,
    });
  });
});
