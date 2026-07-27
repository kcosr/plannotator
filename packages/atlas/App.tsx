import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Braces,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Code2,
  Columns3,
  FileCode2,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { DocumentAIChatPanel } from '@plannotator/ui/components/ai/DocumentAIChatPanel';
import { useAIChat } from '@plannotator/ui/hooks/useAIChat';
import { useAIProviderConfig } from '@plannotator/ui/hooks/useAIProviderConfig';
import { BlockMap } from './BlockMap';
import type {
  BlockMapActivation,
  BlockMapOverlay,
} from './BlockMap';
import {
  filteredBytes,
  filteredComplexity,
  filteredLines,
  nodeMatchesFilter,
  symbolMatchesFilter,
} from './codeFilter';
import { DirectoryTree } from './DirectoryTree';
import {
  SourceView,
  type AtlasSourceLoaders,
  type AtlasSourceNavigationTarget,
} from './SourceView';
import { SymbolMap } from './SymbolMap';
import {
  closeAtlas,
  fetchCallHierarchy,
  fetchReferences,
  fetchSnapshot,
  fetchSource,
  fetchStatus,
  reindexAtlas,
  submitAtlasFeedback,
} from './api';
import type { AtlasIndexStatus } from './api';
import { formatAtlasAnnotationSummary, formatAtlasFeedback } from './feedback';
import { formatBytes, formatNumber } from './format';
import type { CodeAnnotation } from '@plannotator/shared/code-annotation';
import type {
  AtlasDependency,
  AtlasNode,
  AtlasSnapshot,
  AtlasSourceAnnotationDraft,
  AtlasSymbol,
  AtlasView,
  CodeFilter,
  ColorMetric,
  SizeMetric,
} from './types';

const VIEWS: { id: AtlasView; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'overview', label: 'Overview', icon: Blocks },
  { id: 'symbols', label: 'Symbols', icon: Braces },
  { id: 'source', label: 'Source', icon: Code2 },
];

const DEFAULT_SOURCE_LOADERS: AtlasSourceLoaders = {
  loadSource: fetchSource,
  loadReferences: fetchReferences,
  loadCalls: fetchCallHierarchy,
};

export type AtlasWorkspaceSourceTarget = AtlasSourceNavigationTarget;

function descendants(node: AtlasNode, byId: Map<string, AtlasNode>): Set<string> {
  const ids = new Set<string>();
  const queue = [node.id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const current = byId.get(id);
    if (current) queue.push(...current.childIds);
  }
  return ids;
}

function formatIndexedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function relationshipMap(
  nodes: AtlasNode[],
  dependencies: AtlasDependency[],
  selected: AtlasNode | null,
): Map<string, 'selected' | 'incoming' | 'outgoing' | 'both' | 'unrelated'> {
  const result = new Map<string, 'selected' | 'incoming' | 'outgoing' | 'both' | 'unrelated'>();
  if (!selected) return result;
  if (selected.kind === 'root') return result;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedIds = descendants(selected, byId);
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const dependency of dependencies) {
    if (selectedIds.has(dependency.sourceId) && dependency.targetId) outgoing.add(dependency.targetId);
    if (dependency.targetId && selectedIds.has(dependency.targetId)) incoming.add(dependency.sourceId);
  }
  const relatedWithAncestors = (ids: Set<string>) => {
    const expanded = new Set(ids);
    for (const id of ids) {
      let cursor = byId.get(id);
      while (cursor?.parentId) {
        expanded.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
    }
    return expanded;
  };
  const incomingBranches = relatedWithAncestors(incoming);
  const outgoingBranches = relatedWithAncestors(outgoing);
  const selectedBranches = relatedWithAncestors(selectedIds);
  for (const node of nodes) {
    const hasIncoming = incomingBranches.has(node.id);
    const hasOutgoing = outgoingBranches.has(node.id);
    const isSelected = selectedIds.has(node.id) || selectedBranches.has(node.id);
    if (isSelected) result.set(node.id, 'selected');
    else if (hasIncoming && hasOutgoing) result.set(node.id, 'both');
    else if (hasIncoming) result.set(node.id, 'incoming');
    else if (hasOutgoing) result.set(node.id, 'outgoing');
    else result.set(node.id, 'unrelated');
  }
  return result;
}

