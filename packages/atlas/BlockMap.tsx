import { memo, useMemo } from 'react';
import { FileCode2, Folder } from 'lucide-react';
import { squarify } from './treemap';
import {
  codeFilterLabel,
  filteredComplexity,
  filteredLines,
  filteredMetric,
  nodeMatchesFilter,
} from './codeFilter';
import { formatBytes, formatNumber } from './format';
import type { AtlasNode, CodeFilter, ColorMetric, SizeMetric } from './types';
import { useElementSize } from './useElementSize';

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3b82f6',
  tsx: '#0ea5e9',
  javascript: '#eab308',
  jsx: '#f59e0b',
  python: '#22c55e',
  rust: '#f97316',
  go: '#06b6d4',
  java: '#ef4444',
  ruby: '#e11d48',
  css: '#a855f7',
  html: '#ec4899',
  json: '#84cc16',
  markdown: '#64748b',
  shell: '#10b981',
  unknown: '#64748b',
};

function metricValue(node: AtlasNode, filter: CodeFilter, metric: SizeMetric): number {
  return Math.max(1, filteredMetric(node, filter, metric));
}

function nodeColor(node: AtlasNode, filter: CodeFilter, metric: ColorMetric, max: number): string {
  if (metric === 'language') return LANGUAGE_COLORS[(node.language ?? 'unknown').toLowerCase()] ?? '#64748b';
  const value = metric === 'complexity' ? filteredComplexity(node, filter) : filteredLines(node, filter);
  const ratio = Math.min(1, Math.sqrt(value / Math.max(1, max)));
  if (metric === 'complexity') {
    if (ratio <= 0.5) {
      return `color-mix(in oklab, #eab308 ${Math.round(ratio * 200)}%, #2563eb)`;
    }
    return `color-mix(in oklab, #ef4444 ${Math.round((ratio - 0.5) * 200)}%, #eab308)`;
  }
  return `color-mix(in oklab, #a855f7 ${Math.round(ratio * 100)}%, #14b8a6)`;
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    css: 'CSS',
    go: 'Go',
    html: 'HTML',
    javascript: 'JavaScript',
    jsx: 'JSX',
    json: 'JSON',
    markdown: 'Markdown',
    python: 'Python',
    ruby: 'Ruby',
    rust: 'Rust',
    shell: 'Shell',
    tsx: 'TSX',
    typescript: 'TypeScript',
  };
  return labels[language] ?? language;
}

export type BlockMapDependencyRelationship =
  | 'selected'
  | 'incoming'
  | 'outgoing'
  | 'both'
  | 'unrelated'
  | undefined;

export type BlockMapImpactRelationship =
  | 'direct'
  | 'impacted'
  | 'caller'
  | 'callee'
  | 'reference';

export interface BlockMapChangeMetrics {
  additions: number;
  deletions: number;
  changedLines?: number;
  changedSymbols?: number;
  changedFiles?: number;
}

export interface BlockMapNodeOverlay {
  changes?: BlockMapChangeMetrics;
  /** Explicit heat intensity from 0 to 1. Derived from changed lines when omitted. */
  intensity?: number;
  /** True only for nodes directly touched by the changeset, not inferred impact. */
  directChange?: boolean;
  relationship?: BlockMapImpactRelationship;
}

export interface BlockMapOverlay {
  nodes: ReadonlyMap<string, BlockMapNodeOverlay>;
  /** Fade nodes with no overlay entry while preserving their spatial context. */
  dimUnspecified?: boolean;
  /** Show compact additions/deletions labels when a block has enough room. */
  showMetrics?: boolean;
}

export interface BlockMapActivation {
  kind: 'select' | 'open';
  node: AtlasNode;
  overlay?: BlockMapNodeOverlay;
}

export interface BlockMapProps {
  nodes: AtlasNode[];
  root: AtlasNode;
  codeFilter: CodeFilter;
  sizeMetric: SizeMetric;
  colorMetric: ColorMetric;
  query: string;
  selectedId: string | null;
  relationships?: ReadonlyMap<string, BlockMapDependencyRelationship>;
  overlay?: BlockMapOverlay;
  /**
   * Own block navigation in an embedded view. When provided, the legacy
   * select/open callbacks are not called.
   */
  onActivate?: (activation: BlockMapActivation) => void;
  onSelect?: (node: AtlasNode) => void;
  onOpen?: (node: AtlasNode) => void;
}

interface RenderBlock {
  node: AtlasNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  container: boolean;
}

