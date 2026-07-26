import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { File } from '@pierre/diffs/react';
import type { LineEventBaseProps, SelectedLineRange, TokenEventBase } from '@pierre/diffs';
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronDown,
  CornerDownRight,
  CircleCheck,
  CircleSlash,
  Copy,
  FileCode2,
  LocateFixed,
  Search,
} from 'lucide-react';
import { fetchCallHierarchy, fetchReferences, fetchSource } from './api';
import { callLocationKey, filterCallTargets } from './callHierarchy';
import { lineMatchesFilter, symbolMatchesFilter } from './codeFilter';
import { isInspectableSymbol, referencePositionFromToken } from './referencePosition';
import type {
  AtlasAnalyzers,
  AtlasNode,
  AtlasSymbol,
  CallHierarchyLocation,
  CallHierarchyResponse,
  CallHierarchyTarget,
  CodeFilter,
  ReferenceLocation,
  ReferenceResponse,
  SourceFile,
} from './types';

interface NavigationTarget {
  path: string;
  line?: number;
  column?: number;
  symbol?: string;
  selection?: 'line' | 'symbol';
}

interface SourceViewProps {
  node: AtlasNode;
  nodes: AtlasNode[];
  analyzers: AtlasAnalyzers;
  targetLine?: number;
  targetColumn?: number;
  targetSymbol?: string;
  targetSelection?: 'line' | 'symbol';
  codeFilter: CodeFilter;
  onNavigateFile: (target: NavigationTarget) => void;
}

const PIERRE_SOURCE_CSS = `
  :host { height: 100% !important; color-scheme: light dark; }
  [data-file], [data-code] { height: 100% !important; }
  [data-code] { overflow: auto !important; }
  [data-char] { cursor: text; }
  [data-atlas-inspectable] {
    cursor: pointer;
  }
  [data-atlas-inspectable]:hover {
    background: color-mix(in oklab, #22c55e 16%, transparent);
    outline: 1px solid color-mix(in oklab, #22c55e 48%, transparent);
    border-radius: 2px;
  }
  [data-atlas-filtered-out] { opacity: .2; }
  [data-line][data-selected-line] {
    background: color-mix(in oklab, #3b82f6 30%, transparent) !important;
    box-shadow: inset 3px 0 #60a5fa;
  }
  [data-column-number][data-selected-line] {
    background: color-mix(in oklab, #3b82f6 30%, transparent) !important;
    color: #bfdbfe !important;
  }
  [data-atlas-filtered-out][data-selected-line] { opacity: 1; }
  [data-atlas-target-token] {
    background: color-mix(in oklab, #facc15 38%, transparent) !important;
    outline: 1px solid color-mix(in oklab, #facc15 78%, transparent);
    border-radius: 2px;
  }
`;

interface NavigationHighlight {
  range: SelectedLineRange;
  line: number;
  column?: number;
}

function locationKey(location: ReferenceLocation) {
  return `${location.filePath}:${location.line}:${location.column}`;
}

function navigationSelection(
  node: AtlasNode,
  line: number,
  symbolName?: string,
): SelectedLineRange {
  const candidates = symbolName
    ? node.symbols
      .filter((candidate) => candidate.name === symbolName)
      .sort((first, second) => (first.endLine - first.line) - (second.endLine - second.line))
    : [];
  const symbol = candidates.find((candidate) => line >= candidate.line && line <= candidate.endLine)
    ?? candidates[0];
  if (symbol && symbol.kind !== 'module') {
    return { start: symbol.line, end: symbol.endLine };
  }
  return { start: line, end: line };
}

function ReferenceGroup({
  title,
  locations,
  onNavigate,
}: {
  title: string;
  locations: ReferenceLocation[];
  onNavigate: (location: ReferenceLocation) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="atlas-reference-group">
      <button type="button" className="atlas-reference-heading" onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={14} className={open ? '' : 'is-collapsed'} />
        <span>{title}</span>
        <span className="atlas-count">{locations.length}</span>
      </button>
      {open && locations.map((location) => (
        <button
          type="button"
          className="atlas-reference-item"
          key={locationKey(location)}
          onClick={() => onNavigate(location)}
        >
          <span className="atlas-reference-path">{location.filePath}:{location.line}</span>
          <code>{location.snippet || `Line ${location.line}`}</code>
        </button>
      ))}
    </section>
  );
}

