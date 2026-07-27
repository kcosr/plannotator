import type {
  AtlasNode,
  AtlasSymbol,
  BlockMapActivation,
  BlockMapImpactRelationship,
  BlockMapNodeOverlay,
  BlockMapOverlay,
  CallHierarchyResponse,
  ReferenceResponse,
} from '@plannotator/atlas';
import {
  aggregateReviewScope,
  parseReviewScopeDiff,
  type ReviewScopeAggregation,
  type ReviewScopeDiff,
} from '@plannotator/core/review-scope';

export interface ReviewAtlasScope {
  diff: ReviewScopeDiff;
  aggregation: ReviewScopeAggregation;
  overlay: BlockMapOverlay;
  changedFileNodeIds: ReadonlySet<string>;
  hotspots: ReviewAtlasSymbolHotspot[];
}

export interface ReviewAtlasSymbolHotspot {
  id: string;
  fileNodeId: string;
  filePath: string;
  name: string;
  kind: AtlasSymbol['kind'];
  line: number;
  column: number;
  endLine: number;
  complexity: number;
  exported: boolean;
  isTest: boolean;
  changedLines: number;
  changeRatio: number;
}

export type ReviewAtlasImpactKind = 'caller' | 'callee' | 'reference';

export interface ReviewAtlasImpactResult {
  id: string;
  kind: ReviewAtlasImpactKind;
  label: string;
  symbol: string;
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface ReviewAtlasImpact {
  overlay: BlockMapOverlay;
  results: Record<ReviewAtlasImpactKind, ReviewAtlasImpactResult[]>;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function overlapLines(start: number, end: number, rangeStart: number, rangeEnd: number): number {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart) + 1);
}

function symbolHotspots(
  diff: ReviewScopeDiff,
  aggregation: ReviewScopeAggregation,
  nodes: readonly AtlasNode[],
): ReviewAtlasSymbolHotspot[] {
  const changeByPath = new Map(
    diff.files
      .filter((file) => file.newPath)
      .map((file) => [normalizePath(file.newPath!), file]),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const hotspots: ReviewAtlasSymbolHotspot[] = [];

  for (const [filePath, fileNodeId] of Object.entries(aggregation.fileNodeIds)) {
    const file = changeByPath.get(filePath);
    const node = nodeById.get(fileNodeId);
    if (!file || !node || node.kind !== 'file') continue;
    for (const symbol of node.symbols) {
      const symbolStart = Math.max(1, symbol.line);
      const symbolEnd = Math.max(symbolStart, symbol.endLine);
      const changedLines = file.newChangedRanges.reduce(
        (total, range) => total + overlapLines(
          symbolStart,
          symbolEnd,
          range.startLine,
          range.endLine,
        ),
        0,
      );
      if (changedLines === 0) continue;
      hotspots.push({
        id: symbol.id,
        fileNodeId,
        filePath: node.path,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        column: symbol.column,
        endLine: symbol.endLine,
        complexity: symbol.complexity,
        exported: symbol.exported,
        isTest: symbol.isTest,
        changedLines,
        changeRatio: changedLines / Math.max(1, symbolEnd - symbolStart + 1),
      });
    }
  }

  return hotspots.sort((left, right) =>
    right.changedLines - left.changedLines
    || right.changeRatio - left.changeRatio
    || right.complexity - left.complexity
    || left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.name.localeCompare(right.name));
}

export function buildReviewAtlasScope(
  rawPatch: string,
  nodes: readonly AtlasNode[],
): ReviewAtlasScope {
  const diff = parseReviewScopeDiff(rawPatch);
  const aggregation = aggregateReviewScope(diff, nodes);
  const overlayNodes = new Map(
    Object.entries(aggregation.nodeMetrics).map(([id, metrics]) => [
      id,
      {
        changes: {
          additions: metrics.additions,
          deletions: metrics.deletions,
          changedLines: metrics.changedLines,
          changedFiles: metrics.changedFiles,
        },
        directChange: metrics.directChangedFiles > 0,
      },
    ]),
  );

  return {
    diff,
    aggregation,
    overlay: {
      nodes: overlayNodes,
      dimUnspecified: true,
      showMetrics: true,
    },
    changedFileNodeIds: new Set(Object.values(aggregation.fileNodeIds)),
    hotspots: symbolHotspots(diff, aggregation, nodes),
  };
}

export function reviewAtlasDiffTarget(
  mode: 'scope' | 'codebase',
  activation: BlockMapActivation,
  changedFileNodeIds: ReadonlySet<string>,
): string | null {
  if (
    mode !== 'scope'
    || activation.node.kind !== 'file'
    || !changedFileNodeIds.has(activation.node.id)
  ) {
    return null;
  }
  return activation.node.path;
}

function exactResult(
  kind: ReviewAtlasImpactKind,
  label: string,
  symbol: string,
  location: {
    filePath: string;
    line: number;
    column: number;
    snippet: string;
  },
): ReviewAtlasImpactResult {
  return {
    id: `${kind}:${normalizePath(location.filePath)}:${location.line}:${location.column}:${label}`,
    kind,
    label,
    symbol,
    filePath: normalizePath(location.filePath),
    line: location.line,
    column: location.column,
    snippet: location.snippet,
  };
}

function uniqueResults(results: ReviewAtlasImpactResult[]): ReviewAtlasImpactResult[] {
  const unique = new Map<string, ReviewAtlasImpactResult>();
  for (const result of results) {
    const key = `${result.kind}:${result.filePath}:${result.line}:${result.column}`;
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()].sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.line - right.line
    || left.column - right.column
    || left.label.localeCompare(right.label));
}

