import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@plannotator/atlas/styles';
import {
  Blocks,
  Braces,
  CircleAlert,
  CircleCheck,
  Code2,
  ExternalLink,
  FileCode2,
  FlaskConical,
  LoaderCircle,
  Network,
  RefreshCw,
} from 'lucide-react';
import {
  AtlasWorkspace,
  AtlasRequestError,
  fetchCallHierarchy,
  fetchReferences,
  fetchSnapshot,
  fetchSource,
  fetchStatus,
  type AtlasIndexStatus,
  type AtlasNode,
  type AtlasSnapshot,
  type AtlasSourceAnnotationDraft,
  type AtlasSourceLoaders,
  type AtlasView,
  type AtlasWorkspaceSourceTarget,
  type BlockMapActivation,
  type CallHierarchyResponse,
  type CodeFilter,
  type ColorMetric,
  type ReferenceResponse,
  type SizeMetric,
} from '@plannotator/atlas';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  buildReviewAtlasImpact,
  buildReviewAtlasScope,
  reviewAtlasDiffTarget,
  type ReviewAtlasImpact,
  type ReviewAtlasImpactKind,
  type ReviewAtlasImpactResult,
  type ReviewAtlasScope,
  type ReviewAtlasSymbolHotspot,
} from '../utils/reviewAtlasScope';

export type ReviewAtlasMode = 'scope' | 'codebase';

export interface ReviewAtlasFocusTarget {
  path: string;
  kind: 'file' | 'directory';
  token: number;
}

