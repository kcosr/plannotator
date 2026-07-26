import type {
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  ImageAttachment,
} from '@plannotator/shared/code-annotation';
export type {
  CodeAnnotation,
  CodeAnnotationScope,
  CodeAnnotationType,
  ConventionalDecoration,
  ConventionalLabel,
  ImageAttachment,
} from '@plannotator/shared/code-annotation';

export enum AnnotationType {
  DELETION = 'DELETION',
  COMMENT = 'COMMENT',
  GLOBAL_COMMENT = 'GLOBAL_COMMENT',
}

export type EditorMode = 'selection' | 'comment' | 'redline' | 'quickLabel';

export type InputMethod = 'drag' | 'pinpoint';

/**
 * Compactness of the Viewer action button labels (Image / Comment / Copy).
 * Driven by measured plan-area width so the cluster collapses responsively
 * when the side panel squeezes the plan.
 *   full  → "Global comment" / "Copy plan"
 *   short → "Comment" / "Copy"
 *   icon  → labels hidden entirely
 */
export type ActionsLabelMode = 'full' | 'short' | 'icon';

export type WideModeType = 'wide' | 'focus';

/** DOM-relative text position used to restore a document annotation selection. */
export interface AnnotationTextMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

/** Durable, media-specific location for a note created in the PR artifact viewer. */
export type ArtifactAnnotationAnchor =
  | {
      kind: 'document';
      originalText: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      startMeta?: AnnotationTextMeta;
      endMeta?: AnnotationTextMeta;
    }
  | { kind: 'image'; x: number; y: number }
  | { kind: 'video'; timestamp: number }
  | { kind: 'page' };

/** Context shared by description and comment annotations created on a PR artifact. */
export interface ArtifactAnnotationMeta {
  artifactId: string;
  artifactName: string;
  artifactUrl: string;
  artifactKind: 'image' | 'gif' | 'video' | 'html' | 'markdown';
  sourceUrl: string;
  anchor: ArtifactAnnotationAnchor;
}

export interface Annotation {
  id: string;
  blockId: string; // Legacy - not used with web-highlighter
  startOffset: number; // Legacy
  endOffset: number; // Legacy
  type: AnnotationType;
  text?: string; // For comments
  originalText: string; // The text that was selected
  createdA: number;
  author?: string; // Tater identity for collaborative sharing
  source?: string; // External tool identifier (e.g., "eslint") — set when annotation comes from external API
  images?: ImageAttachment[]; // Attached images with human-readable names
  isQuickLabel?: boolean; // true if created via quick label chip
  quickLabelTip?: string; // optional instruction tip from the label definition
  diffContext?: 'added' | 'removed' | 'modified'; // set when annotation created in plan diff view
  artifact?: ArtifactAnnotationMeta; // code-review artifact viewer anchor + source context
  mathTargets?: Array<{
    blockId: string;
    tex: string;
    displayMode: boolean;
  }>; // math elements covered by a mixed text+formula selection
  prUrl?: string; // code-review PR mode: the PR this note belongs to, so it isn't shown/exported against another PR after an in-place switch
  // web-highlighter metadata for cross-element selections
  startMeta?: AnnotationTextMeta;
  endMeta?: AnnotationTextMeta;
}

export type AlertKind = 'note' | 'tip' | 'warning' | 'caution' | 'important';

export interface Block {
  id: string;
  type: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'hr' | 'table' | 'html' | 'directive' | 'math';
  content: string; // Plain text, or raw (unsanitized) HTML for type === 'html'
  level?: number; // For headings (1-6) or list indentation
  language?: string; // For code blocks (e.g., 'rust', 'typescript')
  checked?: boolean; // For checkbox list items (true = checked, false = unchecked, undefined = not a checkbox)
  ordered?: boolean; // For list items: true when source marker was \d+.
  orderedStart?: number; // For ordered list items: integer parsed from the marker (e.g. 5 for "5.")
  alertKind?: AlertKind; // For blockquotes starting with [!NOTE] / [!TIP] / etc.
  directiveKind?: string; // For directive containers (e.g. ':::note' → 'note')
  order: number; // Sorting order
  startLine: number; // 1-based line number in source
  sourceLineCount?: number; // Number of source lines consumed when it differs from content lines
}