const RELATIONSHIP_PRIORITY: Record<BlockMapImpactRelationship, number> = {
  reference: 1,
  impacted: 2,
  callee: 3,
  caller: 4,
  direct: 5,
};

function mergeRelationship(
  current: BlockMapNodeOverlay | undefined,
  relationship: BlockMapImpactRelationship,
): BlockMapNodeOverlay {
  const currentRelationship = current?.relationship;
  return {
    ...current,
    relationship: !currentRelationship
      || RELATIONSHIP_PRIORITY[relationship] > RELATIONSHIP_PRIORITY[currentRelationship]
      ? relationship
      : currentRelationship,
  };
}

export function buildReviewAtlasImpact(
  scope: ReviewAtlasScope,
  hotspot: ReviewAtlasSymbolHotspot,
  nodes: readonly AtlasNode[],
  references?: ReferenceResponse,
  calls?: CallHierarchyResponse,
): ReviewAtlasImpact {
  const callers = uniqueResults((calls?.callers ?? []).flatMap((target) => {
    const locations = target.callSites.length > 0 ? target.callSites : [target.declaration];
    return locations.map((location) =>
      exactResult('caller', target.name, hotspot.name, location));
  }));
  const callees = uniqueResults((calls?.callees ?? []).map((target) =>
    exactResult('callee', target.name, target.name, target.declaration)));
  const referenceResults = uniqueResults((references?.references ?? []).map((location) =>
    exactResult('reference', hotspot.name, hotspot.name, location)));
  const results: ReviewAtlasImpact['results'] = {
    caller: callers,
    callee: callees,
    reference: referenceResults,
  };

  const fileIdByPath = new Map(
    nodes
      .filter((node) => node.kind === 'file')
      .map((node) => [normalizePath(node.path), node.id]),
  );
  const overlayNodes = new Map(scope.overlay.nodes);
  overlayNodes.set(
    hotspot.fileNodeId,
    mergeRelationship(overlayNodes.get(hotspot.fileNodeId), 'direct'),
  );
  for (const kind of ['caller', 'callee', 'reference'] as const) {
    for (const result of results[kind]) {
      const fileId = fileIdByPath.get(result.filePath);
      if (!fileId) continue;
      overlayNodes.set(
        fileId,
        mergeRelationship(overlayNodes.get(fileId), kind),
      );
    }
  }

  return {
    overlay: {
      ...scope.overlay,
      nodes: overlayNodes,
    },
    results,
  };
}
