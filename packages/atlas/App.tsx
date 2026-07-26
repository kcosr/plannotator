import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { BlockMap } from './BlockMap';
import {
  filteredBytes,
  filteredComplexity,
  filteredLines,
  nodeMatchesFilter,
  symbolMatchesFilter,
} from './codeFilter';
import { DirectoryTree } from './DirectoryTree';
import { SourceView } from './SourceView';
import { SymbolMap } from './SymbolMap';
import { closeAtlas, fetchSnapshot, fetchStatus, refreshAtlas } from './api';
import { formatBytes, formatNumber } from './format';
import type {
  AtlasDependency,
  AtlasNode,
  AtlasSnapshot,
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

interface SourceNavigation {
  path: string;
  line?: number;
  column?: number;
  symbol?: string;
}

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
  const [status, setStatus] = useState<'indexing' | 'ready' | 'error'>('indexing');
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = await fetchStatus(signal);
    setError(current.error ?? '');
    if (current.status === 'ready') {
      const data = await fetchSnapshot(signal);
      setSnapshot(data);
      setStatus('ready');
      return;
    }
    setStatus(current.status);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setStatus('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (status !== 'indexing') return;
    const interval = window.setInterval(() => {
      load().catch((reason: unknown) => {
        setStatus('error');
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 900);
    return () => window.clearInterval(interval);
  }, [status, load]);

  const refresh = useCallback(async () => {
    setStatus('indexing');
    setError('');
    await refreshAtlas();
    await load();
  }, [load]);

  return { status, snapshot, error, refresh };
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
      aria-label="Rust test code filter"
      title="Filter using indexed Rust test attributes, cfg(test) scopes, and integration-test files"
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

export default function AtlasApp() {
  const { status, snapshot, error, refresh } = useAtlasData();
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
  const [sourceHistory, setSourceHistory] = useState<SourceNavigation[]>([]);
  const [sourceHistoryIndex, setSourceHistoryIndex] = useState(-1);

  const nodes = snapshot?.nodes ?? [];
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const selectedNode = (selectedId && byId.get(selectedId)) || null;
  const focusedRoot = (focusedRootId && byId.get(focusedRootId)) || root;
  const currentSourceTarget = sourceHistory[sourceHistoryIndex];
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

  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
    document.documentElement.classList.add('theme-plannotator');
  }, [dark]);

  useEffect(() => {
    if (!root) return;
    setFocusedRootId((current) => current && byId.has(current) ? current : root.id);
    setSelectedId((current) => current && byId.has(current) ? current : root.id);
  }, [root, byId]);

  const openSource = useCallback((target: SourceNavigation) => {
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

  const relationships = useMemo(
    () => relationshipMap(nodes, snapshot?.dependencies ?? [], relationshipSelection),
    [nodes, snapshot?.dependencies, relationshipSelection],
  );

  if (status === 'error') {
    return (
      <main className="atlas-state-screen" role="alert">
        <div className="atlas-state-mark atlas-state-mark--error"><CircleAlert size={25} /></div>
        <strong>Atlas could not be built</strong>
        <span>{error || 'The repository indexer stopped unexpectedly.'}</span>
        <button type="button" className="atlas-primary-button" onClick={() => void refresh()}><RefreshCw size={15} />Try again</button>
      </main>
    );
  }

  if (status === 'indexing' || !snapshot || !root || !focusedRoot) {
    return (
      <main className="atlas-state-screen" role="status" aria-live="polite">
        <div className="atlas-state-mark"><LoaderCircle size={25} className="atlas-spin" /></div>
        <strong>Mapping repository</strong>
        <span>Indexing files, symbols, and module relationships…</span>
      </main>
    );
  }

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
          <div className="atlas-index-status" title={`Index completed ${new Date(snapshot.generatedAt).toLocaleString()}`}>
            <CircleCheck size={13} aria-hidden />
            <span>Indexed · {snapshot.analyzers.structural.name} {snapshot.analyzers.structural.version}</span>
            <time dateTime={snapshot.generatedAt}>{formatIndexedAt(snapshot.generatedAt)}</time>
          </div>
          <button type="button" className="atlas-icon-button" title="Refresh index" onClick={() => void refresh()}><RefreshCw size={15} /></button>
          <button type="button" className="atlas-icon-button" title={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark((value) => !value)}>
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button type="button" className="atlas-icon-button atlas-close-button" title="Close Atlas" onClick={() => void closeAtlas().then(() => window.close())}><X size={16} /></button>
        </div>
      </header>

      <div className={`atlas-shell${sidebarOpen ? '' : ' is-sidebar-closed'}`}>
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
            onSelect={navigateNode}
            onFocus={navigateNode}
          />
          <div className="atlas-sidebar-summary">
            <span>{formatNumber(filteredLines(root, codeFilter))} lines</span>
            <span>{formatBytes(filteredBytes(root, codeFilter))}</span>
            <span>{filteredLanguageCount} languages</span>
          </div>
        </aside>

        <section className="atlas-workspace">
          <div className="atlas-toolbar">
            <button
              type="button"
              className="atlas-icon-button"
              onClick={() => setSidebarOpen((value) => !value)}
              title={sidebarOpen ? 'Hide repository tree' : 'Show repository tree'}
            >{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</button>
            <CodeFilterControl value={codeFilter} onChange={setCodeFilter} />
            {view === 'overview' && (
              <button
                type="button"
                className={`atlas-toolbar-toggle${relationshipsOpen ? ' is-active' : ''}`}
                aria-pressed={relationshipsOpen}
                onClick={() => setRelationshipsOpen((value) => !value)}
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
                  disabled={sourceHistoryIndex <= 0}
                  onClick={() => navigateSourceHistory(sourceHistoryIndex - 1)}
                  title="Back"
                ><ArrowLeft size={15} /></button>
                <button
                  type="button"
                  className="atlas-icon-button"
                  disabled={sourceHistoryIndex >= sourceHistory.length - 1}
                  onClick={() => navigateSourceHistory(sourceHistoryIndex + 1)}
                  title="Forward"
                ><ArrowRight size={15} /></button>
              </>
            ) : (
              <Breadcrumbs node={focusedRoot} byId={byId} onFocus={navigateNode} />
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
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a file" aria-label="Find a file" />
                  {query && <button type="button" onClick={() => setQuery('')} title="Clear search"><X size={13} /></button>}
                </label>
                <SegmentedSelect
                  label="Size"
                  value={sizeMetric}
                  onChange={setSizeMetric}
                  options={[
                    { value: 'lines', label: 'Lines' },
                    { value: 'bytes', label: 'Bytes' },
                    { value: 'complexity', label: 'Complexity' },
                  ]}
                />
                <SegmentedSelect
                  label="Color"
                  value={colorMetric}
                  onChange={setColorMetric}
                  options={[
                    { value: 'language', label: 'Language' },
                    { value: 'complexity', label: 'Complexity' },
                    { value: 'size', label: 'Size' },
                  ]}
                />
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
                    onSelect={relationshipsOpen ? (node) => setSelectedId(node.id) : navigateNode}
                    onOpen={navigateNode}
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
                    onSelect={(node) => setSelectedId(node.id)}
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
                  onOpen={(symbol: AtlasSymbol) => openSource({
                    path: selectedFile.path,
                    line: symbol.line,
                    column: symbol.column,
                    symbol: symbol.name,
                  })}
                />
              </div>
            )}
            {view === 'source' && selectedFile && (
              <SourceView
                node={selectedFile}
                analyzers={snapshot.analyzers}
                codeFilter={codeFilter}
                targetLine={currentSourceTarget?.path === selectedFile.path ? currentSourceTarget.line : undefined}
                targetColumn={currentSourceTarget?.path === selectedFile.path ? currentSourceTarget.column : undefined}
                targetSymbol={currentSourceTarget?.path === selectedFile.path ? currentSourceTarget.symbol : undefined}
                onNavigateFile={openSource}
              />
            )}
            {(view === 'symbols' || view === 'source') && !selectedFile && (
              <div className="atlas-empty"><FileCode2 size={28} /><strong>No source file selected</strong></div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
