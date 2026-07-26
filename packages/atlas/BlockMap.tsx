import { memo, useMemo } from 'react';
import { FileCode2, Folder } from 'lucide-react';
import { squarify } from './treemap';
import { formatBytes, formatNumber } from './format';
import type { AtlasNode, ColorMetric, SizeMetric } from './types';
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

function metricValue(node: AtlasNode, metric: SizeMetric): number {
  if (metric === 'bytes') return Math.max(1, node.bytes);
  if (metric === 'complexity') return Math.max(1, node.complexity);
  return Math.max(1, node.lines);
}

function nodeColor(node: AtlasNode, metric: ColorMetric, max: number): string {
  if (metric === 'language') return LANGUAGE_COLORS[(node.language ?? 'unknown').toLowerCase()] ?? '#64748b';
  const value = metric === 'complexity' ? node.complexity : node.lines;
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

type Relationship = 'selected' | 'incoming' | 'outgoing' | 'both' | 'unrelated' | undefined;

interface BlockMapProps {
  nodes: AtlasNode[];
  root: AtlasNode;
  sizeMetric: SizeMetric;
  colorMetric: ColorMetric;
  query: string;
  selectedId: string | null;
  relationships?: Map<string, Relationship>;
  onSelect: (node: AtlasNode) => void;
  onOpen: (node: AtlasNode) => void;
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

function createBlocks(
  parent: AtlasNode,
  byId: Map<string, AtlasNode>,
  metric: SizeMetric,
  width: number,
  height: number,
  depth = 0,
  offsetX = 0,
  offsetY = 0,
): RenderBlock[] {
  const children = parent.childIds.map((id) => byId.get(id)).filter((node): node is AtlasNode => Boolean(node));
  const rects = squarify(
    children.map((node) => ({ item: node, id: node.id, value: metricValue(node, metric) })),
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
  sizeMetric,
  colorMetric,
  query,
  selectedId,
  relationships,
  onSelect,
  onOpen,
}: BlockMapProps) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const blocks = useMemo(
    () => createBlocks(root, byId, sizeMetric, width, height),
    [root, byId, sizeMetric, width, height],
  );
  const maxColorValueByDepth = useMemo(() => {
    const values = new Map<number, number>();
    for (const block of blocks) {
      const value = colorMetric === 'complexity' ? block.node.complexity : block.node.lines;
      values.set(block.depth, Math.max(values.get(block.depth) ?? 1, value));
    }
    return values;
  }, [blocks, colorMetric]);
  const visibleLanguages = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.language) continue;
      counts.set(node.language, (counts.get(node.language) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([language]) => language);
  }, [nodes]);
  const normalizedQuery = query.trim().toLowerCase();

  return (
    <div ref={ref} className="atlas-block-map" role="tree" aria-label={`Contents of ${root.path || root.name}`}>
      {blocks.map(({ node, x, y, width: blockWidth, height: blockHeight, depth, container }) => {
        const compact = blockWidth < 105 || blockHeight < 58;
        const tiny = blockWidth < 52 || blockHeight < 30;
        const matches = !normalizedQuery || node.path.toLowerCase().includes(normalizedQuery);
        const relationship = relationships?.get(node.id);
        const dimmed = !matches || relationship === 'unrelated';
        const value = sizeMetric === 'bytes' ? formatBytes(node.bytes) : formatNumber(metricValue(node, sizeMetric));
        return (
          <button
            type="button"
            role="treeitem"
            aria-label={`${node.kind} ${node.path}, ${value} ${sizeMetric}`}
            key={`${node.id}:${depth}`}
            className={`atlas-block atlas-block--${node.kind} atlas-block--${relationship ?? 'normal'}${container ? ' is-container' : ''}${selectedId === node.id ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
            style={{
              left: x + 1,
              top: y + 1,
              width: Math.max(0, blockWidth - 2),
              height: Math.max(0, blockHeight - 2),
              zIndex: depth + 1,
              '--block-color': nodeColor(node, colorMetric, maxColorValueByDepth.get(depth) ?? 1),
            } as React.CSSProperties}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onOpen(node);
            }}
            title={`${node.path}\n${formatNumber(node.lines)} lines · ${formatBytes(node.bytes)} · complexity ${formatNumber(node.complexity)}`}
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
          </button>
        );
      })}
      <div className={`atlas-color-legend atlas-color-legend--${colorMetric}`}>
        {colorMetric === 'language' ? (
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
      {blocks.length === 0 && width > 0 && <div className="atlas-empty">This directory is empty.</div>}
    </div>
  );
});