function CallTargetRow({
  target,
  onNavigateDeclaration,
  onNavigateCallSite,
}: {
  target: CallHierarchyTarget;
  onNavigateDeclaration: (target: CallHierarchyTarget) => void;
  onNavigateCallSite: (target: CallHierarchyTarget, location: CallHierarchyLocation) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="atlas-call-target">
      <div className="atlas-call-target-row">
        <button
          type="button"
          className="atlas-call-expand"
          disabled={target.callSites.length === 0}
          onClick={() => setOpen((value) => !value)}
          title={open ? 'Collapse call sites' : 'Expand call sites'}
          aria-label={open ? 'Collapse call sites' : 'Expand call sites'}
          aria-expanded={open}
        >
          <ChevronDown size={13} className={open ? '' : 'is-collapsed'} />
        </button>
        <button
          type="button"
          className="atlas-call-declaration"
          onClick={() => onNavigateDeclaration(target)}
          title={`Open declaration of ${target.name}`}
        >
          <span>{target.name}</span>
          <small>{target.detail || `${target.declaration.filePath}:${target.declaration.line}`}</small>
        </button>
        <span className="atlas-count" title={`${target.callSites.length} call site${target.callSites.length === 1 ? '' : 's'}`}>
          {target.callSites.length}
        </span>
      </div>
      {open && target.callSites.map((location) => (
        <button
          type="button"
          className="atlas-call-site"
          key={callLocationKey(location)}
          onClick={() => onNavigateCallSite(target, location)}
          title="Open exact call site"
        >
          <CornerDownRight size={12} />
          <span>
            <strong>{location.filePath}:{location.line}</strong>
            <code>{location.snippet || `Line ${location.line}`}</code>
          </span>
        </button>
      ))}
    </div>
  );
}

function CallHierarchyGroup({
  title,
  targets,
  onNavigateDeclaration,
  onNavigateCallSite,
}: {
  title: string;
  targets: CallHierarchyTarget[];
  onNavigateDeclaration: (target: CallHierarchyTarget) => void;
  onNavigateCallSite: (target: CallHierarchyTarget, location: CallHierarchyLocation) => void;
}) {
  const [open, setOpen] = useState(true);
  const callSiteCount = targets.reduce((sum, target) => sum + target.callSites.length, 0);
  return (
    <section className="atlas-reference-group">
      <button type="button" className="atlas-reference-heading" onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={14} className={open ? '' : 'is-collapsed'} />
        <span>{title}</span>
        <span className="atlas-count" title={`${callSiteCount} call site${callSiteCount === 1 ? '' : 's'}`}>
          {targets.length}
        </span>
      </button>
      {open && targets.map((target) => (
        <CallTargetRow
          key={`${target.name}:${callLocationKey(target.declaration)}`}
          target={target}
          onNavigateDeclaration={onNavigateDeclaration}
          onNavigateCallSite={onNavigateCallSite}
        />
      ))}
      {open && targets.length === 0 && (
        <div className="atlas-inspector-message">No {title.toLowerCase()} found.</div>
      )}
    </section>
  );
}

