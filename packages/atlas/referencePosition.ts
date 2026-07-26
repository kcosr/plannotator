import type { TokenEventBase } from '@pierre/diffs';

export interface ReferencePosition {
  symbol: string;
  line: number;
  column: number;
}

export function referencePositionFromToken(token: TokenEventBase): ReferencePosition | null {
  const leadingOffset = token.tokenText.match(/^[^\w$]+/)?.[0].length ?? 0;
  const symbol = token.tokenText.replace(/^[^\w$]+|[^\w$]+$/g, '');
  if (!symbol) return null;
  return {
    symbol,
    line: token.lineNumber,
    column: token.lineCharStart + leadingOffset + 1,
  };
}
