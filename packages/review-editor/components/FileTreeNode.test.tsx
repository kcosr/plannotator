import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileTreeNode } from '../utils/buildFileTree';
import { FileTreeNodeItem } from './FileTreeNode';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('FileTreeNodeItem folder navigation', () => {
  test.skipIf(!hasDom)('toggles the folder and reports it as a map focus target', async () => {
    const node: FileTreeNode = {
      type: 'folder',
      name: 'atlas',
      path: 'packages/atlas',
      depth: 0,
      additions: 8,
      deletions: 2,
      children: [],
    };
    const toggled: string[] = [];
    const selected: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);

    await act(async () => {
      root = createRoot(host!);
      root.render(
        <FileTreeNodeItem
          node={node}
          expandedFolders={new Set([node.path])}
          onToggleFolder={(path) => toggled.push(path)}
          onSelectFolder={(path) => selected.push(path)}
          activeFileIndex={-1}
          onSelectFile={() => {}}
          viewedFiles={new Set()}
          hideViewedFiles={false}
          getAnnotationCount={() => 0}
          stagedFiles={new Set()}
        />,
      );
    });

    const folder = host.querySelector<HTMLButtonElement>('button');
    expect(folder).not.toBeNull();
    await act(async () => folder?.click());

    expect(toggled).toEqual(['packages/atlas']);
    expect(selected).toEqual(['packages/atlas']);
  });
});
