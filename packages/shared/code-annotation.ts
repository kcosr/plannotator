export interface ImageAttachment {
  path: string;
  name: string;
}

export type CodeAnnotationType = 'comment' | 'suggestion' | 'concern';

// General comments have no file anchor. Consumers must branch on scope before
// interpreting filePath or line coordinates.
export type CodeAnnotationScope = 'line' | 'file' | 'general';

export type ConventionalLabel =
  | 'praise'
  | 'nitpick'
  | 'suggestion'
  | 'issue'
  | 'todo'
  | 'question'
  | 'thought'
  | 'chore'
  | 'note'
  | 'typo'
  | 'polish'
  | (string & {});

export type ConventionalDecoration = 'blocking' | 'non-blocking' | 'if-minor';

export interface CodeAnnotation {
  id: string;
  type: CodeAnnotationType;
  scope?: CodeAnnotationScope;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
  text?: string;
  images?: ImageAttachment[];
  suggestedCode?: string;
  originalCode?: string;
  charStart?: number;
  charEnd?: number;
  tokenText?: string;
  createdAt: number;
  author?: string;
  source?: string;
  atlasSnapshotGeneratedAt?: string;
  severity?: 'important' | 'nit' | 'pre_existing';
  reasoning?: string;
  reviewProfileLabel?: string;
  conventionalLabel?: ConventionalLabel;
  decorations?: ConventionalDecoration[];
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prRepo?: string;
  diffScope?: 'layer' | 'full-stack';
  commitSha?: string;
  commitSubject?: string;
  gitButlerDiffType?: string;
  gitButlerDiffLabel?: string;
  gitButlerBase?: string;
  gitButlerSnapshotId?: string;
}
