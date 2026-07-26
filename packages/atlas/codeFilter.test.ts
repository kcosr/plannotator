import { describe, expect, test } from 'bun:test';
import {
  filteredBytes,
  filteredComplexity,
  filteredLines,
  filteredMetric,
  lineMatchesFilter,
  nodeMatchesFilter,
  symbolMatchesFilter,
} from './codeFilter';
import type { AtlasNode, AtlasSymbol } from './types';

const symbol: AtlasSymbol = {
  id: 'symbol:run',
  fileId: 'file:src/lib.rs',
  name: 'run',
  kind: 'function',
  line: 3,
  column: 1,
  endLine: 8,
  complexity: 2,
  exported: true,
  isTest: false,
};

const node: AtlasNode = {
  id: 'file:src/lib.rs',
  path: 'src/lib.rs',
  name: 'lib.rs',
  kind: 'file',
  parentId: 'directory:src',
  childIds: [],
  depth: 2,
  language: 'Rust',
  extension: '.rs',
  bytes: 1_000,
  lines: 100,
  complexity: 20,
  testBytes: 400,
  testLines: 40,
  testComplexity: 7,
  testRanges: [{
    startLine: 61,
    endLine: 100,
    reason: 'rust-cfg-test',
    confidence: 'semantic',
  }],
  symbols: [symbol],
};

describe('Atlas code filtering', () => {
  test('computes matching metrics for mixed files', () => {
    expect(filteredLines(node, 'all')).toBe(100);
    expect(filteredLines(node, 'no-tests')).toBe(60);
    expect(filteredLines(node, 'tests')).toBe(40);
    expect(filteredBytes(node, 'no-tests')).toBe(600);
    expect(filteredComplexity(node, 'tests')).toBe(7);
    expect(filteredMetric(node, 'tests', 'bytes')).toBe(400);
  });

  test('filters symbols and exact source ranges', () => {
    expect(symbolMatchesFilter(symbol, 'no-tests')).toBe(true);
    expect(symbolMatchesFilter({ ...symbol, isTest: true }, 'no-tests')).toBe(false);
    expect(lineMatchesFilter(node, 60, 'tests')).toBe(false);
    expect(lineMatchesFilter(node, 61, 'tests')).toBe(true);
    expect(lineMatchesFilter(node, 100, 'no-tests')).toBe(false);
  });

  test('removes nodes without matching lines', () => {
    expect(nodeMatchesFilter(node, 'tests')).toBe(true);
    expect(nodeMatchesFilter({ ...node, testLines: 0 }, 'tests')).toBe(false);
  });
});
