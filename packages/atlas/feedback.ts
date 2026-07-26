import type { AtlasAnnotation } from './types';

export function formatAtlasFeedback(annotations: AtlasAnnotation[]): string {
  if (annotations.length === 0) return '';
  const ordered = [...annotations].sort(
    (first, second) =>
      first.filePath.localeCompare(second.filePath)
      || first.lineStart - second.lineStart
      || first.createdAt.localeCompare(second.createdAt),
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
        ...(annotation.selectedCode
          ? ['', '```', annotation.selectedCode, '```']
          : []),
        '',
      ];
    }),
  ].join('\n').trimEnd();
}

export function formatAtlasAnnotationSummary(annotations: AtlasAnnotation[]): string {
  return annotations
    .map((annotation) =>
      `- ${annotation.filePath}:${annotation.lineStart}-${annotation.lineEnd}: ${annotation.text}`,
    )
    .join('\n');
}
