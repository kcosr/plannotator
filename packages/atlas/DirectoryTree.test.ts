import { describe, expect, test } from 'bun:test';
import { preservedDirectoryTreeFocus } from './DirectoryTree';
import type { AtlasNode } from './types';

function node(
  id: string,
  parentId: string | null,
  kind: AtlasNode['kind'],
): AtlasNode {
  return {
    id,
    path: id === 'root' ? '' : id,
    name: id,
    kind,
    parentId,
    childIds: [],
    depth: 0,
    language: null,
    extension: null,
    bytes: 1,
    lines: 1,
    complexity: 0,
    testBytes: 0,
    testLines: 0,
    testComplexity: 0,
    testRanges: [],
    symbols: [],
  };
}

const nodes = [
  node('root', null, 'root'),
  node('src', 'root', 'directory'),
  node('feature', 'src', 'directory'),
  node('file', 'feature', 'file'),
];

describe('preservedDirectoryTreeFocus', () => {
  test('moves focus to the nearest visible ancestor after collapse', () => {
    expect(preservedDirectoryTreeFocus(
      nodes,
      new Set(['root', 'src']),
      'file',
      'file',
      'root',
    )).toBe('src');
  });

  test('retains the current item while it remains visible', () => {
    expect(preservedDirectoryTreeFocus(
      nodes,
      new Set(nodes.map((entry) => entry.id)),
      'feature',
      'file',
      'root',
    )).toBe('feature');
  });
});
