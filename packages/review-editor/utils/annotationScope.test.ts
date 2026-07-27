import { describe, expect, test } from 'bun:test';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  annotationMatchesReviewContext,
  formatAnnotationAIContext,
} from './annotationScope';

function annotation(overrides: Partial<CodeAnnotation> = {}): CodeAnnotation {
  return {
    id: 'note',
    type: 'comment',
    filePath: 'src/service.ts',
    lineStart: 10,
    lineEnd: 12,
    side: 'new',
    text: 'Check the callers.',
    createdAt: 1,
    ...overrides,
  };
}

describe('Atlas annotation review context', () => {
  test('is independent of diff scope but isolated to its PR', () => {
    const atlas = annotation({
      source: 'atlas',
      prUrl: 'https://github.com/acme/repo/pull/7',
      diffScope: 'layer',
    });

    expect(annotationMatchesReviewContext(
      atlas,
      'https://github.com/acme/repo/pull/7',
      'full-stack',
    )).toBe(true);
    expect(annotationMatchesReviewContext(
      atlas,
      'https://github.com/acme/repo/pull/8',
      'layer',
    )).toBe(false);
  });

  test('keeps ordinary diff annotations scoped to their diff projection', () => {
    expect(annotationMatchesReviewContext(
      annotation({ diffScope: 'layer' }),
      undefined,
      'full-stack',
    )).toBe(false);
  });

  test('labels Atlas positions as codebase source coordinates for AI', () => {
    expect(formatAnnotationAIContext(annotation({ source: 'atlas' }))).toBe(
      '- [codebase source coordinates] src/service.ts:10-12: Check the callers.',
    );
    expect(formatAnnotationAIContext(annotation())).toContain(
      '[new diff coordinates]',
    );
  });
});
