import { Box, Braces, CircleDot, FunctionSquare, Variable } from 'lucide-react';
import { squarify } from './treemap';
import type { AtlasNode, AtlasSymbol } from './types';
import { useElementSize } from './useElementSize';

const KIND_COLORS: Record<AtlasSymbol['kind'], string> = {
  class: '#3b82f6',
  interface: '#06b6d4',
  type: '#8b5cf6',
  enum: '#ec4899',
  struct: '#2563eb',
  trait: '#0891b2',
  function: '#22c55e',
  method: '#14b8a6',
  variable: '#eab308',
  module: '#f97316',
  other: '#64748b',
};

function SymbolIcon({ kind }: { kind: AtlasSymbol['kind'] }) {
  if (kind === 'function' || kind === 'method') return <FunctionSquare size={13} />;
  if (kind === 'variable') return <Variable size={13} />;
  if (kind === 'class' || kind === 'interface') return <Box size={13} />;
  if (kind === 'type' || kind === 'enum') return <Braces size={13} />;
  return <CircleDot size={13} />;
}

export function SymbolMap({ file, onOpen }: { file: AtlasNode; onOpen: (symbol: AtlasSymbol) => void }) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const rects = squarify(
    file.symbols.map((symbol) => ({
      item: symbol,
      id: symbol.id,
      value: Math.max(1, symbol.endLine - symbol.line + 1) * (1 + Math.log2(Math.max(1, symbol.complexity))),
    })),
    width,
    height,
  );
  return (
    <div ref={ref} className="atlas-symbol-map">
      {rects.map(({ item: symbol, x, y, width: blockWidth, height: blockHeight }) => {
        const compact = blockWidth < 120 || blockHeight < 68;
        return (
          <button
            type="button"
            key={symbol.id}
            className="atlas-symbol-block"
            style={{
              left: x + 2,
              top: y + 2,
              width: Math.max(0, blockWidth - 4),
              height: Math.max(0, blockHeight - 4),
              '--symbol-color': KIND_COLORS[symbol.kind],
            } as React.CSSProperties}
            onClick={() => onOpen(symbol)}
            title={`${symbol.kind} ${symbol.name}, lines ${symbol.line}-${symbol.endLine}, complexity ${symbol.complexity}`}
          >
            <span className="atlas-symbol-title"><SymbolIcon kind={symbol.kind} />{symbol.name}</span>
            {!compact && (
              <span className="atlas-symbol-meta">
                <span>{symbol.kind}{symbol.exported ? ' · exported' : ''}</span>
                <span>{symbol.line}-{symbol.endLine} · cx {symbol.complexity}</span>
              </span>
            )}
          </button>
        );
      })}
      {file.symbols.length === 0 && (
        <div className="atlas-empty">
          <Braces size={28} />
          <strong>No indexed symbols</strong>
          <span>This file can still be inspected in Source.</span>
        </div>
      )}
    </div>
  );
}