export function SourceView({
  node,
  nodes,
  analyzers,
  targetLine,
  targetColumn,
  targetSymbol,
  targetSelection,
  codeFilter,
  onNavigateFile,
}: SourceViewProps) {
  const [source, setSource] = useState<SourceFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [referenceState, setReferenceState] = useState<{
    symbol: string;
    line: number;
    column: number;
    loading: boolean;
    result: ReferenceResponse | null;
    error?: string;
  } | null>(null);
  const [inspectorMode, setInspectorMode] = useState<'references' | 'calls'>('references');
  const [callState, setCallState] = useState<{
    loading: boolean;
    result: CallHierarchyResponse | null;
    error?: string;
  }>({ loading: false, result: null });
  const [copied, setCopied] = useState(false);
  const [navigationHighlight, setNavigationHighlight] = useState<NavigationHighlight | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const symbolListRef = useRef<HTMLDivElement>(null);
  const referenceRequestRef = useRef<AbortController | null>(null);
  const suppressTokenLineClearRef = useRef(false);
  const renderStateRef = useRef({ node, codeFilter, navigationHighlight });
  renderStateRef.current = { node, codeFilter, navigationHighlight };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSource(null);
    fetchSource(node.path, controller.signal)
      .then(setSource)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [node.path]);

  const matches = useMemo(() => {
    if (!source || !query.trim()) return [];
    const needle = query.toLowerCase();
    return source.content.split('\n').flatMap((line, index) =>
      line.toLowerCase().includes(needle) && lineMatchesFilter(node, index + 1, codeFilter)
        ? [index + 1]
        : [],
    );
  }, [source, query, node, codeFilter]);

  const scrollToLine = useCallback((line: number) => {
    const container = hostRef.current?.querySelector('diffs-container') as HTMLElement & { shadowRoot: ShadowRoot } | null;
    const scrollArea = container?.shadowRoot?.querySelector('[data-code]') as HTMLElement | null;
    const lineElement = container?.shadowRoot?.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
    if (!scrollArea || !lineElement) return;
    const scrollBounds = scrollArea.getBoundingClientRect();
    const lineBounds = lineElement.getBoundingClientRect();
    const top = scrollArea.scrollTop
      + lineBounds.top
      - scrollBounds.top
      - (scrollArea.clientHeight - lineBounds.height) / 2;
    scrollArea.scrollTo({
      top: Math.max(0, top),
      left: 0,
      behavior: 'auto',
    });
  }, []);

  const highlightLocation = useCallback((
    line: number,
    column?: number,
    selection: 'line' | 'symbol' = 'line',
    symbolName?: string,
  ) => {
    setNavigationHighlight({
      range: selection === 'symbol'
        ? navigationSelection(node, line, symbolName)
        : { start: line, end: line },
      line,
      column,
    });
    scrollToLine(line);
  }, [node, scrollToLine]);

  const highlightSymbol = useCallback((symbol: AtlasSymbol) => {
    setNavigationHighlight({
      range: {
        start: symbol.line,
        end: symbol.kind === 'module' ? symbol.line : symbol.endLine,
      },
      line: symbol.line,
      column: symbol.column,
    });
    scrollToLine(symbol.line);
  }, [scrollToLine]);

  useEffect(() => {
    if (!source || !targetLine) return;
    setNavigationHighlight({
      range: targetSelection === 'symbol'
        ? navigationSelection(node, targetLine, targetSymbol)
        : { start: targetLine, end: targetLine },
      line: targetLine,
      column: targetColumn,
    });
    const timeout = window.setTimeout(() => scrollToLine(targetLine), 180);
    return () => window.clearTimeout(timeout);
  }, [source, node, targetLine, targetColumn, targetSymbol, targetSelection, scrollToLine]);

  useEffect(() => {
    if (matches.length === 0) return;
    setMatchIndex((current) => Math.min(current, matches.length - 1));
  }, [matches.length]);

  const inspectSymbol = useCallback((symbol: string, line: number, column: number) => {
    const clean = symbol.trim();
    if (!clean) return;
    referenceRequestRef.current?.abort();
    const controller = new AbortController();
    referenceRequestRef.current = controller;
    setReferenceState({ symbol: clean, line, column, loading: true, result: null });
    setCallState({ loading: false, result: null });
    fetchReferences(clean, node.path, line, column, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setReferenceState({ symbol: clean, line, column, loading: false, result });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setReferenceState({
          symbol: clean,
          line,
          column,
          loading: false,
          result: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [node.path]);

  useEffect(() => () => {
    referenceRequestRef.current?.abort();
  }, [node.path]);

  const inspectedSymbol = referenceState?.symbol;
  const inspectedLine = referenceState?.line;
  const inspectedColumn = referenceState?.column;

  useEffect(() => {
    if (inspectorMode !== 'calls' || !inspectedSymbol || !inspectedLine || !inspectedColumn) return;
    const controller = new AbortController();
    setCallState({ loading: true, result: null });
    fetchCallHierarchy(node.path, inspectedLine, inspectedColumn, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCallState({ loading: false, result });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setCallState({
            loading: false,
            result: null,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => controller.abort();
  }, [inspectorMode, inspectedSymbol, inspectedLine, inspectedColumn, node.path]);

  useEffect(() => {
    if (targetSymbol && targetLine && targetColumn) {
      inspectSymbol(targetSymbol, targetLine, targetColumn);
    }
  }, [targetSymbol, targetLine, targetColumn, inspectSymbol]);

  useEffect(() => {
    const selectedSymbol = referenceState?.symbol;
    if (!selectedSymbol) return;
    const selectedItem = [
      ...(symbolListRef.current?.querySelectorAll<HTMLElement>('[data-symbol-name]') ?? []),
    ].find((item) => item.dataset.symbolName === selectedSymbol);
    selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [referenceState?.symbol]);

  const onTokenClick = useCallback((props: TokenEventBase, event: MouseEvent) => {
    const position = referencePositionFromToken(props);
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    suppressTokenLineClearRef.current = true;
    window.setTimeout(() => {
      suppressTokenLineClearRef.current = false;
    }, 0);
    highlightLocation(position.line, position.column, 'line');
    inspectSymbol(position.symbol, position.line, position.column);
  }, [highlightLocation, inspectSymbol]);

  const pierreFile = useMemo(() => source
    ? { name: node.name, contents: source.content }
    : null, [node.name, source]);

  const onLineClick = useCallback((props: LineEventBaseProps) => {
    if (suppressTokenLineClearRef.current) {
      suppressTokenLineClearRef.current = false;
      return;
    }
    if (props.lineNumber) setNavigationHighlight(null);
  }, []);

  const applySourceDecorations = useCallback((container: HTMLElement) => {
    const shadowRoot = container.shadowRoot;
    const lines = shadowRoot?.querySelectorAll<HTMLElement>('[data-line]');
    if (!shadowRoot || !lines) return;
    const current = renderStateRef.current;
    for (const element of lines) {
      const line = Number(element.dataset.line);
      if (!Number.isInteger(line)) continue;
      element.toggleAttribute('data-atlas-filtered-out', !lineMatchesFilter(current.node, line, current.codeFilter));
    }
    for (const element of shadowRoot.querySelectorAll<HTMLElement>('[data-char]')) {
      element.toggleAttribute('data-atlas-inspectable', isInspectableSymbol(element.textContent));
    }
    shadowRoot.querySelectorAll<HTMLElement>('[data-atlas-target-token]').forEach(
      (element) => element.removeAttribute('data-atlas-target-token'),
    );
    const target = current.navigationHighlight;
    if (!target?.column) return;
    const targetLine = shadowRoot.querySelector<HTMLElement>(`[data-line="${target.line}"]`);
    const tokens = [...(targetLine?.querySelectorAll<HTMLElement>('[data-char]') ?? [])];
    const offset = target.column - 1;
    const token = tokens.find((element, index) => {
      const start = Number(element.dataset.char);
      const nextStart = Number(tokens[index + 1]?.dataset.char ?? Number.POSITIVE_INFINITY);
      return start <= offset && offset < nextStart;
    });
    token?.setAttribute('data-atlas-target-token', '');
  }, []);

  useEffect(() => {
    const container = hostRef.current?.querySelector('diffs-container') as HTMLElement | null;
    if (container) applySourceDecorations(container);
  }, [node, codeFilter, source, navigationHighlight, applySourceDecorations]);

  const pierreOptions = useMemo(() => ({
    themeType: 'system' as const,
    overflow: 'scroll' as const,
    disableFileHeader: true,
    enableLineSelection: true,
    lineHoverHighlight: 'line' as const,
    onLineClick,
    onTokenClick,
    onPostRender: applySourceDecorations,
    unsafeCSS: PIERRE_SOURCE_CSS,
  }), [applySourceDecorations, onLineClick, onTokenClick]);

  const semanticProvider = analyzers.semantic.providers.find(
    (provider) => provider.language.toLowerCase() === node.language?.toLowerCase(),
  );
  const visibleSymbols = useMemo(
    () => node.symbols.filter((symbol) => symbolMatchesFilter(symbol, codeFilter)),
    [node.symbols, codeFilter],
  );
  const nodesByPath = useMemo(
    () => new Map(nodes.filter((candidate) => candidate.kind === 'file').map((candidate) => [candidate.path, candidate])),
    [nodes],
  );
  const visibleCallers = useMemo(
    () => filterCallTargets(callState.result?.callers ?? [], nodesByPath, codeFilter),
    [callState.result?.callers, nodesByPath, codeFilter],
  );
  const visibleCallees = useMemo(
    () => filterCallTargets(callState.result?.callees ?? [], nodesByPath, codeFilter),
    [callState.result?.callees, nodesByPath, codeFilter],
  );
  const navigateCallDeclaration = useCallback((target: CallHierarchyTarget) => {
    const location = target.declaration;
    if (location.filePath === node.path) {
      highlightLocation(location.line, location.column, 'symbol', target.name);
    }
    onNavigateFile({
      path: location.filePath,
      line: location.line,
      column: location.column,
      symbol: target.name,
      selection: 'symbol',
    });
  }, [highlightLocation, node.path, onNavigateFile]);
  const navigateCallSite = useCallback((
    symbol: string,
    location: CallHierarchyLocation,
  ) => {
    if (location.filePath === node.path) {
      highlightLocation(location.line, location.column, 'line');
    }
    onNavigateFile({
      path: location.filePath,
      line: location.line,
      column: location.column,
      symbol,
      selection: 'line',
    });
  }, [highlightLocation, node.path, onNavigateFile]);

  return (
    <div className="atlas-source-layout">
      <div className="atlas-source-main">
        <div className="atlas-source-toolbar">
          <div className="atlas-source-file">
            <FileCode2 size={15} />
            <span>{node.path}</span>
            {source?.language && <span className="atlas-badge">{source.language}</span>}
          </div>
          <label className="atlas-inline-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              placeholder="Find in file"
              aria-label="Find in file"
            />
            {query && <span>{matches.length ? `${matchIndex + 1}/${matches.length}` : '0/0'}</span>}
          </label>
          <button
            type="button"
            className="atlas-icon-button"
            disabled={matches.length === 0}
            onClick={() => {
              const next = (matchIndex - 1 + matches.length) % matches.length;
              setMatchIndex(next);
              highlightLocation(matches[next]);
            }}
            title="Previous match"
          ><ArrowLeft size={14} /></button>
          <button
            type="button"
            className="atlas-icon-button"
            disabled={matches.length === 0}
            onClick={() => {
              const next = (matchIndex + 1) % matches.length;
              setMatchIndex(next);
              highlightLocation(matches[next]);
            }}
            title="Next match"
          ><ArrowRight size={14} /></button>
          <button
            type="button"
            className="atlas-icon-button"
            disabled={!source}
            onClick={() => {
              if (!source) return;
              navigator.clipboard.writeText(source.content).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
            title={copied ? 'Copied' : 'Copy source'}
          ><Copy size={14} /></button>
        </div>
        <div className="atlas-source-code" ref={hostRef}>
          {loading && <div className="atlas-loading-inline"><span className="atlas-spinner" />Loading source…</div>}
          {error && <div className="atlas-empty"><strong>Could not load source</strong><span>{error}</span></div>}
          {pierreFile && (
            <File
              key={node.path}
              file={pierreFile}
              selectedLines={navigationHighlight?.range ?? null}
              className="atlas-pierre-file"
              options={pierreOptions}
            />
          )}
        </div>
      </div>
      <aside className="atlas-source-inspector">
        <div className="atlas-inspector-header">
          <Braces size={15} />
          <span>Symbols</span>
          <span className="atlas-count">{visibleSymbols.length}</span>
        </div>
        <div
          className={`atlas-semantic-status${semanticProvider?.available ? ' is-ready' : ' is-unavailable'}`}
          title={semanticProvider?.reason}
        >
          {semanticProvider?.available ? <CircleCheck size={13} /> : <CircleSlash size={13} />}
          <span>
            <strong>{semanticProvider?.available ? 'LSP ready' : 'LSP unavailable'}</strong>
            <small>{semanticProvider?.name ?? `${node.language ?? 'text'} · syntax only`}</small>
          </span>
        </div>
        <div className="atlas-symbol-list" ref={symbolListRef}>
          {visibleSymbols.map((symbol: AtlasSymbol) => (
            <button
              type="button"
              key={symbol.id}
              data-symbol-name={symbol.name}
              className={`atlas-symbol-list-item${referenceState?.symbol === symbol.name ? ' is-active' : ''}`}
              onClick={() => {
                highlightSymbol(symbol);
                inspectSymbol(symbol.name, symbol.line, symbol.column);
              }}
            >
              <span>{symbol.name}</span>
              <small>{symbol.kind} · {symbol.line}</small>
            </button>
          ))}
        </div>
        {referenceState && (
          <div className="atlas-reference-panel">
            <div className="atlas-inspector-header atlas-inspector-header--sticky">
              <LocateFixed size={15} />
              <span title={referenceState.symbol}>{referenceState.symbol}</span>
            </div>
            <div className="atlas-inspector-modes" role="tablist" aria-label="Symbol relationships">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorMode === 'references'}
                className={inspectorMode === 'references' ? 'is-active' : ''}
                onClick={() => setInspectorMode('references')}
              >
                References
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorMode === 'calls'}
                className={inspectorMode === 'calls' ? 'is-active' : ''}
                onClick={() => setInspectorMode('calls')}
              >
                Calls
              </button>
            </div>
            {inspectorMode === 'references' && referenceState.loading && (
              <div className="atlas-loading-inline"><span className="atlas-spinner" />Finding references…</div>
            )}
            {inspectorMode === 'references' && referenceState.error && (
              <div className="atlas-inspector-message">{referenceState.error}</div>
            )}
            {inspectorMode === 'references' && referenceState.result && (
              <>
                <div className={`atlas-reference-provider is-${referenceState.result.provider.status}`}>
                  {referenceState.result.provider.status === 'ready' ? <CircleCheck size={13} /> : <CircleSlash size={13} />}
                  <span>
                    <strong>
                      {referenceState.result.provider.kind === 'lsp' ? 'Semantic navigation' : 'Indexed declarations'}
                    </strong>
                    <small>{referenceState.result.provider.name}</small>
                  </span>
                  {referenceState.result.provider.message && <p>{referenceState.result.provider.message}</p>}
                </div>
                <ReferenceGroup
                  title="Definitions"
                  locations={referenceState.result.definitions}
                  onNavigate={(location) => {
                    if (location.filePath === node.path) {
                      highlightLocation(
                        location.line,
                        location.column,
                        'symbol',
                        referenceState.symbol,
                      );
                    }
                    onNavigateFile({
                      path: location.filePath,
                      line: location.line,
                      column: location.column,
                      symbol: referenceState.symbol,
                      selection: 'symbol',
                    });
                  }}
                />
                {(referenceState.result.provider.kind === 'lsp' || referenceState.result.references.length > 0) && (
                  <ReferenceGroup
                    title="References"
                    locations={referenceState.result.references}
                    onNavigate={(location) => {
                      if (location.filePath === node.path) {
                        highlightLocation(location.line, location.column, 'line');
                      }
                      onNavigateFile({
                        path: location.filePath,
                        line: location.line,
                        column: location.column,
                        symbol: referenceState.symbol,
                        selection: 'line',
                      });
                    }}
                  />
                )}
                {referenceState.result.definitions.length + referenceState.result.references.length === 0 && (
                  <div className="atlas-inspector-message">No indexed locations.</div>
                )}
              </>
            )}
            {inspectorMode === 'calls' && callState.loading && (
              <div className="atlas-loading-inline"><span className="atlas-spinner" />Finding calls…</div>
            )}
            {inspectorMode === 'calls' && callState.error && (
              <div className="atlas-inspector-message">{callState.error}</div>
            )}
            {inspectorMode === 'calls' && callState.result && (
              <>
                <div className={`atlas-reference-provider is-${callState.result.provider.status}`}>
                  {callState.result.provider.status === 'ready' ? <CircleCheck size={13} /> : <CircleSlash size={13} />}
                  <span>
                    <strong>
                      {callState.result.provider.status === 'ready'
                        ? 'Call hierarchy'
                        : callState.result.provider.status === 'unsupported'
                          ? 'Call hierarchy not supported'
                          : 'Call hierarchy unavailable'}
                    </strong>
                    <small>{callState.result.provider.name}</small>
                  </span>
                  {callState.result.provider.message && <p>{callState.result.provider.message}</p>}
                </div>
                {callState.result.provider.status === 'ready' && (
                  <>
                    <CallHierarchyGroup
                      title="Callers"
                      targets={visibleCallers}
                      onNavigateDeclaration={navigateCallDeclaration}
                      onNavigateCallSite={(_, location) => navigateCallSite(
                        callState.result?.root?.name ?? referenceState.symbol,
                        location,
                      )}
                    />
                    <CallHierarchyGroup
                      title="Callees"
                      targets={visibleCallees}
                      onNavigateDeclaration={navigateCallDeclaration}
                      onNavigateCallSite={(target, location) => navigateCallSite(target.name, location)}
                    />
                    {callState.result.truncated && (
                      <div className="atlas-inspector-message">
                        Additional call sites were omitted to keep this view responsive.
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
        {!referenceState && (
          <div className="atlas-inspector-message">No symbol selected.</div>
        )}
      </aside>
    </div>
  );
}
