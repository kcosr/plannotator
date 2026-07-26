import { describe, expect, test } from 'bun:test';
import { formatAtlasAnnotationSummary, formatAtlasFeedback } from './feedback';
import type { CodeAnnotation } from '@plannotator/shared/code-annotation';

const annotation: CodeAnnotation = {
  id: 'one',
  type: 'comment',
  scope: 'line',
  filePath: 'src/main.ts',
  lineStart: 4,
  lineEnd: 6,
  side: 'new',
  text: 'Explain why this branch is necessary.',
  originalCode: 'if (ready) {\n  run();\n}',
  createdAt: Date.parse('2026-07-26T10:00:00.000Z'),
  source: 'atlas',
  atlasSnapshotGeneratedAt: '2026-07-26T09:59:00.000Z',
};

describe('Atlas feedback formatting', () => {
  test('formats source comments for agent submission', () => {
    const markdown = formatAtlasFeedback([annotation]);
    expect(markdown).toContain('## Codebase Atlas feedback');
    expect(markdown).toContain('### src/main.ts:4');
    expect(markdown).toContain('lines 4-6: Explain why');
    expect(markdown).toContain('if (ready)');
  });

  test('formats compact annotation updates for AI sessions', () => {
    expect(formatAtlasAnnotationSummary([annotation])).toBe(
      '- src/main.ts:4-6: Explain why this branch is necessary.',
    );
  });
});
