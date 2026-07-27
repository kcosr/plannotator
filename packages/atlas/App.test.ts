import { describe, expect, test } from 'bun:test';
import { AtlasRequestError, type AtlasIndexStatus } from './api';
import {
  ATLAS_POLL_RETRY_DELAYS_MS,
  atlasCanReindex,
  atlasIndexFailure,
  atlasPollingFailure,
} from './App';

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

  test('preserves a terminal capability so futile reindex controls can be hidden', () => {
    const checking: AtlasIndexStatus = {
      status: 'indexing',
      phase: 'checking',
      hasSnapshot: false,
      revision: 0,
      refreshing: true,
      persistent: false,
    };
    const capability = {
      available: false,
      code: 'no-local-checkout',
      message: 'This review has no local checkout.',
      retryable: false,
    };

    const failure = atlasIndexFailure(
      checking,
      new AtlasRequestError(capability.message, 409, capability),
    );

    expect(failure.status.capability).toEqual(capability);
    expect(failure.status.capability?.retryable).toBe(false);
    expect(atlasCanReindex(failure.status)).toBe(false);
  });
});

describe('atlasPollingFailure', () => {
  test('fails fast on non-retryable capability errors', () => {
    const failure = atlasPollingFailure(new AtlasRequestError(
      'This review has no local checkout.',
      409,
      {
        available: false,
        code: 'no-local-checkout',
        message: 'This review has no local checkout.',
        retryable: false,
      },
    ), 0);

    expect(failure).toEqual({
      message: 'This review has no local checkout.',
      retryable: false,
      retryDelayMs: null,
    });
  });

  test('backs off transient failures and stops after the retry budget', () => {
    const reason = new AtlasRequestError('temporarily unavailable', 503);

    expect(ATLAS_POLL_RETRY_DELAYS_MS.map((_, failureCount) =>
      atlasPollingFailure(reason, failureCount).retryDelayMs
    )).toEqual([900, 1_800, 3_600]);
    expect(atlasPollingFailure(reason, ATLAS_POLL_RETRY_DELAYS_MS.length)).toEqual({
      message: 'temporarily unavailable',
      retryable: true,
      retryDelayMs: null,
    });
  });
});
