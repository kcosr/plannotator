import { describe, expect, test } from 'bun:test';
import { aggregateCallTargets, filterCallTargets } from './callHierarchy';
import type { AtlasNode, CallHierarchyLocation, CallHierarchyTarget } from './types';

function location(filePath: string, line: number, column = 3): CallHierarchyLocation {
  return {
    fileId: `file:${filePath}`,
    filePath,
    line,
    column,
    snippet: `call at ${line}`,
  };
}

function target(name: string, callSites: CallHierarchyLocation[]): CallHierarchyTarget {
  return {
    name,
    kind: 12,
    declaration: location('src/functions.ts', 2),
    callSites,
  };
}

function fileNode(path: string): AtlasNode {
  return {
    id: `file:${path}`,
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'file',
    parentId: 'root',
    childIds: [],
    depth: 1,
    language: 'TypeScript',
    extension: '.ts',
    bytes: 400,
    lines: 40,
    complexity: 2,
    testBytes: 100,
    testLines: 10,
    testComplexity: 1,
    testRanges: [{
      startLine: 20,
      endLine: 29,
      reason: 'rust-test-attribute',
      confidence: 'semantic',
    }],
    symbols: [],
  };
}

describe('aggregateCallTargets', () => {
  test('groups duplicate counterpart functions and deduplicates their call sites', () => {
    const firstSite = location('src/caller.ts', 8);
    const secondSite = location('src/caller.ts', 12);

    const result = aggregateCallTargets([
      target('render', [firstSite]),
      target('render', [firstSite, secondSite]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.callSites).toEqual([firstSite, secondSite]);
  });
});

describe('filterCallTargets', () => {
  test('keeps only call sites matching the active test filter', () => {
    const node = fileNode('src/caller.ts');
    const nodes = new Map([[node.path, node]]);
    const calls = [target('render', [
      location(node.path, 8),
      location(node.path, 24),
    ])];

    expect(filterCallTargets(calls, nodes, 'tests')[0]?.callSites.map((site) => site.line)).toEqual([24]);
    expect(filterCallTargets(calls, nodes, 'no-tests')[0]?.callSites.map((site) => site.line)).toEqual([8]);
  });

  test('removes counterparts with no visible call sites', () => {
    const node = fileNode('src/caller.ts');
    const nodes = new Map([[node.path, node]]);

    expect(filterCallTargets([target('render', [location(node.path, 8)])], nodes, 'tests')).toEqual([]);
  });
});
