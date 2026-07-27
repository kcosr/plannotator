import { describe, expect, test } from 'bun:test';
import {
  buildPlatformReviewBody,
  buildReviewSubmission,
  type SubmissionTarget,
} from './ReviewSubmissionDialog';
import type { CodeAnnotation } from '@plannotator/ui/types';

const inlineComment: SubmissionTarget['fileComments'][number] = {
  path: 'src/example.ts',
  line: 12,
  side: 'RIGHT',
  body: 'Handle the error here.',
};

describe('buildPlatformReviewBody', () => {
  test('contains only user-authored top-level feedback when present', () => {
    expect(buildPlatformReviewBody('comment', 'github', 'Overall feedback', {
      fileComments: [inlineComment],
      fileScopedBody: '**src/example.ts:** File-level feedback',
    })).toBe('Overall feedback\n\n**src/example.ts:** File-level feedback');
  });

  test('uses a neutral GitHub body for an inline-only comment review', () => {
    expect(buildPlatformReviewBody('comment', 'github', '   ', {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('See inline comments.');
  });

  test('does not manufacture a GitLab note for inline-only comments', () => {
    expect(buildPlatformReviewBody('comment', 'gitlab', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });

  test('does not manufacture an approval body', () => {
    expect(buildPlatformReviewBody('approve', 'github', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });
});

describe('buildReviewSubmission', () => {
  test('routes Atlas source annotations to the review body, never inline comments', () => {
    const annotation: CodeAnnotation = {
      id: 'atlas-note',
      type: 'comment',
      scope: 'line',
      filePath: 'src/service.ts',
      lineStart: 14,
      lineEnd: 16,
      side: 'new',
      text: 'Check every caller before changing this contract.',
      originalCode: 'return serve(request);',
      createdAt: 1,
      source: 'atlas',
    };

    const submission = buildReviewSubmission(
      [annotation],
      [],
      'https://github.com/acme/repo/pull/7',
      new Set(['src/service.ts']),
    );

    expect(submission.targets).toHaveLength(1);
    expect(submission.targets[0]?.fileComments).toEqual([]);
    expect(submission.targets[0]?.fileScopedBody).toContain(
      '**src/service.ts:14-16 (codebase source):** Check every caller',
    );
    expect(submission.targets[0]?.fileScopedBody).toContain('return serve(request);');
  });
});
