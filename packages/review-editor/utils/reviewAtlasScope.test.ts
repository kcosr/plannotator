import { describe, expect, test } from 'bun:test';
import type {
  AtlasNode,
  AtlasSymbol,
  BlockMapActivation,
  CallHierarchyResponse,
  ReferenceResponse,
} from '@plannotator/atlas';
import {
  buildReviewAtlasImpact,
  buildReviewAtlasScope,
  reviewAtlasDiffTarget,
} from './reviewAtlasScope';

function node(
  id: string,
  path: string,
  kind: AtlasNode['kind'],
  parentId: string | null,
  lines: number,
  symbols: AtlasSymbol[] = [],
): AtlasNode {
  return {
    id,
    path,
    name: path.split('/').pop() || 'repo',
    kind,
    parentId,
    childIds: [],
    depth: path ? path.split('/').length : 0,
    language: kind === 'file' ? 'typescript' : null,
    extension: kind === 'file' ? '.ts' : null,
    bytes: lines * 10,
    lines,
    complexity: 1,
    testBytes: 0,
    testLines: 0,
    testComplexity: 0,
    testRanges: [],
    symbols,
  };
}

const changedSymbols: AtlasSymbol[] = [
  {
    id: 'symbol:app:render',
    fileId: 'app',
    name: 'render',
    kind: 'function',
    line: 1,
    column: 1,
    endLine: 8,
    complexity: 5,
    exported: true,
    isTest: false,
  },
  {
    id: 'symbol:app:test',
    fileId: 'app',
    name: 'renders output',
    kind: 'function',
    line: 3,
    column: 3,
    endLine: 3,
    complexity: 1,
    exported: false,
    isTest: true,
  },
];

const nodes = [
  node('root', '', 'root', null, 200),
  node('src', 'src', 'directory', 'root', 140),
  node('app', 'src/app.ts', 'file', 'src', 100, changedSymbols),
  node('other', 'src/other.ts', 'file', 'src', 40),
  node('reference', 'src/reference.ts', 'file', 'src', 20),
];

describe('buildReviewAtlasScope', () => {
  test('projects changed lines through file and ancestor blocks', () => {
    const scope = buildReviewAtlasScope(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,3 @@',
        ' old',
        '-removed',
        '+added',
        '+another',
      ].join('\n'),
      nodes,
    );

    expect(scope.changedFileNodeIds.has('app')).toBe(true);
    expect(scope.overlay.nodes.get('app')).toMatchObject({
      directChange: true,
      changes: { additions: 2, deletions: 1, changedLines: 3, changedFiles: 1 },
    });
    expect(scope.overlay.nodes.get('src')).toMatchObject({
      directChange: false,
      changes: { changedLines: 3, changedFiles: 1 },
    });
    expect(scope.overlay.nodes.has('other')).toBe(false);
    expect(scope.overlay.sizeByChanges).toBe(true);
    expect(scope.hotspots).toEqual([
      expect.objectContaining({
        id: 'symbol:app:render',
        changedLines: 2,
        exported: true,
        isTest: false,
      }),
      expect.objectContaining({
        id: 'symbol:app:test',
        changedLines: 1,
        exported: false,
        isTest: true,
      }),
    ]);
  });

  test('does not claim a symbol hotspot for deletion-only hunks', () => {
    const scope = buildReviewAtlasScope(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -2,2 +2,0 @@',
        '-removed',
        '-also removed',
      ].join('\n'),
      nodes,
    );

    expect(scope.hotspots).toEqual([]);
    expect(scope.overlay.nodes.get('app')).toMatchObject({
      directChange: true,
      changes: { additions: 0, deletions: 2 },
    });
  });
});

describe('reviewAtlasDiffTarget', () => {
  const activation = (target: AtlasNode): BlockMapActivation => ({
    kind: 'select',
    node: target,
  });

  test('opens only changed files from Scope', () => {
    const changed = new Set(['app']);
    expect(reviewAtlasDiffTarget('scope', activation(nodes[2]!), changed)).toBe('src/app.ts');
    expect(reviewAtlasDiffTarget('scope', activation(nodes[3]!), changed)).toBeNull();
    expect(reviewAtlasDiffTarget('codebase', activation(nodes[2]!), changed)).toBeNull();
  });
});

describe('buildReviewAtlasImpact', () => {
  test('keeps change heat while projecting exact semantic relationships', () => {
    const scope = buildReviewAtlasScope(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,2 +1,3 @@',
        ' old',
        '-removed',
        '+added',
        '+another',
      ].join('\n'),
      nodes,
    );
    const references: ReferenceResponse = {
      definitions: [],
      references: [
        {
          kind: 'reference',
          fileId: 'reference',
          filePath: 'src/reference.ts',
          line: 7,
          column: 4,
          snippet: 'render(value)',
        },
      ],
      provider: { kind: 'lsp', name: 'typescript-language-server', status: 'ready' },
    };
    const calls: CallHierarchyResponse = {
      root: null,
      callers: [{
        name: 'main',
        kind: 12,
        declaration: {
          fileId: 'other',
          filePath: 'src/other.ts',
          line: 1,
          column: 1,
          snippet: 'function main()',
        },
        callSites: [{
          fileId: 'other',
          filePath: 'src/other.ts',
          line: 3,
          column: 5,
          snippet: 'render()',
        }],
      }],
      callees: [{
        name: 'format',
        kind: 12,
        declaration: {
          fileId: 'other',
          filePath: 'src/other.ts',
          line: 20,
          column: 1,
          snippet: 'function format()',
        },
        callSites: [],
      }],
      truncated: false,
      provider: { kind: 'lsp', name: 'typescript-language-server', status: 'ready' },
    };

    const impact = buildReviewAtlasImpact(
      scope,
      scope.hotspots[0]!,
      nodes,
      references,
      calls,
    );

    expect(impact.overlay.nodes.get('app')).toMatchObject({
      directChange: true,
      relationship: 'direct',
      changes: { additions: 2, deletions: 1 },
    });
    expect(impact.overlay.nodes.get('other')?.relationship).toBe('caller');
    expect(impact.overlay.nodes.get('reference')?.relationship).toBe('reference');
    expect(impact.results.caller[0]).toMatchObject({
      filePath: 'src/other.ts',
      line: 3,
      column: 5,
      label: 'main',
      symbol: 'render',
    });
    expect(impact.results.callee[0]).toMatchObject({
      filePath: 'src/other.ts',
      line: 20,
      label: 'format',
      symbol: 'format',
    });
  });
});