export interface DiffResult {
  original: string;
  modified: string;
  diffText: string;
}

/**
 * A note attached to a whole PR comment/review/thread (code-review Phase 2).
 * Button-driven (not text-anchored): the reviewer clicks "Annotate" on a card
 * and leaves a note. The comment body travels with it so the agent — which
 * can't see PR discussion — receives the full context on export.
 */
export interface CommentAnnotation {
  id: string;
  commentId: string;      // the timeline entry id (matches data-comment-id on the card)
  commentAuthor: string;
  commentBody: string;
  text: string;           // the reviewer's note
  createdAt: number;
  prUrl?: string;         // the PR this note belongs to (see Annotation.prUrl)
  artifact?: ArtifactAnnotationMeta; // optional artifact anchor within this source comment
}

/** Token-level metadata passed from selection to annotation creation. */
export interface TokenAnnotationMeta {
  charStart: number;
  charEnd: number;
  tokenText: string;
}

/** Severity display styles — shared between agent detail panel and inline diff annotations. */
export const SEVERITY_STYLES: Record<string, { dot: string; label: string }> = {
  important: { dot: 'bg-destructive', label: 'Important' },
  nit: { dot: 'bg-amber-500', label: 'Nit' },
  pre_existing: { dot: 'bg-muted-foreground', label: 'Pre-existing' },
};

// For @pierre/diffs integration
export interface DiffAnnotationMetadata {
  annotationId: string;
  type: CodeAnnotationType;
  text?: string;
  suggestedCode?: string;
  originalCode?: string;
  author?: string;
  severity?: 'important' | 'nit' | 'pre_existing';
  reasoning?: string;
  conventionalLabel?: ConventionalLabel;
  decorations?: ConventionalDecoration[];
  // Shared comment-meta fields (so the inline diff card shows the same identity
  // row — author, time, badges — as the sidebar and file-banner cards).
  createdAt?: number;
  reviewProfileLabel?: string;
  source?: string;
  /** Precomputed clipboard text (location prefix + body + reasoning) so the
   *  inline copy action matches the sidebar/banner — the inline card only has
   *  the projected metadata, not the full annotation. */
  copyText?: string;
  // AI marker fields (set when kind === 'ai-marker')
  kind?: 'annotation' | 'ai-marker';
  questionId?: string;
  promptPreview?: string;
  hasResponse?: boolean;
  isStreaming?: boolean;
}

export interface SelectedLineRange {
  start: number;
  end: number;
  side: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

// ---------------------------------------------------------------------------
// AI Chat (inline AI on diffs)
// ---------------------------------------------------------------------------

export interface AIQuestion {
  id: string;
  prompt: string;
  scope?: {
    kind: 'general' | 'selection';
    label?: string;
    text?: string;
    sourcePath?: string;
  };
  /** undefined = general question (no file scope) */
  filePath?: string;
  /** undefined + filePath present = file-scoped; with filePath = line-scoped */
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
  createdAt: number;
}

export interface AIResponse {
  questionId: string;
  text: string;
  isStreaming: boolean;
  error?: string;
  createdAt: number;
}

export interface VaultNode {
  name: string;
  path: string; // relative path within vault
  type: "file" | "folder";
  children?: VaultNode[];
}

export type { EditorAnnotation } from '@plannotator/core/types';

export type {
  ExternalAnnotationEvent,
} from '@plannotator/core/external-annotation';

export type {
  AgentJobInfo,
  AgentJobEvent,
  AgentJobStatus,
  AgentCapability,
  AgentCapabilities,
} from '@plannotator/core/agent-jobs';
