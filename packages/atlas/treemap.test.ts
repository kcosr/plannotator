import { describe, expect, test } from 'bun:test';
import { squarify } from './treemap';

describe('squarify', () => {
  test('fills the available area without overlap or overflow', () => {
    const rectangles = squarify(
      [
        { id: 'a', item: 'a', value: 50 },
        { id: 'b', item: 'b', value: 30 },
        { id: 'c', item: 'c', value: 20 },
      ],
      100,
      80,
    );

    expect(rectangles).toHaveLength(3);
    expect(rectangles.reduce((area, rect) => area + rect.width * rect.height, 0)).toBeCloseTo(8_000, 5);
    for (const rect of rectangles) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(100.000001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(80.000001);
    }
  });

  test('uses ids to keep equal-value ordering deterministic', () => {
    const entries = [
      { id: 'z', item: 'z', value: 1 },
      { id: 'a', item: 'a', value: 1 },
      { id: 'm', item: 'm', value: 1 },
    ];
    expect(squarify(entries, 90, 60).map((rect) => rect.id)).toEqual(['a', 'm', 'z']);
  });
});