function useAtlasData() {
  const [indexStatus, setIndexStatus] = useState<AtlasIndexStatus>({
    status: 'indexing',
    phase: 'checking',
    hasSnapshot: false,
    revision: -1,
    refreshing: true,
  });
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null);
  const [error, setError] = useState('');
  const loadedRevision = useRef<number | null>(null);

  const recordError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message);
    setIndexStatus((current) => ({
      ...current,
      status: 'error',
      phase: 'error',
      refreshing: false,
      error: message,
    }));
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = await fetchStatus(signal);
    setError(current.error ?? '');
    setIndexStatus(current);
    if (current.hasSnapshot && loadedRevision.current !== current.revision) {
      const data = await fetchSnapshot(signal);
      if (signal?.aborted) return;
      loadedRevision.current = current.revision;
      setSnapshot(data);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) recordError(reason);
    });
    return () => controller.abort();
  }, [load, recordError]);

  useEffect(() => {
    if (
      !indexStatus.refreshing
      && (indexStatus.status === 'ready' || indexStatus.status === 'error')
    ) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    const poll = async () => {
      try {
        await load(controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted) recordError(reason);
      }
      if (!controller.signal.aborted) timeout = window.setTimeout(poll, 900);
    };
    timeout = window.setTimeout(poll, 900);
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [indexStatus.refreshing, indexStatus.status, load, recordError]);

  const reindex = useCallback(async () => {
    setError('');
    setIndexStatus((current) => ({
      ...current,
      status: 'indexing',
      phase: 'indexing',
      refreshing: true,
      error: undefined,
    }));
    try {
      await reindexAtlas();
      await load();
    } catch (reason) {
      recordError(reason);
    }
  }, [load, recordError]);

  return { indexStatus, snapshot, error, reindex };
}

function Breadcrumbs({
  node,
  byId,
  onFocus,
}: {
  node: AtlasNode;
  byId: Map<string, AtlasNode>;
  onFocus: (node: AtlasNode) => void;
}) {
  const lineage: AtlasNode[] = [];
  let cursor: AtlasNode | undefined = node;
  while (cursor) {
    lineage.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return (
    <nav className="atlas-breadcrumbs" aria-label="Repository path">
      {lineage.map((part, index) => (
        <span key={part.id}>
          {index > 0 && <ChevronRight size={13} aria-hidden />}
          <button type="button" onClick={() => onFocus(part)}>{part.name}</button>
        </span>
      ))}
    </nav>
  );
}

function SegmentedSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="atlas-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function CodeFilterControl({
  value,
  onChange,
}: {
  value: CodeFilter;
  onChange: (value: CodeFilter) => void;
}) {
  const options: { value: CodeFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'no-tests', label: 'No tests' },
    { value: 'tests', label: 'Tests' },
  ];
  return (
    <div
      className="atlas-code-filter"
      role="group"
      aria-label="Test code filter"
      title="Filter using indexed language test syntax and conventional test files"
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? 'is-active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DetailInspector({
  node,
  codeFilter,
  dependencies,
  byId,
  onSelect,
}: {
  node: AtlasNode | null;
  codeFilter: CodeFilter;
  dependencies: AtlasDependency[];
  byId: Map<string, AtlasNode>;
  onSelect: (node: AtlasNode) => void;
}) {
  if (!node) return <aside className="atlas-detail-panel"><div className="atlas-inspector-message">Select a block to inspect it.</div></aside>;
  const selectedIds = descendants(node, byId);
  const symbolCount = [...selectedIds].reduce(
    (count, id) => count + (byId.get(id)?.symbols.filter((symbol) => symbolMatchesFilter(symbol, codeFilter)).length ?? 0),
    0,
  );
  const outgoing = dependencies.filter((dependency) => selectedIds.has(dependency.sourceId));
  const incoming = dependencies.filter((dependency) => dependency.targetId != null && selectedIds.has(dependency.targetId));
  const renderDependency = (dependency: AtlasDependency, direction: 'in' | 'out') => {
    const target = byId.get(direction === 'out' ? dependency.targetId ?? '' : dependency.sourceId);
    const path = direction === 'out'
      ? dependency.targetPath ?? dependency.specifier
      : dependency.sourcePath;
    return (
      <button
        type="button"
        className="atlas-dependency-row"
        key={`${direction}:${dependency.sourceId}:${dependency.targetId ?? dependency.specifier}`}
        onClick={() => target && onSelect(target)}
        disabled={!target}
      >
        <span className={`atlas-dependency-direction atlas-dependency-direction--${direction}`}>
          {direction === 'out' ? 'OUT' : 'IN'}
        </span>
        <span title={path}>{path}</span>
        {dependency.count > 1 && <small>{dependency.count}</small>}
      </button>
    );
  };
  return (
    <aside className="atlas-detail-panel">
      <div className="atlas-detail-title">
        {node.kind === 'file' ? <FileCode2 size={16} /> : <Columns3 size={16} />}
        <div><strong>{node.name}</strong><span>{node.path}</span></div>
      </div>
      <dl className="atlas-metric-grid">
        <div><dt>Lines</dt><dd>{formatNumber(filteredLines(node, codeFilter))}</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(filteredBytes(node, codeFilter))}</dd></div>
        <div><dt>Complexity</dt><dd>{formatNumber(filteredComplexity(node, codeFilter))}</dd></div>
        <div><dt>Symbols</dt><dd>{formatNumber(symbolCount)}</dd></div>
      </dl>
      <div className="atlas-dependency-section">
        <h3>Dependencies <span>{outgoing.length}</span></h3>
        {outgoing.map((dependency) => renderDependency(dependency, 'out'))}
        {outgoing.length === 0 && <p>No indexed outgoing dependencies.</p>}
      </div>
      <div className="atlas-dependency-section">
        <h3>Dependents <span>{incoming.length}</span></h3>
        {incoming.map((dependency) => renderDependency(dependency, 'in'))}
        {incoming.length === 0 && <p>No indexed incoming dependencies.</p>}
      </div>
    </aside>
  );
}

