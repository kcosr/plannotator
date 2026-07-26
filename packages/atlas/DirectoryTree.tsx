import { useMemo, useState } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import type { AtlasNode } from './types';

interface DirectoryTreeProps {
  nodes: AtlasNode[];
  selectedId: string | null;
  focusedRootId: string;
  onSelect: (node: AtlasNode) => void;
  onFocus: (node: AtlasNode) => void;
}

export function DirectoryTree({ nodes, selectedId, focusedRootId, onSelect, onFocus }: DirectoryTreeProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (!root) return null;

  const renderNode = (node: AtlasNode, depth: number): React.ReactNode => {
    const children = node.childIds
      .map((id) => byId.get(id))
      .filter((entry): entry is AtlasNode => Boolean(entry))
      .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(node.id);
    const isDirectory = node.kind !== 'file';
    const isFocus = node.id === focusedRootId;
    return (
      <div key={node.id}>
        <div
          className={`atlas-tree-row${selectedId === node.id ? ' is-selected' : ''}${isFocus ? ' is-focus' : ''}`}
          style={{ paddingLeft: 8 + Math.min(depth, 8) * 14 }}
          onClick={() => onSelect(node)}
          onDoubleClick={() => isDirectory && onFocus(node)}
          role="treeitem"
          aria-selected={selectedId === node.id}
        >
          {isDirectory ? (
            <button
              type="button"
              className="atlas-tree-disclosure"
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                });
              }}
              aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
            >
              <ChevronRight size={13} className={isCollapsed ? '' : 'is-open'} />
            </button>
          ) : <span className="atlas-tree-spacer" />}
          {node.kind === 'file'
            ? <FileCode2 size={14} />
            : isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
          <span className="atlas-tree-name">{node.name}</span>
          {node.kind === 'file' && <span className="atlas-tree-lines">{node.lines}</span>}
        </div>
        {isDirectory && !isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return <div className="atlas-tree" role="tree">{renderNode(root, 0)}</div>;
}
