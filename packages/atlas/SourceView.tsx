import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { File } from '@pierre/diffs/react';
import type { LineEventBaseProps, SelectedLineRange, TokenEventBase } from '@pierre/diffs';
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronDown,
  Copy,
  FileCode2,
  LocateFixed,
  Search,
} from 'lucide-react';
import { fetchReferences, fetchSource } from './api';
import type { AtlasNode, AtlasSymbol, ReferenceLocation, ReferenceResponse, SourceFile } from './types';

interface NavigationTarget {
  path: string;
  line?: number;
  symbol?: string;
}

interface SourceViewProps {
  node: AtlasNode;
  targetLine?: number;
  targetSymbol?: string;
  onNavigateFile: (target: NavigationTarget) => void;
}

function locationKey(location: ReferenceLocation) {
  return `${location.filePath}:${location.line}:${location.column}`;
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

export function SourceView({ node, targetLine, targetSymbol, onNavigateFile }: SourceViewProps) {
  const [source, setSource] = useState<SourceFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [referenceState, setReferenceState] = useState<{
    symbol: string;
    loading: boolean;
    result: ReferenceResponse | null;
    error?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

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
      line.toLowerCase().includes(needle) ? [index + 1] : [],
    );
  }, [source, query]);

  const scrollToLine = useCallback((line: number) => {
    const container = hostRef.current?.querySelector('diffs-container') as HTMLElement & { shadowRoot: ShadowRoot } | null;
    const lineElement = container?.shadowRoot?.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
    lineElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!source || !targetLine) return;
    const timeout = window.setTimeout(() => scrollToLine(targetLine), 180);
    return () => window.clearTimeout(timeout);
  }, [source, targetLine, scrollToLine]);

  useEffect(() => {
    if (matches.length === 0) return;
    setMatchIndex((current) => Math.min(current, matches.length - 1));
  }, [matches.length]);

  const inspectSymbol = useCallback((symbol: string) => {
    const clean = symbol.trim();
    if (!clean) return;
    const controller = new AbortController();
    setReferenceState({ symbol: clean, loading: true, result: null });
    fetchReferences(clean, node.path, controller.signal)
      .then((result) => setReferenceState({ symbol: clean, loading: false, result }))
      .catch((reason: unknown) => setReferenceState({
        symbol: clean,
        loading: false,
        result: null,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
  }, [node.path]);

  useEffect(() => {
    if (targetSymbol) inspectSymbol(targetSymbol);
  }, [targetSymbol, inspectSymbol]);

  const onTokenClick = useCallback((props: TokenEventBase, event: MouseEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const value = props.tokenText.replace(/^[^\w$]+|[^\w$]+$/g, '');
    if (value) inspectSymbol(value);
  }, [inspectSymbol]);

  const selectedLines: SelectedLineRange | null = targetLine
    ? { start: targetLine, end: targetLine }
    : matches[matchIndex]
      ? { start: matches[matchIndex], end: matches[matchIndex] }
      : null;

  const symbolsByName = useMemo(() => new Map(node.symbols.map((symbol) => [symbol.name, symbol])), [node.symbols]);

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
              scrollToLine(matches[next]);
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
              scrollToLine(matches[next]);
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
          {source && (
            <File
              key={node.path}
              file={{ name: node.name, contents: source.content }}
              selectedLines={selectedLines}
              className="atlas-pierre-file"
              options={{
                themeType: 'system',
                overflow: 'scroll',
                disableFileHeader: true,
                enableLineSelection: true,
                lineHoverHighlight: 'line',
                onLineClick: (props: LineEventBaseProps) => {
                  if (props.lineNumber) scrollToLine(props.lineNumber);
                },
                onTokenClick,
                unsafeCSS: `
                  :host { height: 100% !important; color-scheme: light dark; }
                  [data-file], [data-code] { height: 100% !important; }
                  [data-code] { overflow: auto !important; }
                  [data-token] { cursor: pointer; }
                `,
              }}
            />
          )}
        </div>
      </div>
      <aside className="atlas-source-inspector">
        <div className="atlas-inspector-header">
          <Braces size={15} />
          <span>Symbols</span>
          <span className="atlas-count">{node.symbols.length}</span>
        </div>
        <div className="atlas-symbol-list">
          {node.symbols.map((symbol: AtlasSymbol) => (
            <button
              type="button"
              key={symbol.id}
              className={`atlas-symbol-list-item${referenceState?.symbol === symbol.name ? ' is-active' : ''}`}
              onClick={() => {
                scrollToLine(symbol.line);
                inspectSymbol(symbol.name);
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
                <ReferenceGroup
                  title="Definitions"
                  locations={referenceState.result.definitions}
                  onNavigate={(location) => onNavigateFile({ path: location.filePath, line: location.line, symbol: referenceState.symbol })}
                />
                <ReferenceGroup
                  title="References"
                  locations={referenceState.result.references}
                  onNavigate={(location) => onNavigateFile({ path: location.filePath, line: location.line, symbol: referenceState.symbol })}
                />
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
