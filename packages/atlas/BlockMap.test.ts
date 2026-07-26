import { describe, expect, test } from 'bun:test';
import {
  blockMapChangedLines,
  blockMapOverlayMaximum,
  resolveBlockMapNodeOverlay,
  type BlockMapOverlay,
} from './BlockMap';

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
});