export interface AtlasWorkspaceProps {
  snapshot: AtlasSnapshot;
  view: AtlasView;
  selectedId: string | null;
  focusedRootId: string | null;
  sizeMetric: SizeMetric;
  colorMetric: ColorMetric;
  codeFilter: CodeFilter;
  relationshipsOpen: boolean;
  query: string;
  showRepositorySidebar: boolean;
  sidebarOpen: boolean;
  sourceTarget?: AtlasWorkspaceSourceTarget;
  canNavigateSourceBack: boolean;
  canNavigateSourceForward: boolean;
  annotations: CodeAnnotation[];
  capabilities: {
    annotations: boolean;
    askAI: boolean;
  };
  mapOverlay?: BlockMapOverlay;
  sourceLoaders: AtlasSourceLoaders;
  onMapActivate?: (activation: BlockMapActivation) => void;
  onSelectedIdChange: (id: string) => void;
  onNavigateNode: (node: AtlasNode) => void;
  onNavigateSource: (target: AtlasWorkspaceSourceTarget) => void;
  onNavigateSourceBack: () => void;
  onNavigateSourceForward: () => void;
  onSizeMetricChange: (metric: SizeMetric) => void;
  onColorMetricChange: (metric: ColorMetric) => void;
  onCodeFilterChange: (filter: CodeFilter) => void;
  onRelationshipsOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSidebarOpenChange: (open: boolean) => void;
  onAddAnnotation?: (draft: AtlasSourceAnnotationDraft) => void;
  onUpdateAnnotation?: (id: string, text: string) => void;
  onDeleteAnnotation?: (id: string) => void;
  onAskAI?: (question: string, draft: AtlasSourceAnnotationDraft) => void;
}

/**
 * Controlled repository workspace shared by standalone Explore and review.
 *
 * Session lifecycle, theme, status, feedback submission, and AI chat remain in
 * the host. This component owns no HTTP routes and performs no direct fetches.
 */
