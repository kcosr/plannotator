import type { AtlasNode, AtlasSymbol, CodeFilter, SizeMetric } from './types';

export function filteredLines(node: AtlasNode, filter: CodeFilter): number {
  if (filter === 'tests') return node.testLines;
  if (filter === 'no-tests') return Math.max(0, node.lines - node.testLines);
  return node.lines;
}

export function filteredBytes(node: AtlasNode, filter: CodeFilter): number {
  if (filter === 'tests') return node.testBytes;
  if (filter === 'no-tests') return Math.max(0, node.bytes - node.testBytes);
  return node.bytes;
}

export function filteredComplexity(node: AtlasNode, filter: CodeFilter): number {
  if (filter === 'tests') return node.testComplexity;
  if (filter === 'no-tests') return Math.max(0, node.complexity - node.testComplexity);
  return node.complexity;
}

export function filteredMetric(node: AtlasNode, filter: CodeFilter, metric: SizeMetric): number {
  if (metric === 'bytes') return filteredBytes(node, filter);
  if (metric === 'complexity') return filteredComplexity(node, filter);
  return filteredLines(node, filter);
}

export function nodeMatchesFilter(node: AtlasNode, filter: CodeFilter): boolean {
  return filteredLines(node, filter) > 0;
}

export function symbolMatchesFilter(symbol: AtlasSymbol, filter: CodeFilter): boolean {
  if (filter === 'tests') return symbol.isTest;
  if (filter === 'no-tests') return !symbol.isTest;
  return true;
}

export function lineMatchesFilter(node: AtlasNode, line: number, filter: CodeFilter): boolean {
  if (filter === 'all') return true;
  let low = 0;
  let high = node.testRanges.length - 1;
  let isTest = false;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = node.testRanges[middle];
    if (line < range.startLine) high = middle - 1;
    else if (line > range.endLine) low = middle + 1;
    else {
      isTest = true;
      break;
    }
  }
  return filter === 'tests' ? isTest : !isTest;
}

export function codeFilterLabel(filter: CodeFilter): string {
  if (filter === 'tests') return 'test';
  if (filter === 'no-tests') return 'non-test';
  return 'code';
}
