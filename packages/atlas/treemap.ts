export interface WeightedItem<T> {
  item: T;
  id: string;
  value: number;
}

export interface TreemapRect<T> extends WeightedItem<T> {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MutableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function worstRatio<T>(row: WeightedItem<T>[], side: number): number {
  if (row.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const sum = row.reduce((total, entry) => total + entry.value, 0);
  const max = Math.max(...row.map((entry) => entry.value));
  const min = Math.min(...row.map((entry) => entry.value));
  const sideSquared = side * side;
  return Math.max((sideSquared * max) / (sum * sum), (sum * sum) / (sideSquared * min));
}

function placeRow<T>(
  row: WeightedItem<T>[],
  remaining: MutableRect,
  scale: number,
  output: TreemapRect<T>[],
): void {
  const area = row.reduce((total, entry) => total + entry.value * scale, 0);
  if (remaining.width >= remaining.height) {
    const rowWidth = remaining.height > 0 ? area / remaining.height : 0;
    let y = remaining.y;
    for (const entry of row) {
      const height = rowWidth > 0 ? entry.value * scale / rowWidth : 0;
      output.push({ ...entry, x: remaining.x, y, width: rowWidth, height });
      y += height;
    }
    remaining.x += rowWidth;
    remaining.width = Math.max(0, remaining.width - rowWidth);
  } else {
    const rowHeight = remaining.width > 0 ? area / remaining.width : 0;
    let x = remaining.x;
    for (const entry of row) {
      const width = rowHeight > 0 ? entry.value * scale / rowHeight : 0;
      output.push({ ...entry, x, y: remaining.y, width, height: rowHeight });
      x += width;
    }
    remaining.y += rowHeight;
    remaining.height = Math.max(0, remaining.height - rowHeight);
  }
}

/**
 * Deterministic squarified treemap. Equal values use stable ids, so refreshing
 * metrics does not arbitrarily shuffle peer blocks.
 */
export function squarify<T>(
  input: WeightedItem<T>[],
  width: number,
  height: number,
): TreemapRect<T>[] {
  if (width <= 0 || height <= 0 || input.length === 0) return [];
  const output: TreemapRect<T>[] = [];
  const entries = input
    .map((entry) => ({ ...entry, value: Math.max(0.0001, entry.value) }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const scale = width * height / total;
  const remaining: MutableRect = { x: 0, y: 0, width, height };
  const queue = [...entries];
  let row: WeightedItem<T>[] = [];

  while (queue.length > 0) {
    const next = queue[0];
    const side = Math.min(remaining.width, remaining.height) / Math.sqrt(scale);
    if (row.length === 0 || worstRatio([...row, next], side) <= worstRatio(row, side)) {
      row.push(next);
      queue.shift();
    } else {
      placeRow(row, remaining, scale, output);
      row = [];
    }
  }
  if (row.length > 0) placeRow(row, remaining, scale, output);
  return output;
}
