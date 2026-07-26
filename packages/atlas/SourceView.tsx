import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { File } from '@pierre/diffs/react';
import type { LineEventBaseProps, SelectedLineRange, TokenEventBase } from '@pierre/diffs';
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Copy,
  FileCode2,
  LocateFixed,
  Search,
} from 'lucide-react';
import { fetchReferences, fetchSource } from './api';
import { lineMatchesFilter, symbolMatchesFilter } from './codeFilter';
import { referencePositionFromToken } from './referencePosition';
import type {
  AtlasAnalyzers,
  AtlasNode,
  AtlasSymbol,
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
}

interface SourceViewProps {
  node: AtlasNode;
  analyzers: AtlasAnalyzers;
  targetLine?: number;
  targetColumn?: number;
  targetSymbol?: string;
  codeFilter: CodeFilter;
  onNavigateFile: (target: NavigationTarget) => void;
}

const PIERRE_SOURCE_CSS = `
  :host { height: 100% !important; color-scheme: light dark; }
  [data-file], [data-code] { height: 100% !important; }
  [data-code] { overflow: auto !important; }
  [data-token] { cursor: pointer; }
  [data-atlas-filtered-out] { opacity: .2; }
`;

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

export function SourceView({
  node,
  analyzers,
  targetLine,
  targetColumn,
  targetSymbol,
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
  const [copied, setCopied] = useState(false);
  const [navigationHighlight, setNavigationHighlight] = useState<SelectedLineRange | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const lineFilterRef = useRef({ node, codeFilter });
  lineFilterRef.current = { node, codeFilter };

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
    const lineElement = container?.shadowRoot?.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
    lineElement?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, []);

  const highlightLocation = useCallback((line: number, symbolName?: string) => {
    setNavigationHighlight(navigationSelection(node, line, symbolName));
    scrollToLine(line);
  }, [node, scrollToLine]);

  const highlightSymbol = useCallback((symbol: AtlasSymbol) => {
    setNavigationHighlight({
      start: symbol.line,
      end: symbol.kind === 'module' ? symbol.line : symbol.endLine,
    });
    scrollToLine(symbol.line);
  }, [scrollToLine]);

  useEffect(() => {
    if (!source || !targetLine) return;
    setNavigationHighlight(navigationSelection(node, targetLine, targetSymbol));
    const timeout = window.setTimeout(() => scrollToLine(targetLine), 180);
    return () => window.clearTimeout(timeout);
  }, [source, node, targetLine, targetSymbol, scrollToLine]);

  useEffect(() => {
    if (!navigationHighlight) return;
    const clearHighlight = () => setNavigationHighlight(null);
    document.addEventListener('pointerdown', clearHighlight, { capture: true });
    return () => document.removeEventListener('pointerdown', clearHighlight, { capture: true });
  }, [navigationHighlight]);

  useEffect(() => {
    if (matches.length === 0) return;
    setMatchIndex((current) => Math.min(current, matches.length - 1));
  }, [matches.length]);

  const inspectSymbol = useCallback((symbol: string, line: number, column: number) => {
    const clean = symbol.trim();
    if (!clean) return;
    const controller = new AbortController();
    setReferenceState({ symbol: clean, line, column, loading: true, result: null });
    fetchReferences(clean, node.path, line, column, controller.signal)
      .then((result) => setReferenceState({ symbol: clean, line, column, loading: false, result }))
      .catch((reason: unknown) => setReferenceState({
        symbol: clean,
        line,
        column,
        loading: false,
        result: null,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
  }, [node.path]);

  useEffect(() => {
    if (targetSymbol && targetLine && targetColumn) {
      inspectSymbol(targetSymbol, targetLine, targetColumn);
    }
  }, [targetSymbol, targetLine, targetColumn, inspectSymbol]);

  const onTokenClick = useCallback((props: TokenEventBase, event: MouseEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const position = referencePositionFromToken(props);
    if (position) inspectSymbol(position.symbol, position.line, position.column);
  }, [inspectSymbol]);

  const pierreFile = useMemo(() => source
    ? { name: node.name, contents: source.content }
    : null, [node.name, source]);

  const onLineClick = useCallback((props: LineEventBaseProps) => {
    if (props.lineNumber) setNavigationHighlight(null);
  }, []);

  const applyLineFilter = useCallback((container: HTMLElement) => {
    const lines = container.shadowRoot?.querySelectorAll<HTMLElement>('[data-line]');
    if (!lines) return;
    const current = lineFilterRef.current;
    for (const element of lines) {
      const line = Number(element.dataset.line);
      if (!Number.isInteger(line)) continue;
      element.toggleAttribute('data-atlas-filtered-out', !lineMatchesFilter(current.node, line, current.codeFilter));
    }
  }, []);

  useEffect(() => {
    const container = hostRef.current?.querySelector('diffs-container') as HTMLElement | null;
    if (container) applyLineFilter(container);
  }, [node, codeFilter, source, applyLineFilter]);

  const pierreOptions = useMemo(() => ({
    themeType: 'system' as const,
    overflow: 'scroll' as const,
    disableFileHeader: true,
    enableLineSelection: true,
    lineHoverHighlight: 'line' as const,
    onLineClick,
    onTokenClick,
    onPostRender: applyLineFilter,
    unsafeCSS: PIERRE_SOURCE_CSS,
  }), [applyLineFilter, onLineClick, onTokenClick]);

  const semanticProvider = analyzers.semantic.providers.find(
    (provider) => provider.language.toLowerCase() === node.language?.toLowerCase(),
  );
  const visibleSymbols = useMemo(
    () => node.symbols.filter((symbol) => symbolMatchesFilter(symbol, codeFilter)),
    [node.symbols, codeFilter],
  );

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
              selectedLines={navigationHighlight}
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
        <div className="atlas-symbol-list">
          {visibleSymbols.map((symbol: AtlasSymbol) => (
            <button
              type="button"
              key={symbol.id}
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
            {referenceState.loading && <div className="atlas-loading-inline"><span className="atlas-spinner" />Finding references…</div>}
            {referenceState.error && <div className="atlas-inspector-message">{referenceState.error}</div>}
            {referenceState.result && (
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
                      highlightLocation(location.line, referenceState.symbol);
                    }
                    onNavigateFile({
                      path: location.filePath,
                      line: location.line,
                      column: location.column,
                      symbol: referenceState.symbol,
                    });
                  }}
                />
                {(referenceState.result.provider.kind === 'lsp' || referenceState.result.references.length > 0) && (
                  <ReferenceGroup
                    title="References"
                    locations={referenceState.result.references}
                    onNavigate={(location) => {
                      if (location.filePath === node.path) {
                        highlightLocation(location.line, referenceState.symbol);
                      }
                      onNavigateFile({
                        path: location.filePath,
                        line: location.line,
                        column: location.column,
                        symbol: referenceState.symbol,
                      });
                    }}
                  />
                )}
                {referenceState.result.definitions.length + referenceState.result.references.length === 0 && (
                  <div className="atlas-inspector-message">No indexed locations.</div>
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
