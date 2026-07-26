import type { TokenEventBase } from '@pierre/diffs';

export interface ReferencePosition {
  symbol: string;
  line: number;
  column: number;
}

const NON_SYMBOL_IDENTIFIERS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'crate', 'default', 'defer', 'do', 'dyn', 'else', 'enum', 'export', 'extends',
  'extern', 'false', 'final', 'finally', 'fn', 'for', 'from', 'func', 'function',
  'go', 'goto', 'if', 'implements', 'import', 'in', 'interface', 'is', 'let',
  'loop', 'match', 'mod', 'module', 'move', 'mut', 'namespace', 'new', 'nil',
  'null', 'package', 'pass', 'private', 'protected', 'pub', 'public', 'raise',
  'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'switch', 'this',
  'throw', 'trait', 'true', 'try', 'type', 'typedef', 'typeof', 'union', 'unsafe',
  'use', 'using', 'var', 'virtual', 'void', 'volatile', 'where', 'while', 'with',
  'yield',
]);

export function isInspectableSymbol(text: string | null): boolean {
  const candidate = text?.trim() ?? '';
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(candidate)
    && !NON_SYMBOL_IDENTIFIERS.has(candidate);
}

export function referencePositionFromToken(token: TokenEventBase): ReferencePosition | null {
  const leadingOffset = token.tokenText.match(/^[^\p{L}\p{N}_$]+/u)?.[0].length ?? 0;
  const symbol = token.tokenText.replace(
    /^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu,
    '',
  );
  if (!isInspectableSymbol(symbol)) return null;
  return {
    symbol,
    line: token.lineNumber,
    column: token.lineCharStart + leadingOffset + 1,
  };
}