interface ReviewAtlasSurfaceProps {
  mode: ReviewAtlasMode;
  repositoryKey: string;
  rawPatch: string;
  onOpenDiffFile: (path: string) => void;
  onRequestCodebase: () => void;
  annotations: CodeAnnotation[];
  aiAvailable: boolean;
  navigationTarget?: AtlasWorkspaceSourceTarget & { token: number };
  focusTarget?: ReviewAtlasFocusTarget;
  onAddAnnotation: (draft: AtlasSourceAnnotationDraft) => void;
  onUpdateAnnotation: (id: string, text: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onAskAI: (question: string, draft: AtlasSourceAnnotationDraft) => void;
}

type AtlasSurfaceState =
  | { kind: 'loading'; message: string }
  | { kind: 'unavailable'; message: string; retryable: boolean }
  | { kind: 'error'; message: string; retryable: boolean }
  | { kind: 'ready'; status: AtlasIndexStatus; snapshot: AtlasSnapshot };

type ImpactState =
  | { kind: 'idle' }
  | { kind: 'loading'; hotspotId: string }
  | { kind: 'error'; hotspotId: string; message: string }
  | {
    kind: 'ready';
    hotspotId: string;
    impact: ReviewAtlasImpact;
    warnings: string[];
  };

const SOURCE_LOADERS: AtlasSourceLoaders = {
  loadSource: fetchSource,
  loadReferences: fetchReferences,
  loadCalls: fetchCallHierarchy,
};

const ATLAS_VIEWS: Array<{
  id: AtlasView;
  label: string;
  icon: typeof Blocks;
}> = [
  { id: 'overview', label: 'Overview', icon: Blocks },
  { id: 'symbols', label: 'Symbols', icon: Braces },
  { id: 'source', label: 'Source', icon: Code2 },
];

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function reviewAtlasRequestFailure(reason: unknown): {
  unavailable: boolean;
  message: string;
  retryable: boolean;
} {
  if (reason instanceof AtlasRequestError) {
    return {
      unavailable:
        reason.capability?.available === false
        || reason.status === 404
        || reason.status === 409,
      message: reason.capability?.message || reason.message,
      retryable: reason.retryable,
    };
  }
  return {
    unavailable: false,
    message: errorMessage(reason),
    retryable: true,
  };
}

function AtlasSurfaceStatus({
  state,
  onRetry,
}: {
  state: Exclude<AtlasSurfaceState, { kind: 'ready' }>;
  onRetry: () => void;
}) {
  const loading = state.kind === 'loading';
  return (
    <div
      className="review-atlas-state"
      role={state.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className={`review-atlas-state__mark${state.kind === 'error' ? ' is-error' : ''}`}>
        {loading
          ? <LoaderCircle size={20} className="review-atlas-spin" aria-hidden />
          : <CircleAlert size={20} aria-hidden />}
      </div>
      <strong>
        {loading
          ? 'Preparing codebase map'
          : state.kind === 'unavailable'
            ? 'Codebase map unavailable'
            : 'Could not load codebase map'}
      </strong>
      <span>{state.message}</span>
      {state.kind !== 'loading' && state.retryable && (
        <button type="button" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}

const IMPACT_GROUPS: Array<{
  kind: ReviewAtlasImpactKind;
  label: string;
}> = [
  { kind: 'caller', label: 'Callers' },
  { kind: 'callee', label: 'Callees' },
  { kind: 'reference', label: 'References' },
];

function impactWarnings(
  references: ReferenceResponse | undefined,
  calls: CallHierarchyResponse | undefined,
  failures: string[],
): string[] {
  const warnings = [...failures];
  if (references?.provider.status !== 'ready') {
    warnings.push(
      references?.provider.message
      || `${references?.provider.name ?? 'Semantic provider'} could not resolve references.`,
    );
  }
  if (calls?.provider.status !== 'ready') {
    warnings.push(
      calls?.provider.message
      || `${calls?.provider.name ?? 'Semantic provider'} could not resolve calls.`,
    );
  }
  return [...new Set(warnings)];
}

function ScopeImpactResults({
  state,
  hotspot,
  onNavigate,
  onOpenHotspot,
  onRetry,
}: {
  state: ImpactState;
  hotspot: ReviewAtlasSymbolHotspot | null;
  onNavigate: (result: ReviewAtlasImpactResult) => void;
  onOpenHotspot: (hotspot: ReviewAtlasSymbolHotspot) => void;
  onRetry: () => void;
}) {
  if (!hotspot || state.kind === 'idle') {
    return (
      <div className="review-atlas-impact-empty">
        <Network size={16} aria-hidden />
        <span>Select a changed symbol to resolve its callers, callees, and references.</span>
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="review-atlas-impact-empty" role="status">
        <LoaderCircle size={16} className="review-atlas-spin" aria-hidden />
        <span>Resolving semantic impact...</span>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="review-atlas-impact-empty is-error" role="alert">
        <CircleAlert size={16} aria-hidden />
        <span>{state.message}</span>
        <button type="button" onClick={onRetry}>
          <RefreshCw size={12} aria-hidden />
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="review-atlas-impact-selection">
        <div>
          <strong>{hotspot.name}</strong>
          <span>{hotspot.filePath}:{hotspot.line}</span>
        </div>
        <button
          type="button"
          onClick={() => onOpenHotspot(hotspot)}
          title="Open symbol in source"
        >
          <ExternalLink size={13} aria-hidden />
        </button>
      </div>
      {state.warnings.map((warning) => (
        <div className="review-atlas-impact-warning" key={warning}>
          <CircleAlert size={12} aria-hidden />
          <span>{warning}</span>
        </div>
      ))}
      {IMPACT_GROUPS.map(({ kind, label }) => {
        const results = state.impact.results[kind];
        return (
          <section className="review-atlas-impact-group" key={kind}>
            <h4>{label}<span>{results.length}</span></h4>
            {results.map((result) => (
              <button type="button" key={result.id} onClick={() => onNavigate(result)}>
                <span className="review-atlas-impact-result__title">
                  <strong>{result.label}</strong>
                  <small>{result.filePath}:{result.line}:{result.column}</small>
                </span>
                <code>{result.snippet || 'Source location'}</code>
              </button>
            ))}
            {results.length === 0 && <p>No indexed {label.toLowerCase()}.</p>}
          </section>
        );
      })}
    </>
  );
}

function ScopeSidebar({
  scope,
  selectedHotspotId,
  impactState,
  onSelectHotspot,
  onNavigateImpact,
  onOpenHotspot,
  onRetryImpact,
}: {
  scope: ReviewAtlasScope;
  selectedHotspotId: string | null;
  impactState: ImpactState;
  onSelectHotspot: (hotspot: ReviewAtlasSymbolHotspot) => void;
  onNavigateImpact: (result: ReviewAtlasImpactResult) => void;
  onOpenHotspot: (hotspot: ReviewAtlasSymbolHotspot) => void;
  onRetryImpact: () => void;
}) {
  const [hotspotLimit, setHotspotLimit] = useState(75);
  const selectedHotspot = scope.hotspots.find((hotspot) => hotspot.id === selectedHotspotId) ?? null;
  useEffect(() => setHotspotLimit(75), [scope]);
  return (
    <aside className="review-atlas-scope-sidebar" aria-label="Change hotspots and impact">
      <section className="review-atlas-hotspots">
        <header>
          <span>Changed symbols</span>
          <strong>{scope.hotspots.length}</strong>
        </header>
        <div className="review-atlas-hotspot-list">
          {scope.hotspots.slice(0, hotspotLimit).map((hotspot, index) => (
            <button
              type="button"
              key={hotspot.id}
              className={selectedHotspotId === hotspot.id ? 'is-selected' : ''}
              aria-pressed={selectedHotspotId === hotspot.id}
              onClick={() => onSelectHotspot(hotspot)}
            >
              <span className="review-atlas-hotspot-rank">{index + 1}</span>
              <span className="review-atlas-hotspot-main">
                <strong>{hotspot.name}</strong>
                <small>{hotspot.filePath}:{hotspot.line}</small>
                <span>
                  {hotspot.kind}
                  {' · '}{hotspot.changedLines} changed
                  {hotspot.complexity > 1 && ` · cx ${hotspot.complexity}`}
                </span>
              </span>
              <span className="review-atlas-hotspot-flags">
                {hotspot.isTest && <FlaskConical size={12} aria-label="Test symbol" />}
                {hotspot.exported && <ExternalLink size={12} aria-label="Exported symbol" />}
              </span>
            </button>
          ))}
          {scope.hotspots.length === 0 && (
            <div className="review-atlas-hotspot-empty">
              <FileCode2 size={16} aria-hidden />
              <span>No indexed symbols overlap the changed new-side lines.</span>
            </div>
          )}
          {scope.hotspots.length > hotspotLimit && (
            <button
              type="button"
              className="review-atlas-hotspot-more"
              onClick={() => setHotspotLimit((current) => current + 75)}
            >
              Show more ({scope.hotspots.length - hotspotLimit} remaining)
            </button>
          )}
        </div>
      </section>
      <section className="review-atlas-impact">
        <header>
          <span>Semantic impact</span>
          {impactState.kind === 'ready' && (
            <strong>{Object.values(impactState.impact.results).reduce(
              (total, results) => total + results.length,
              0,
            )}</strong>
          )}
        </header>
        <div className="review-atlas-impact-body">
          <ScopeImpactResults
            state={impactState}
            hotspot={selectedHotspot}
            onNavigate={onNavigateImpact}
            onOpenHotspot={onOpenHotspot}
            onRetry={onRetryImpact}
          />
        </div>
      </section>
    </aside>
  );
}

export function ReviewAtlasSurface({
  mode,
  repositoryKey,
  rawPatch,
  onOpenDiffFile,
  onRequestCodebase,
  annotations,
  aiAvailable,
  navigationTarget,
  focusTarget,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onAskAI,
}: ReviewAtlasSurfaceProps) {
  const [loadKey, setLoadKey] = useState(0);
  const [surfaceState, setSurfaceState] = useState<AtlasSurfaceState>({
    kind: 'loading',
    message: 'Checking for a repository index...',
  });
  const loadedRevisionRef = useRef<number | null>(null);
  const snapshotRef = useRef<AtlasSnapshot | null>(null);

  const [view, setView] = useState<AtlasView>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const [sizeMetric, setSizeMetric] = useState<SizeMetric>('lines');
  const [colorMetric, setColorMetric] = useState<ColorMetric>('language');
  const [codeFilter, setCodeFilter] = useState<CodeFilter>('all');
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 720px)').matches,
  );
  const [sourceHistory, setSourceHistory] = useState<AtlasWorkspaceSourceTarget[]>([]);
  const [sourceHistoryIndex, setSourceHistoryIndex] = useState(-1);
  const sourceRequestIdRef = useRef(0);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [impactState, setImpactState] = useState<ImpactState>({ kind: 'idle' });
  const repositoryKeyRef = useRef(repositoryKey);

  useEffect(() => {
    if (repositoryKeyRef.current === repositoryKey) return;
    repositoryKeyRef.current = repositoryKey;
    snapshotRef.current = null;
    loadedRevisionRef.current = null;
    setSelectedId(null);
    setFocusedRootId(null);
    setSourceHistory([]);
    setSourceHistoryIndex(-1);
    setSelectedHotspotId(null);
    setImpactState({ kind: 'idle' });
    setQuery('');
    setRelationshipsOpen(false);
    setLoadKey((key) => key + 1);
  }, [repositoryKey]);
  const [impactLoadKey, setImpactLoadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const status = await fetchStatus(controller.signal);
        let snapshot = snapshotRef.current;
        if (
          status.hasSnapshot
          && (!snapshot || loadedRevisionRef.current !== status.revision)
        ) {
          snapshot = await fetchSnapshot(controller.signal);
          snapshotRef.current = snapshot;
          loadedRevisionRef.current = status.revision;
        }
        if (disposed) return;

        if (snapshot) {
          setSurfaceState({ kind: 'ready', status, snapshot });
        } else if (status.phase === 'checking' || status.phase === 'indexing') {
          setSurfaceState({
            kind: 'loading',
            message:
              status.capability?.message
              || 'Indexing files, symbols, and module relationships...',
          });
        } else {
          setSurfaceState({
            kind: 'error',
            message: status.error || 'The repository index did not produce a snapshot.',
            retryable: true,
          });
        }

        const working = status.phase === 'checking'
          || status.phase === 'indexing'
          || status.refreshing;
        timer = setTimeout(poll, working ? 900 : 3000);
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        const failure = reviewAtlasRequestFailure(reason);
        const snapshot = snapshotRef.current;
        if (snapshot && !failure.unavailable) {
          setSurfaceState({
            kind: 'ready',
            status: {
              status: 'error',
              phase: 'error',
              hasSnapshot: true,
              revision: loadedRevisionRef.current ?? 0,
              refreshing: false,
              persistent: false,
              error: failure.message,
            },
            snapshot,
          });
        } else {
          setSurfaceState({
            kind: failure.unavailable ? 'unavailable' : 'error',
            message: failure.message,
            retryable: failure.retryable,
          });
        }
        if (failure.retryable) timer = setTimeout(poll, 3000);
      }
    };

    setSurfaceState((current) => snapshotRef.current
      ? current
      : { kind: 'loading', message: 'Checking for a repository index...' });
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [loadKey]);

  const snapshot = surfaceState.kind === 'ready' ? surfaceState.snapshot : null;
  const nodes = snapshot?.nodes ?? [];
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const selectedFile = selectedId ? byId.get(selectedId) : undefined;
  const currentSourceTarget = sourceHistory[sourceHistoryIndex];
  const scope = useMemo(
    () => snapshot ? buildReviewAtlasScope(rawPatch, snapshot.nodes) : null,
    [rawPatch, snapshot],
  );
  const selectedHotspot = scope?.hotspots.find(
    (hotspot) => hotspot.id === selectedHotspotId,
  ) ?? null;
  const currentImpactState: ImpactState = impactState.kind !== 'idle'
    && impactState.hotspotId !== selectedHotspotId
    ? selectedHotspot
      ? { kind: 'loading', hotspotId: selectedHotspot.id }
      : { kind: 'idle' }
    : impactState;

  useEffect(() => {
    if (!selectedHotspotId || selectedHotspot) return;
    setSelectedHotspotId(null);
    setImpactState({ kind: 'idle' });
  }, [selectedHotspot, selectedHotspotId]);

  useEffect(() => {
    if (!scope || !snapshot || !selectedHotspot) {
      setImpactState({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    const hotspot = selectedHotspot;
    setImpactState({ kind: 'loading', hotspotId: hotspot.id });

    void Promise.allSettled([
      SOURCE_LOADERS.loadReferences(
        hotspot.name,
        hotspot.filePath,
        hotspot.line,
        hotspot.column,
        controller.signal,
      ),
      SOURCE_LOADERS.loadCalls(
        hotspot.filePath,
        hotspot.line,
        hotspot.column,
        controller.signal,
      ),
    ]).then(([referenceResult, callResult]) => {
      if (controller.signal.aborted) return;
      const references = referenceResult.status === 'fulfilled'
        ? referenceResult.value
        : undefined;
      const calls = callResult.status === 'fulfilled'
        ? callResult.value
        : undefined;
      const failures = [
        ...(referenceResult.status === 'rejected'
          ? [`References: ${errorMessage(referenceResult.reason)}`]
          : []),
        ...(callResult.status === 'rejected'
          ? [`Calls: ${errorMessage(callResult.reason)}`]
          : []),
      ];
      if (!references && !calls) {
        setImpactState({
          kind: 'error',
          hotspotId: hotspot.id,
          message: failures.join(' ') || 'Semantic impact could not be resolved.',
        });
        return;
      }
      setImpactState({
        kind: 'ready',
        hotspotId: hotspot.id,
        impact: buildReviewAtlasImpact(scope, hotspot, snapshot.nodes, references, calls),
        warnings: impactWarnings(references, calls, failures),
      });
    });
    return () => controller.abort();
  }, [impactLoadKey, scope, selectedHotspot, snapshot]);

  useEffect(() => {
    if (!root) return;
    setFocusedRootId((current) => current && byId.has(current) ? current : root.id);
    setSelectedId((current) => current && byId.has(current) ? current : root.id);
  }, [byId, root]);

  const openSource = useCallback((target: AtlasWorkspaceSourceTarget) => {
    const node = nodes.find((entry) => entry.kind === 'file' && entry.path === target.path);
    if (!node) return;
    const nextTarget = {
      ...target,
      requestId: target.requestId ?? ++sourceRequestIdRef.current,
    };
    setSelectedId(node.id);
    setView('source');
    setSourceHistory((history) => [
      ...history.slice(0, sourceHistoryIndex + 1),
      nextTarget,
    ]);
    setSourceHistoryIndex((index) => index + 1);
  }, [nodes, sourceHistoryIndex]);

  const handledNavigationTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!navigationTarget || handledNavigationTokenRef.current === navigationTarget.token) return;
    if (!nodes.some((node) => node.kind === 'file' && node.path === navigationTarget.path)) return;
    handledNavigationTokenRef.current = navigationTarget.token;
    openSource(navigationTarget);
  }, [navigationTarget, nodes, openSource]);

  const handledFocusTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      mode !== 'scope'
      || !focusTarget
      || handledFocusTokenRef.current === focusTarget.token
    ) return;
    const node = nodes.find((entry) => (
      entry.path === focusTarget.path
      && (focusTarget.kind === 'file' ? entry.kind === 'file' : entry.kind !== 'file')
    ));
    if (!node) return;
    handledFocusTokenRef.current = focusTarget.token;
    setSelectedId(node.id);
    if (node.kind !== 'file') setFocusedRootId(node.id);
    setSelectedHotspotId(null);
    setImpactState({ kind: 'idle' });
  }, [focusTarget, mode, nodes]);

  const navigateSourceHistory = useCallback((index: number) => {
    const target = sourceHistory[index];
    if (!target) return;
    const node = nodes.find((entry) => entry.kind === 'file' && entry.path === target.path);
    if (!node) return;
    setSourceHistoryIndex(index);
    setSelectedId(node.id);
  }, [nodes, sourceHistory]);

  const openScopeSource = useCallback((target: AtlasWorkspaceSourceTarget) => {
    openSource(target);
    onRequestCodebase();
  }, [onRequestCodebase, openSource]);

  const navigateImpact = useCallback((result: ReviewAtlasImpactResult) => {
    openScopeSource({
      path: result.filePath,
      line: result.line,
      column: result.column,
      symbol: result.symbol,
      selection: 'symbol',
    });
  }, [openScopeSource]);

  const navigateNode = useCallback((node: AtlasNode) => {
    setSelectedId(node.id);
    if (node.kind === 'file') {
      if (mode === 'scope' && scope?.changedFileNodeIds.has(node.id)) {
        onOpenDiffFile(node.path);
        return;
      }
      if (mode === 'codebase') setView('symbols');
      return;
    }
    setFocusedRootId(node.id);
    if (mode === 'codebase') setView('overview');
  }, [mode, onOpenDiffFile, scope?.changedFileNodeIds]);

  const handleMapActivate = useCallback((activation: BlockMapActivation) => {
    const diffTarget = scope
      ? reviewAtlasDiffTarget(mode, activation, scope.changedFileNodeIds)
      : null;
    if (diffTarget) {
      onOpenDiffFile(diffTarget);
      return;
    }
    if (
      mode === 'scope'
      && currentImpactState.kind === 'ready'
      && activation.node.kind === 'file'
    ) {
      const result = IMPACT_GROUPS
        .flatMap(({ kind }) => currentImpactState.impact.results[kind])
        .find((candidate) => candidate.filePath === activation.node.path);
      if (result) {
        navigateImpact(result);
        return;
      }
    }
    navigateNode(activation.node);
  }, [currentImpactState, mode, navigateImpact, navigateNode, onOpenDiffFile, scope]);

  if (surfaceState.kind !== 'ready' || !snapshot || !root) {
    return (
      <AtlasSurfaceStatus
        state={surfaceState.kind === 'ready'
          ? { kind: 'error', message: 'The repository index is empty.', retryable: true }
          : surfaceState}
        onRetry={() => setLoadKey((key) => key + 1)}
      />
    );
  }

  const effectiveView: AtlasView = mode === 'scope' ? 'overview' : view;
  const indexWorking = surfaceState.status.phase === 'checking'
    || surfaceState.status.phase === 'indexing'
    || surfaceState.status.refreshing;

  return (
    <section className="review-atlas-host" aria-label={mode === 'scope' ? 'Change scope' : 'Codebase'}>
      <div className="review-atlas-host__header">
        <nav className="review-atlas-host__views" aria-label="Codebase views">
          {mode === 'scope' ? (
            <span className="is-active"><Blocks size={13} aria-hidden />Change map</span>
          ) : ATLAS_VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={effectiveView === id ? 'is-active' : ''}
              disabled={(id === 'symbols' || id === 'source') && selectedFile?.kind !== 'file'}
              onClick={() => {
                if (id === 'source' && selectedFile?.kind === 'file') {
                  if (currentSourceTarget?.path !== selectedFile.path) {
                    openSource({ path: selectedFile.path });
                    return;
                  }
                }
                setView(id);
              }}
            >
              <Icon size={13} aria-hidden />
              {label}
            </button>
          ))}
        </nav>
        {mode === 'scope' && scope && (
          <div className="review-atlas-host__summary" role="status">
            <strong>{scope.diff.totals.changedFiles} files</strong>
            <span className="is-addition">+{scope.diff.totals.additions}</span>
            <span className="is-deletion">-{scope.diff.totals.deletions}</span>
            {scope.aggregation.unmappedFiles.length > 0 && (
              <span title="Deleted or not present in the current index">
                {scope.aggregation.unmappedFiles.length} outside map
              </span>
            )}
          </div>
        )}
        <div
          className={`review-atlas-host__index${indexWorking ? ' is-working' : ''}${
            surfaceState.status.phase === 'error' ? ' is-error' : ''
          }`}
          title={surfaceState.status.phase === 'error'
            ? surfaceState.status.error || 'The current map may be stale.'
            : !surfaceState.status.persistent
              ? surfaceState.status.persistenceError || 'The current index is not persisted.'
            : `Indexed ${new Date(snapshot.generatedAt).toLocaleString()}`}
        >
          {surfaceState.status.phase === 'error'
            ? <CircleAlert size={12} aria-hidden />
            : indexWorking
            ? <LoaderCircle size={12} className="review-atlas-spin" aria-hidden />
            : <CircleCheck size={12} aria-hidden />}
          <span>{surfaceState.status.phase === 'error'
            ? 'Index stale'
            : !surfaceState.status.persistent
              ? 'Index not saved'
            : indexWorking ? 'Updating index' : 'Index ready'}</span>
        </div>
      </div>
      <div className={`review-atlas-host__workspace${mode === 'scope' ? ' is-scope' : ''}`}>
        <div className="review-atlas-host__canvas">
          <AtlasWorkspace
            snapshot={snapshot}
            view={effectiveView}
            selectedId={selectedId}
            focusedRootId={focusedRootId}
            sizeMetric={sizeMetric}
            colorMetric={colorMetric}
            codeFilter={codeFilter}
            relationshipsOpen={relationshipsOpen}
            query={query}
            showRepositorySidebar={mode === 'codebase'}
            sidebarOpen={sidebarOpen}
            sourceTarget={currentSourceTarget}
            canNavigateSourceBack={sourceHistoryIndex > 0}
            canNavigateSourceForward={sourceHistoryIndex < sourceHistory.length - 1}
            annotations={annotations.filter((annotation) => annotation.source === 'atlas')}
            capabilities={{ annotations: true, askAI: aiAvailable }}
            mapOverlay={mode === 'scope'
              ? currentImpactState.kind === 'ready'
                ? currentImpactState.impact.overlay
                : scope?.overlay
              : undefined}
            sourceLoaders={SOURCE_LOADERS}
            onMapActivate={handleMapActivate}
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
            onAddAnnotation={onAddAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onDeleteAnnotation={onDeleteAnnotation}
            onAskAI={onAskAI}
          />
          {mode === 'scope' && currentImpactState.kind === 'ready' && (
            <div className="review-atlas-impact-legend" aria-label="Impact relationship colors">
              <span><i className="is-direct" />Changed symbol</span>
              <span><i className="is-caller" />Caller</span>
              <span><i className="is-callee" />Callee</span>
              <span><i className="is-reference" />Reference</span>
            </div>
          )}
        </div>
        {mode === 'scope' && scope && (
          <ScopeSidebar
            scope={scope}
            selectedHotspotId={selectedHotspotId}
            impactState={currentImpactState}
            onSelectHotspot={(hotspot) => {
              setSelectedHotspotId(hotspot.id);
              setSelectedId(hotspot.fileNodeId);
              setImpactState({ kind: 'loading', hotspotId: hotspot.id });
              setImpactLoadKey((key) => key + 1);
            }}
            onNavigateImpact={navigateImpact}
            onOpenHotspot={(hotspot) => openScopeSource({
              path: hotspot.filePath,
              line: hotspot.line,
              column: hotspot.column,
              symbol: hotspot.name,
              selection: 'symbol',
            })}
            onRetryImpact={() => setImpactLoadKey((key) => key + 1)}
          />
        )}
      </div>
    </section>
  );
}