interface ResolvedBlockMapNodeOverlay extends BlockMapNodeOverlay {
  intensity: number;
  changedLines: number;
  changeColor: string;
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

export function blockMapChangedLines(changes: BlockMapChangeMetrics | undefined): number {
  if (!changes) return 0;
  if (changes.changedLines !== undefined) return finiteNonNegative(changes.changedLines);
  return finiteNonNegative(changes.additions) + finiteNonNegative(changes.deletions);
}

export function blockMapChangeColor(changes: BlockMapChangeMetrics | undefined): string {
  const additions = finiteNonNegative(changes?.additions);
  const deletions = finiteNonNegative(changes?.deletions);
  if (additions > deletions) return '#22c55e';
  if (deletions > additions) return '#ef4444';
  return '#eab308';
}

export function blockMapOverlayMaximum(overlay: BlockMapOverlay | undefined): number {
  if (!overlay) return 0;
  let maximum = 0;
  for (const nodeOverlay of overlay.nodes.values()) {
    maximum = Math.max(maximum, blockMapChangedLines(nodeOverlay.changes));
  }
  return maximum;
}

export function resolveBlockMapNodeOverlay(
  overlay: BlockMapOverlay | undefined,
  nodeId: string,
  maximumChangedLines = blockMapOverlayMaximum(overlay),
): ResolvedBlockMapNodeOverlay | undefined {
  const nodeOverlay = overlay?.nodes.get(nodeId);
  if (!nodeOverlay) return undefined;
  const changedLines = blockMapChangedLines(nodeOverlay.changes);
  const derivedIntensity = maximumChangedLines > 0
    ? Math.sqrt(changedLines / maximumChangedLines)
    : 0;
  const intensity = Math.min(
    1,
    Math.max(0, Number.isFinite(nodeOverlay.intensity) ? nodeOverlay.intensity! : derivedIntensity),
  );
  return {
    ...nodeOverlay,
    intensity,
    changedLines,
    changeColor: blockMapChangeColor(nodeOverlay.changes),
  };
}

export function blockMapQueryMatches(
  nodes: AtlasNode[],
  query: string,
): ReadonlySet<string> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const matches = new Set<string>();
  for (const node of nodes) {
    if (!node.path.toLowerCase().includes(normalized)) continue;
    let current: AtlasNode | undefined = node;
    while (current) {
      matches.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return matches;
}

function createBlocks(
  parent: AtlasNode,
  byId: Map<string, AtlasNode>,
  filter: CodeFilter,
  metric: SizeMetric,
  width: number,
  height: number,
  depth = 0,
  offsetX = 0,
  offsetY = 0,
): RenderBlock[] {
  const children = parent.childIds
    .map((id) => byId.get(id))
    .filter((node): node is AtlasNode => node != null && nodeMatchesFilter(node, filter));
  const rects = squarify(
    children.map((node) => ({
      item: node,
      id: node.id,
      value: metricValue(node, filter, metric),
    })),
    width,
    height,
  );
  const blocks: RenderBlock[] = [];
  for (const rect of rects) {
    const x = offsetX + rect.x;
    const y = offsetY + rect.y;
    const container =
      rect.item.kind !== 'file'
      && rect.item.childIds.length > 0
      && rect.width > 150
      && rect.height > 100
      && depth < 3;
    blocks.push({ node: rect.item, x, y, width: rect.width, height: rect.height, depth, container });
    if (container) {
      const inset = 5;
      const header = rect.height > 60 ? 25 : 0;
      blocks.push(...createBlocks(
        rect.item,
        byId,
        filter,
        metric,
        Math.max(0, rect.width - inset * 2),
        Math.max(0, rect.height - header - inset),
        depth + 1,
        x + inset,
        y + header,
      ));
    }
  }
  return blocks;
}

export const BlockMap = memo(function BlockMap({
  nodes,
  root,
  codeFilter,
  sizeMetric,
  colorMetric,
  query,
  selectedId,
  relationships,
  overlay,
  onActivate,
  onSelect,
  onOpen,
}: BlockMapProps) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const blocks = useMemo(
    () => createBlocks(root, byId, codeFilter, sizeMetric, width, height),
    [root, byId, codeFilter, sizeMetric, width, height],
  );
  const maxColorValueByDepth = useMemo(() => {
    const values = new Map<number, number>();
    for (const block of blocks) {
      const value = colorMetric === 'complexity'
        ? filteredComplexity(block.node, codeFilter)
        : filteredLines(block.node, codeFilter);
      values.set(block.depth, Math.max(values.get(block.depth) ?? 1, value));
    }
    return values;
  }, [blocks, codeFilter, colorMetric]);
  const visibleLanguages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.language || !nodeMatchesFilter(node, codeFilter)) continue;
      counts.set(node.language, (counts.get(node.language) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([language]) => language);
  }, [nodes, codeFilter]);
  const maximumChangedLines = useMemo(() => blockMapOverlayMaximum(overlay), [overlay]);
  const queryMatches = useMemo(() => blockMapQueryMatches(nodes, query), [nodes, query]);

