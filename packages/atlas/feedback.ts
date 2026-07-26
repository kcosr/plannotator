import type { CodeAnnotation } from '@plannotator/shared/code-annotation';

export function formatAtlasFeedback(annotations: CodeAnnotation[]): string {
  if (annotations.length === 0) return '';
  const ordered = [...annotations].sort(
    (first, second) =>
      first.filePath.localeCompare(second.filePath)
      || first.lineStart - second.lineStart
      || first.createdAt - second.createdAt,
  );
  return [
    '## Codebase Atlas feedback',
    '',
    ...ordered.flatMap((annotation) => {
      const lines = annotation.lineStart === annotation.lineEnd
        ? `line ${annotation.lineStart}`
        : `lines ${annotation.lineStart}-${annotation.lineEnd}`;
      return [
        `### ${annotation.filePath}:${annotation.lineStart}`,
        '',
        `${lines}: ${annotation.text}`,
        ...(annotation.originalCode
          ? ['', '```', annotation.originalCode, '```']
          : []),
        '',
      ];
    }),
  ].join('\n').trimEnd();
}

export function formatAtlasAnnotationSummary(annotations: CodeAnnotation[]): string {
  return annotations
    .map((annotation) =>
      `- ${annotation.filePath}:${annotation.lineStart}-${annotation.lineEnd}: ${annotation.text}`,
    )
    .join('\n');
}
