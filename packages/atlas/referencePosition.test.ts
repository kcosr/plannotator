import { describe, expect, test } from 'bun:test';
import { referencePositionFromToken } from './referencePosition';

describe('referencePositionFromToken', () => {
  test('converts Pierre character offsets to exact one-based positions', () => {
    const position = referencePositionFromToken({
      type: 'token',
      lineNumber: 23,
      lineCharStart: 8,
      lineCharEnd: 14,
      tokenText: 'render',
      tokenElement: {} as HTMLElement,
    });

    expect(position).toEqual({ symbol: 'render', line: 23, column: 9 });
  });

  test('accounts for punctuation removed from a token', () => {
    const position = referencePositionFromToken({
      type: 'token',
      lineNumber: 7,
      lineCharStart: 3,
      lineCharEnd: 10,
      tokenText: '.value,',
      tokenElement: {} as HTMLElement,
    });

    expect(position).toEqual({ symbol: 'value', line: 7, column: 5 });
  });
});