export function AtlasWorkspace({
  snapshot,
  view,
  selectedId,
  focusedRootId,
  sizeMetric,
  colorMetric,
  codeFilter,
  relationshipsOpen,
  query,
  showRepositorySidebar,
  sidebarOpen,
  sourceTarget,
  canNavigateSourceBack,
  canNavigateSourceForward,
  annotations,
  capabilities,
  mapOverlay,
  sourceLoaders,
  onMapActivate,
  onSelectedIdChange,
  onNavigateNode,
  onNavigateSource,
  onNavigateSourceBack,
  onNavigateSourceForward,
  onSizeMetricChange,
  onColorMetricChange,
  onCodeFilterChange,
  onRelationshipsOpenChange,
  onQueryChange,
  onSidebarOpenChange,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onAskAI,
}: AtlasWorkspaceProps) {
  const nodes = snapshot.nodes;
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const selectedNode = (selectedId && byId.get(selectedId)) || null;
  const focusedRoot = (focusedRootId && byId.get(focusedRootId)) || root;
  const selectedFile = selectedNode?.kind === 'file' ? selectedNode : undefined;
  const relationshipSelection = selectedNode?.kind === 'root' ? null : selectedNode;
  const filteredFileCount = nodes.filter(
    (node) => node.kind === 'file' && nodeMatchesFilter(node, codeFilter),
  ).length;
  const filteredLanguageCount = new Set(
    nodes
      .filter((node) => node.kind === 'file' && node.language && nodeMatchesFilter(node, codeFilter))
      .map((node) => node.language),
  ).size;
  const relationships = useMemo(
    () => relationshipMap(nodes, snapshot.dependencies, relationshipSelection),
    [nodes, relationshipSelection, snapshot.dependencies],
  );

  if (!root || !focusedRoot) {
    return (
      <div className="atlas-empty">
        <FileCode2 size={28} />
        <strong>This repository index is empty</strong>
      </div>
    );
  }

  return (
    <div className={`atlas-shell${showRepositorySidebar && sidebarOpen ? '' : ' is-sidebar-closed'}`}>
      {showRepositorySidebar && (
        <aside className="atlas-sidebar">
          <div className="atlas-sidebar-header">
            <span>Repository</span>
            <span>{filteredFileCount} files</span>
          </div>
          <DirectoryTree
            nodes={nodes}
            codeFilter={codeFilter}
            selectedId={selectedId}
            focusedRootId={focusedRoot.id}
            onSelect={onNavigateNode}
            onFocus={onNavigateNode}
          />
          <div className="atlas-sidebar-summary">
            <span>{formatNumber(filteredLines(root, codeFilter))} lines</span>
            <span>{formatBytes(filteredBytes(root, codeFilter))}</span>
            <span>{filteredLanguageCount} languages</span>
          </div>
        </aside>
      )}

      <section className="atlas-workspace">
        <div className="atlas-toolbar">
          {showRepositorySidebar && (
            <button
              type="button"
              className="atlas-icon-button"
              onClick={() => onSidebarOpenChange(!sidebarOpen)}
              title={sidebarOpen ? 'Hide repository tree' : 'Show repository tree'}
            >{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</button>
          )}
          <CodeFilterControl value={codeFilter} onChange={onCodeFilterChange} />
          {view === 'overview' && (
            <button
              type="button"
              className={`atlas-toolbar-toggle${relationshipsOpen ? ' is-active' : ''}`}
              aria-pressed={relationshipsOpen}
              onClick={() => onRelationshipsOpenChange(!relationshipsOpen)}
            >
              <GitBranch size={14} aria-hidden />
              <span>Relationships</span>
            </button>
          )}
          {view === 'source' ? (
            <>
              <button
                type="button"
                className="atlas-icon-button"
                disabled={!canNavigateSourceBack}
                onClick={onNavigateSourceBack}
                title="Back"
              ><ArrowLeft size={15} /></button>
              <button
                type="button"
                className="atlas-icon-button"
                disabled={!canNavigateSourceForward}
                onClick={onNavigateSourceForward}
                title="Forward"
              ><ArrowRight size={15} /></button>
            </>
          ) : (
            <Breadcrumbs node={focusedRoot} byId={byId} onFocus={onNavigateNode} />
          )}
          {view !== 'source' && selectedNode && selectedNode.id !== focusedRoot.id && (
            <div className="atlas-selection-summary" role="status" aria-live="polite" title={selectedNode.path}>
              {selectedNode.kind === 'file' ? <FileCode2 size={13} aria-hidden /> : <Columns3 size={13} aria-hidden />}
              <span>Selected</span>
              <strong>{selectedNode.path}</strong>
              <small>{selectedNode.kind} · {formatNumber(filteredLines(selectedNode, codeFilter))} lines</small>
            </div>
          )}
          <div className="atlas-toolbar-spacer" />
          {view === 'overview' && (
            <>
              <label className="atlas-search">
                <Search size={14} />
                <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Find a file" aria-label="Find a file" />
                {query && <button type="button" onClick={() => onQueryChange('')} title="Clear search"><X size={13} /></button>}
              </label>
              <SegmentedSelect
                label="Size"
                value={sizeMetric}
                onChange={onSizeMetricChange}
                options={[
                  { value: 'lines', label: 'Lines' },
                  { value: 'bytes', label: 'Bytes' },
                  { value: 'complexity', label: 'Complexity' },
                ]}
              />
              {mapOverlay ? (
                <div className="atlas-fixed-metric"><span>Color</span><strong>Diff heat</strong></div>
              ) : (
                <SegmentedSelect
                  label="Color"
                  value={colorMetric}
                  onChange={onColorMetricChange}
                  options={[
                    { value: 'language', label: 'Language' },
                    { value: 'complexity', label: 'Complexity' },
                    { value: 'size', label: 'Size' },
                  ]}
                />
              )}
            </>
          )}
        </div>

        <div className={`atlas-content atlas-content--${view}`}>
          {view === 'overview' && (
            <div className={`atlas-overview-layout${relationshipsOpen ? ' is-relationships' : ''}`}>
              <div className="atlas-overview-map">
                <BlockMap
                  nodes={nodes}
                  root={focusedRoot}
                  codeFilter={codeFilter}
                  sizeMetric={sizeMetric}
                  colorMetric={colorMetric}
                  query={query}
                  selectedId={selectedId}
                  relationships={relationshipsOpen ? relationships : undefined}
                  overlay={mapOverlay}
                  onActivate={onMapActivate}
                  onSelect={relationshipsOpen ? (node) => onSelectedIdChange(node.id) : onNavigateNode}
                  onOpen={onNavigateNode}
                />
                {relationshipsOpen && (
                  <div className="atlas-relationship-legend">
                    <span><i className="legend-selected" />Selected</span>
                    <span><i className="legend-outgoing" />Uses</span>
                    <span><i className="legend-incoming" />Used by</span>
                    <span><i className="legend-both" />Both</span>
                  </div>
                )}
              </div>
              {relationshipsOpen && (
                <DetailInspector
                  node={relationshipSelection}
                  codeFilter={codeFilter}
                  dependencies={snapshot.dependencies}
                  byId={byId}
                  onSelect={(node) => onSelectedIdChange(node.id)}
                />
              )}
            </div>
          )}
          {view === 'symbols' && selectedFile && (
            <div className="atlas-symbol-layout">
              <div className="atlas-symbol-header">
                <div><FileCode2 size={17} /><strong>{selectedFile.name}</strong><span>{selectedFile.path}</span></div>
                <dl>
                  <div><dt>Symbols</dt><dd>{selectedFile.symbols.filter((symbol) => symbolMatchesFilter(symbol, codeFilter)).length}</dd></div>
                  <div><dt>Complexity</dt><dd>{filteredComplexity(selectedFile, codeFilter)}</dd></div>
                  <div><dt>Lines</dt><dd>{filteredLines(selectedFile, codeFilter)}</dd></div>
                </dl>
              </div>
              <SymbolMap
                file={selectedFile}
                codeFilter={codeFilter}
                onOpen={(symbol: AtlasSymbol) => onNavigateSource({
                  path: selectedFile.path,
                  line: symbol.line,
                  column: symbol.column,
                  symbol: symbol.name,
                  selection: 'symbol',
                })}
              />
            </div>
          )}
          {view === 'source' && selectedFile && (
            <SourceView
              node={selectedFile}
              nodes={snapshot.nodes}
              analyzers={snapshot.analyzers}
              snapshotGeneratedAt={snapshot.generatedAt}
              codeFilter={codeFilter}
              loaders={sourceLoaders}
              targetLine={sourceTarget?.path === selectedFile.path ? sourceTarget.line : undefined}
              targetColumn={sourceTarget?.path === selectedFile.path ? sourceTarget.column : undefined}
              targetSymbol={sourceTarget?.path === selectedFile.path ? sourceTarget.symbol : undefined}
              targetSelection={sourceTarget?.path === selectedFile.path ? sourceTarget.selection : undefined}
              onNavigateFile={onNavigateSource}
              annotations={annotations.filter((annotation) => annotation.filePath === selectedFile.path)}
              annotationControlsEnabled={capabilities.annotations}
              aiAvailable={capabilities.askAI}
              onAddAnnotation={onAddAnnotation}
              onUpdateAnnotation={onUpdateAnnotation}
              onDeleteAnnotation={onDeleteAnnotation}
              onAskAI={onAskAI}
            />
          )}
          {(view === 'symbols' || view === 'source') && !selectedFile && (
            <div className="atlas-empty"><FileCode2 size={28} /><strong>No source file selected</strong></div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function AtlasApp() {
  const { indexStatus, snapshot, error, reindex } = useAtlasData();
  const [view, setView] = useState<AtlasView>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const [sizeMetric, setSizeMetric] = useState<SizeMetric>('lines');
  const [colorMetric, setColorMetric] = useState<ColorMetric>('complexity');
  const [codeFilter, setCodeFilter] = useState<CodeFilter>('all');
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 620px)').matches);
  const [dark, setDark] = useState(() => !window.matchMedia('(prefers-color-scheme: light)').matches);
  const [sourceHistory, setSourceHistory] = useState<AtlasWorkspaceSourceTarget[]>([]);
  const [sourceHistoryIndex, setSourceHistoryIndex] = useState(-1);
  const [annotations, setAnnotations] = useState<CodeAnnotation[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiProviders, setAiProviders] = useState<Array<{
    id: string;
    name: string;
    models?: Array<{ id: string; label: string; default?: boolean }>;
  }>>([]);
  const [aiDefaultProvider, setAiDefaultProvider] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const nodes = snapshot?.nodes ?? [];
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const selectedNode = (selectedId && byId.get(selectedId)) || null;
  const focusedRoot = (focusedRootId && byId.get(focusedRootId)) || root;
  const currentSourceTarget = sourceHistory[sourceHistoryIndex];
  const selectedFile = selectedNode?.kind === 'file' ? selectedNode : undefined;
  const annotationSummary = useMemo(
    () => formatAtlasAnnotationSummary(annotations),
    [annotations],
  );
  const { aiConfig, applyConfigChange } = useAIProviderConfig({
    providers: aiProviders,
    defaultProvider: aiDefaultProvider,
    available: aiAvailable,
    origin: null,
  });
  const aiChat = useAIChat({
    context: snapshot ? {
      mode: 'codebase-atlas',
      atlas: {
        rootName: snapshot.rootName,
        ...(annotationSummary && { annotations: annotationSummary }),
      },
    } : null,
    providerId: aiConfig.providerId,
    model: aiConfig.model,
    reasoningEffort: aiConfig.reasoningEffort,
    threadTitle: 'Codebase Atlas',
  });

  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
    document.documentElement.classList.add('theme-plannotator');
  }, [dark]);

  useEffect(() => {
    fetch('/api/ai/capabilities', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((capabilities) => {
        setAiAvailable(Boolean(capabilities?.available));
        setAiProviders(capabilities?.providers ?? []);
        setAiDefaultProvider(capabilities?.defaultProvider ?? null);
      })
      .catch(() => {
        setAiAvailable(false);
        setAiProviders([]);
        setAiDefaultProvider(null);
      });
  }, []);

  useEffect(() => {
    if (!root) return;
    setFocusedRootId((current) => current && byId.has(current) ? current : root.id);
    setSelectedId((current) => current && byId.has(current) ? current : root.id);
  }, [root, byId]);

  const openSource = useCallback((target: AtlasWorkspaceSourceTarget) => {
    const node = nodes.find((entry) => entry.path === target.path);
    if (!node || node.kind !== 'file') return;
    setSelectedId(node.id);
    setView('source');
    setSourceHistory((history) => {
      const prefix = history.slice(0, sourceHistoryIndex + 1);
      return [...prefix, target];
    });
    setSourceHistoryIndex((index) => index + 1);
  }, [nodes, sourceHistoryIndex]);

  const navigateSourceHistory = useCallback((index: number) => {
    const target = sourceHistory[index];
    if (!target) return;
    const node = nodes.find((entry) => entry.kind === 'file' && entry.path === target.path);
    if (!node) return;
    setSourceHistoryIndex(index);
    setSelectedId(node.id);
  }, [nodes, sourceHistory]);

  const navigateNode = useCallback((node: AtlasNode) => {
    setSelectedId(node.id);
    if (node.kind === 'file') {
      setView('symbols');
      return;
    }
    setFocusedRootId(node.id);
    setView('overview');
  }, []);

  const addAnnotation = useCallback((draft: AtlasSourceAnnotationDraft) => {
    setAnnotations((current) => [...current, {
      id: crypto.randomUUID(),
      type: 'comment',
      scope: 'line',
      filePath: draft.filePath,
      lineStart: draft.lineStart,
      lineEnd: draft.lineEnd,
      side: 'new',
      text: draft.text,
      originalCode: draft.selectedCode,
      createdAt: Date.now(),
      source: 'atlas',
      atlasSnapshotGeneratedAt: draft.snapshotGeneratedAt,
    }]);
  }, []);

  const updateAnnotation = useCallback((id: string, text: string) => {
    setAnnotations((current) => current.map((annotation) =>
      annotation.id === id ? { ...annotation, text } : annotation,
    ));
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  }, []);

  const askGeneral = useCallback((question: string) => {
    void aiChat.ask({
      prompt: question,
      ...(annotationSummary && { contextUpdate: `Current Atlas annotations:\n${annotationSummary}` }),
    });
  }, [aiChat.ask, annotationSummary]);

  const askSelection = useCallback((question: string, draft: AtlasSourceAnnotationDraft) => {
    setAiOpen(true);
    void aiChat.ask({
      prompt: question,
      filePath: draft.filePath,
      lineStart: draft.lineStart,
      lineEnd: draft.lineEnd,
      selectedCode: draft.selectedCode,
      scope: {
        kind: 'selection',
        label: `${draft.filePath}:${draft.lineStart}-${draft.lineEnd}`,
        sourcePath: draft.filePath,
        text: draft.selectedCode,
      },
      ...(annotationSummary && { contextUpdate: `Current Atlas annotations:\n${annotationSummary}` }),
    });
  }, [aiChat.ask, annotationSummary]);

  const changeAIConfig = useCallback((config: {
    providerId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
  }) => {
    applyConfigChange(config);
    aiChat.resetSession();
  }, [aiChat.resetSession, applyConfigChange]);

  const submitFeedback = useCallback(async () => {
    if (annotations.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    const feedback = {
      annotations,
      markdown: formatAtlasFeedback(annotations),
    };
    try {
      await submitAtlasFeedback(feedback);
      setSubmitted(true);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }, [annotations, submitting]);

  if (submitted) {
    return (
      <main className="atlas-state-screen" role="status">
        <div className="atlas-state-mark"><CircleCheck size={25} /></div>
        <strong>Feedback submitted</strong>
        <span>{annotations.length} annotation{annotations.length === 1 ? '' : 's'} sent to the calling agent.</span>
      </main>
    );
  }

  if (indexStatus.status === 'error' && !snapshot) {
    return (
      <main className="atlas-state-screen" role="alert">
        <div className="atlas-state-mark atlas-state-mark--error"><CircleAlert size={25} /></div>
        <strong>Atlas could not be built</strong>
        <span>{error || 'The repository indexer stopped unexpectedly.'}</span>
        <button type="button" className="atlas-primary-button" onClick={() => void reindex()}><RefreshCw size={15} />Reindex</button>
      </main>
    );
  }

  if (!snapshot || !root || !focusedRoot) {
    const checking = indexStatus.phase === 'checking';
    return (
      <main className="atlas-state-screen" role="status" aria-live="polite">
        <div className="atlas-state-mark"><LoaderCircle size={25} className="atlas-spin" /></div>
        <strong>{checking ? 'Checking index' : 'Mapping repository'}</strong>
        <span>{checking
          ? 'Looking for an existing repository index…'
          : 'Indexing files, symbols, and module relationships…'}</span>
      </main>
    );
  }

  const indexIsWorking = indexStatus.phase === 'checking'
    || indexStatus.phase === 'indexing'
    || indexStatus.refreshing;
  const indexStatusLabel = indexStatus.phase === 'error'
    ? 'Index error'
    : indexStatus.phase === 'checking'
      ? 'Cached · checking'
      : indexStatus.phase === 'indexing' || indexStatus.refreshing
        ? 'Cached · reindexing'
        : indexStatus.source === 'cache'
          ? 'Cached index'
          : 'Fresh index';
  const indexStatusTitle = indexStatus.phase === 'error'
    ? (indexStatus.error || error || 'The repository indexer stopped unexpectedly.')
    : indexIsWorking
      ? 'Showing the current index while a background index is prepared'
      : `Index completed ${new Date(snapshot.generatedAt).toLocaleString()}`;

  return (
    <main className="atlas-app">
      <header className="atlas-header">
        <div className="atlas-brand">
          <div className="atlas-brand-mark"><Square size={15} fill="currentColor" /></div>
          <div><strong>{snapshot.rootName}</strong><span>Codebase Atlas</span></div>
        </div>
        <nav className="atlas-view-tabs" aria-label="Atlas views">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={view === id ? 'is-active' : ''}
              onClick={() => {
                if (id === 'source' && selectedFile && currentSourceTarget?.path !== selectedFile.path) {
                  openSource({ path: selectedFile.path });
                  return;
                }
                setView(id);
              }}
              disabled={(id === 'symbols' || id === 'source') && !selectedFile}
            ><Icon size={15} /><span>{label}</span></button>
          ))}
        </nav>
        <div className="atlas-header-actions">
          <div
            className={`atlas-index-status is-${indexStatus.phase}`}
            title={indexStatusTitle}
            role="status"
            aria-live="polite"
          >
            {indexStatus.phase === 'error'
              ? <CircleAlert size={13} aria-hidden />
              : indexIsWorking
                ? <LoaderCircle size={13} className="atlas-spin" aria-hidden />
                : <CircleCheck size={13} aria-hidden />}
            <span>{indexStatusLabel} · {snapshot.analyzers.structural.name} {snapshot.analyzers.structural.version}</span>
            <time dateTime={snapshot.generatedAt}>{formatIndexedAt(snapshot.generatedAt)}</time>
          </div>
          <button
            type="button"
            className="atlas-reindex-button"
            title="Rebuild repository index"
            disabled={indexIsWorking}
            onClick={() => void reindex()}
          >
            <RefreshCw size={14} />
            <span>Reindex</span>
          </button>
          <button
            type="button"
            className={`atlas-icon-button${aiOpen ? ' is-active' : ''}`}
            title={aiAvailable ? 'Ask AI' : 'No AI provider is available'}
            disabled={!aiAvailable}
            onClick={() => setAiOpen((current) => !current)}
          ><Sparkles size={15} /></button>
          <button
            type="button"
            className="atlas-submit-button"
            disabled={annotations.length === 0 || submitting}
            onClick={() => void submitFeedback()}
            title={annotations.length === 0 ? 'Add a source annotation first' : 'Submit annotations'}
          >
            {submitting ? <LoaderCircle size={14} className="atlas-spin" /> : <Send size={14} />}
            <span>Submit</span>
            {annotations.length > 0 && <small>{annotations.length}</small>}
          </button>
          <button type="button" className="atlas-icon-button" title={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark((value) => !value)}>
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button type="button" className="atlas-icon-button atlas-close-button" title="Close Atlas" onClick={() => void closeAtlas().then(() => window.close())}><X size={16} /></button>
        </div>
      </header>

      <AtlasWorkspace
        snapshot={snapshot}
        view={view}
        selectedId={selectedId}
        focusedRootId={focusedRootId}
        sizeMetric={sizeMetric}
        colorMetric={colorMetric}
        codeFilter={codeFilter}
        relationshipsOpen={relationshipsOpen}
        query={query}
        showRepositorySidebar
        sidebarOpen={sidebarOpen}
        sourceTarget={currentSourceTarget}
        canNavigateSourceBack={sourceHistoryIndex > 0}
        canNavigateSourceForward={sourceHistoryIndex < sourceHistory.length - 1}
        annotations={annotations}
        capabilities={{ annotations: true, askAI: aiAvailable }}
        sourceLoaders={DEFAULT_SOURCE_LOADERS}
        onSelectedIdChange={setSelectedId}
        onNavigateNode={navigateNode}
        onNavigateSource={openSource}
        onNavigateSourceBack={() => navigateSourceHistory(sourceHistoryIndex - 1)}
        onNavigateSourceForward={() => navigateSourceHistory(sourceHistoryIndex + 1)}
        onSizeMetricChange={setSizeMetric}
        onColorMetricChange={setColorMetric}
        onCodeFilterChange={setCodeFilter}
        onRelationshipsOpenChange={setRelationshipsOpen}
        onQueryChange={setQuery}
        onSidebarOpenChange={setSidebarOpen}
        onAddAnnotation={addAnnotation}
        onUpdateAnnotation={updateAnnotation}
        onDeleteAnnotation={deleteAnnotation}
        onAskAI={askSelection}
      />
      {aiOpen && (
        <aside className="atlas-ai-drawer" aria-label="Ask AI">
          <div className="atlas-ai-drawer-header">
            <Sparkles size={15} />
            <strong>Ask AI</strong>
            {annotations.length > 0 && (
              <span title="Current annotations"><MessageSquare size={12} />{annotations.length}</span>
            )}
            <button type="button" onClick={() => setAiOpen(false)} title="Close AI panel"><X size={15} /></button>
          </div>
          <DocumentAIChatPanel
            messages={aiChat.messages}
            isCreatingSession={aiChat.isCreatingSession}
            isStreaming={aiChat.isStreaming}
            onAskGeneral={askGeneral}
            onStop={aiChat.abort}
            permissionRequests={aiChat.permissionRequests}
            onRespondToPermission={aiChat.respondToPermission}
            aiProviders={aiProviders}
            aiConfig={aiConfig}
            onAIConfigChange={changeAIConfig}
            inputPlaceholder="Ask about this codebase..."
            emptyPrompt={(
              <>Select source lines and click <strong>Ask AI</strong>, or ask about the repository below.</>
            )}
          />
        </aside>
      )}
      {submitError && (
        <div className="atlas-submit-error" role="alert">
          <CircleAlert size={14} />
          <span>{submitError}</span>
          <button type="button" onClick={() => setSubmitError('')} title="Dismiss"><X size={13} /></button>
        </div>
      )}
    </main>
  );
}
