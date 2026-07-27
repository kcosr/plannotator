import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { filteredLines, nodeMatchesFilter } from './codeFilter';
import type { AtlasNode, CodeFilter } from './types';

interface DirectoryTreeProps {
  nodes: AtlasNode[];
  codeFilter: CodeFilter;
  selectedId: string | null;
  focusedRootId: string;
  onSelect: (node: AtlasNode) => void;
  onFocus: (node: AtlasNode) => void;
}

export function DirectoryTree({
  nodes,
  codeFilter,
  selectedId,
  focusedRootId,
  onSelect,
  onFocus,
}: DirectoryTreeProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => node.parentId == null) ?? nodes[0];
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const visibleNodes = useMemo(() => {
    const result: AtlasNode[] = [];
    if (!root) return result;
    const visit = (node: AtlasNode) => {
      result.push(node);
      if (node.kind === 'file' || collapsed.has(node.id)) return;
      node.childIds
        .map((id) => byId.get(id))
        .filter((entry): entry is AtlasNode => entry != null && nodeMatchesFilter(entry, codeFilter))
        .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name))
        .forEach(visit);
    };
    visit(root);
    return result;
  }, [byId, codeFilter, collapsed, root]);

  useEffect(() => {
    if (!root) return;
    if (focusedId && visibleNodes.some((node) => node.id === focusedId)) return;
    setFocusedId(selectedId && visibleNodes.some((node) => node.id === selectedId)
      ? selectedId
      : root.id);
  }, [focusedId, root, selectedId, visibleNodes]);

  if (!root) return null;

  const setDirectoryCollapsed = (id: string, value: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const focusNode = (node: AtlasNode | undefined) => {
    if (!node) return;
    setFocusedId(node.id);
    requestAnimationFrame(() => rowRefs.current.get(node.id)?.focus());
  };

  const onTreeKeyDown = (event: React.KeyboardEvent, node: AtlasNode) => {
    const index = visibleNodes.findIndex((entry) => entry.id === node.id);
    if (event.key === 'ArrowDown') focusNode(visibleNodes[index + 1]);
    else if (event.key === 'ArrowUp') focusNode(visibleNodes[index - 1]);
    else if (event.key === 'Home') focusNode(visibleNodes[0]);
    else if (event.key === 'End') focusNode(visibleNodes[visibleNodes.length - 1]);
    else if (event.key === 'ArrowRight' && node.kind !== 'file') {
      if (collapsed.has(node.id)) setDirectoryCollapsed(node.id, false);
      else focusNode(visibleNodes[index + 1]);
    } else if (event.key === 'ArrowLeft') {
      if (node.kind !== 'file' && !collapsed.has(node.id)) {
        setDirectoryCollapsed(node.id, true);
      } else {
        focusNode(node.parentId ? byId.get(node.parentId) : undefined);
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      onSelect(node);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const renderNode = (node: AtlasNode, depth: number): React.ReactNode => {
    const children = node.childIds
      .map((id) => byId.get(id))
      .filter((entry): entry is AtlasNode => entry != null && nodeMatchesFilter(entry, codeFilter))
      .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name));
    const isCollapsed = collapsed.has(node.id);
    const isDirectory = node.kind !== 'file';
    const isFocus = node.id === focusedRootId;
    return (
      <div key={node.id}>
        <div
          ref={(element) => {
            if (element) rowRefs.current.set(node.id, element);
            else rowRefs.current.delete(node.id);
          }}
          className={`atlas-tree-row${selectedId === node.id ? ' is-selected' : ''}${isFocus ? ' is-focus' : ''}`}
          style={{ paddingLeft: 8 + Math.min(depth, 8) * 14 }}
          onClick={() => {
            setFocusedId(node.id);
            onSelect(node);
          }}
          onDoubleClick={() => isDirectory && onFocus(node)}
          onFocus={() => setFocusedId(node.id)}
          onKeyDown={(event) => onTreeKeyDown(event, node)}
          role="treeitem"
          tabIndex={focusedId === node.id ? 0 : -1}
          aria-level={depth + 1}
          aria-expanded={isDirectory ? !isCollapsed : undefined}
          aria-selected={selectedId === node.id}
        >
          {isDirectory ? (
            <button
              type="button"
              className="atlas-tree-disclosure"
              onClick={(event) => {
                event.stopPropagation();
                setDirectoryCollapsed(node.id, !isCollapsed);
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
          {node.kind === 'file' && <span className="atlas-tree-lines">{filteredLines(node, codeFilter)}</span>}
        </div>
        {isDirectory && !isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return <div className="atlas-tree" role="tree">{renderNode(root, 0)}</div>;
}