  return (
    <div ref={ref} className="atlas-block-map" role="tree" aria-label={`Contents of ${root.path || root.name}`}>
      {blocks.map(({ node, x, y, width: blockWidth, height: blockHeight, depth, container }) => {
        const compact = blockWidth < 105 || blockHeight < 58;
        const tiny = blockWidth < 52 || blockHeight < 30;
        const matches = queryMatches.has(node.id);
        const relationship = relationships?.get(node.id);
        const nodeOverlay = resolveBlockMapNodeOverlay(overlay, node.id, maximumChangedLines);
        const overlayRelationship = nodeOverlay?.relationship;
        const dimmed =
          !matches
          || relationship === 'unrelated'
          || Boolean(overlay?.dimUnspecified && !nodeOverlay);
        const rawValue = filteredMetric(node, codeFilter, sizeMetric);
        const value = sizeMetric === 'bytes' ? formatBytes(rawValue) : formatNumber(rawValue);
        const lines = filteredLines(node, codeFilter);
        return (
          <button
            type="button"
            role="treeitem"
            aria-label={`${node.kind} ${node.path}, ${value} ${sizeMetric}`}
            key={`${node.id}:${depth}`}
            className={`atlas-block atlas-block--${node.kind} atlas-block--${relationship ?? 'normal'}${overlayRelationship ? ` atlas-block--impact-${overlayRelationship}` : ''}${nodeOverlay ? ' has-change-overlay' : ''}${nodeOverlay?.directChange ? ' is-direct-change' : ''}${container ? ' is-container' : ''}${selectedId === node.id ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
            style={{
              left: x + 1,
              top: y + 1,
              width: Math.max(0, blockWidth - 2),
              height: Math.max(0, blockHeight - 2),
              zIndex: depth + 1,
              '--block-color': nodeColor(node, codeFilter, colorMetric, maxColorValueByDepth.get(depth) ?? 1),
              ...(nodeOverlay && {
                '--change-intensity': `${Math.round(nodeOverlay.intensity * 72)}%`,
                '--change-color': nodeOverlay.changeColor,
              }),
            } as React.CSSProperties}
            onClick={(event) => {
              event.stopPropagation();
              if (onActivate) onActivate({ kind: 'select', node, overlay: nodeOverlay });
              else onSelect?.(node);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (onActivate) onActivate({ kind: 'open', node, overlay: nodeOverlay });
              else onOpen?.(node);
            }}
            title={`${node.path}\n${formatNumber(lines)} ${codeFilterLabel(codeFilter)} lines · ${formatBytes(filteredMetric(node, codeFilter, 'bytes'))} · complexity ${formatNumber(filteredComplexity(node, codeFilter))}${nodeOverlay?.changes ? `\nChanges: +${formatNumber(finiteNonNegative(nodeOverlay.changes.additions))} −${formatNumber(finiteNonNegative(nodeOverlay.changes.deletions))}${nodeOverlay.changes.changedSymbols !== undefined ? ` · ${formatNumber(finiteNonNegative(nodeOverlay.changes.changedSymbols))} symbols` : ''}` : ''}`}
          >
            {!tiny && (
              <span className="atlas-block__title">
                {node.kind === 'file' ? <FileCode2 aria-hidden size={compact ? 11 : 13} /> : <Folder aria-hidden size={compact ? 11 : 13} />}
                <span>{node.name}</span>
              </span>
            )}
            {!compact && (
              <span className="atlas-block__meta">
                {node.language && <span>{node.language}</span>}
                <span>{value}{sizeMetric === 'lines' ? ' lines' : sizeMetric === 'complexity' ? ' cx' : ''}</span>
              </span>
            )}
            {!compact && overlay?.showMetrics && nodeOverlay?.changes && (
              <span className="atlas-block__change">
                +{formatNumber(finiteNonNegative(nodeOverlay.changes.additions))}
                {' '}−{formatNumber(finiteNonNegative(nodeOverlay.changes.deletions))}
              </span>
            )}
          </button>
        );
      })}
      <div className={`atlas-color-legend atlas-color-legend--${overlay ? 'changes' : colorMetric}`}>
        {overlay ? (
          <>
            <strong>Diff heat</strong>
            <span>Net −</span>
            <i className="atlas-color-scale" />
            <span>Net +</span>
          </>
        ) : colorMetric === 'language' ? (
          visibleLanguages.map((language) => (
            <span key={language}>
              <i style={{ '--legend-color': LANGUAGE_COLORS[language.toLowerCase()] ?? LANGUAGE_COLORS.unknown } as React.CSSProperties} />
              {languageLabel(language)}
            </span>
          ))
        ) : (
          <>
            <strong>{colorMetric === 'complexity' ? 'Complexity' : 'Size'}</strong>
            <span>Low</span>
            <i className="atlas-color-scale" />
            <span>High</span>
          </>
        )}
      </div>
      {blocks.length === 0 && width > 0 && (
        <div className="atlas-empty">
          {codeFilter === 'tests'
            ? 'No indexed tests in this directory.'
            : codeFilter === 'no-tests'
              ? 'This directory contains only indexed tests.'
              : 'This directory is empty.'}
        </div>
      )}
    </div>
  );
});
