import { describe, expect, test } from 'bun:test';
import {
  blockMapChangeColor,
  blockMapChangedLines,
  blockMapKeyboardActivation,
  blockMapOverlayMaximum,
  blockMapQueryMatches,
  resolveBlockMapNodeOverlay,
  type BlockMapOverlay,
} from './BlockMap';
import type { AtlasNode } from './types';

describe('BlockMap overlays', () => {
  test('keeps the standalone path empty when no overlay is provided', () => {
    expect(blockMapOverlayMaximum(undefined)).toBe(0);
    expect(resolveBlockMapNodeOverlay(undefined, 'file:src/main.ts')).toBeUndefined();
  });

  test('derives stable square-root heat from changed lines', () => {
    const overlay: BlockMapOverlay = {
      nodes: new Map([
        ['file:src/main.ts', {
          changes: { additions: 36, deletions: 28, changedLines: 64 },
          directChange: true,
        }],
        ['file:src/helper.ts', {
          changes: { additions: 12, deletions: 4, changedLines: 16 },
          relationship: 'caller',
        }],
      ]),
    };

    expect(blockMapOverlayMaximum(overlay)).toBe(64);
    expect(resolveBlockMapNodeOverlay(overlay, 'file:src/main.ts')).toMatchObject({
      changedLines: 64,
      intensity: 1,
      directChange: true,
    });
    expect(resolveBlockMapNodeOverlay(overlay, 'file:src/helper.ts')).toMatchObject({
      changedLines: 16,
      intensity: 0.5,
      relationship: 'caller',
    });
  });

  test('honors clamped explicit intensity and additions/deletions fallback', () => {
    const overlay: BlockMapOverlay = {
      nodes: new Map([
        ['file:added.ts', {
          changes: { additions: 7, deletions: 3 },
          intensity: 4,
          relationship: 'direct',
        }],
        ['file:reference.ts', {
          changes: { additions: 0, deletions: 0 },
          intensity: -2,
          relationship: 'reference',
        }],
      ]),
    };

    expect(blockMapChangedLines(overlay.nodes.get('file:added.ts')?.changes)).toBe(10);
    expect(resolveBlockMapNodeOverlay(overlay, 'file:added.ts')?.intensity).toBe(1);
    expect(resolveBlockMapNodeOverlay(overlay, 'file:reference.ts')?.intensity).toBe(0);
  });

  test('normalizes invalid metrics instead of leaking NaN into styles', () => {
    expect(blockMapChangedLines({
      additions: Number.NaN,
      deletions: -5,
      changedLines: Number.POSITIVE_INFINITY,
    })).toBe(0);
  });

  test('uses net change direction for the heat color', () => {
    expect(blockMapChangeColor({ additions: 8, deletions: 3 })).toBe('#22c55e');
    expect(blockMapChangeColor({ additions: 2, deletions: 7 })).toBe('#ef4444');
    expect(blockMapChangeColor({ additions: 5, deletions: 5 })).toBe('#eab308');
  });

  test('keeps ancestors visible when a deep descendant matches search', () => {
    const node = (
      id: string,
      path: string,
      parentId: string | null,
      childIds: string[],
      kind: AtlasNode['kind'],
    ): AtlasNode => ({
      id,
      path,
      name: path.split('/').at(-1) || 'root',
      parentId,
      childIds,
      kind,
      depth: path ? path.split('/').length : 0,
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
    });
    const nodes = [
      node('root', '', null, ['src'], 'root'),
      node('src', 'src', 'root', ['feature'], 'directory'),
      node('feature', 'src/feature', 'src', ['target'], 'directory'),
      node('target', 'src/feature/target.ts', 'feature', [], 'file'),
    ];

    expect([...blockMapQueryMatches(nodes, 'target.ts')]).toEqual([
      'target',
      'feature',
      'src',
      'root',
    ]);
  });

  test('provides a keyboard equivalent for map drill-down', () => {
    expect(blockMapKeyboardActivation('Enter')).toBe('open');
    expect(blockMapKeyboardActivation(' ')).toBeNull();
    expect(blockMapKeyboardActivation('ArrowRight')).toBeNull();
  });
});
