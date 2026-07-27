import { describe, expect, test } from 'bun:test';
import { AtlasRequestError } from '@plannotator/atlas';
import { reviewAtlasRequestFailure } from './ReviewAtlasSurface';

describe('reviewAtlasRequestFailure', () => {
  test('preserves a non-retryable capability message', () => {
    const failure = reviewAtlasRequestFailure(new AtlasRequestError(
      'Conflict',
      409,
      {
        available: false,
        code: 'multi-root-workspace',
        message: 'Atlas is unavailable for reviews spanning multiple repository roots.',
        retryable: false,
      },
    ));

    expect(failure).toEqual({
      unavailable: true,
      message: 'Atlas is unavailable for reviews spanning multiple repository roots.',
      retryable: false,
    });
  });

  test('keeps transient failures retryable', () => {
    expect(reviewAtlasRequestFailure(new AtlasRequestError(
      'Indexer temporarily unavailable',
      503,
    ))).toEqual({
      unavailable: false,
      message: 'Indexer temporarily unavailable',
      retryable: true,
    });
  });
});
