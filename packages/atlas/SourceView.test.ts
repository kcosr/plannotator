import { describe, expect, test } from 'bun:test';
import { scheduleScrollRetry } from './SourceView';

describe('scheduleScrollRetry', () => {
  test('keeps trying until the deep-linked line is rendered', () => {
    const queued: Array<() => void> = [];
    let attempts = 0;
    const cancel = scheduleScrollRetry(
      () => ++attempts === 3,
      (callback) => {
        queued.push(callback);
        return queued.length as ReturnType<typeof setTimeout>;
      },
      () => {},
      [0, 10, 20],
    );

    expect(attempts).toBe(1);
    queued.shift()?.();
    queued.shift()?.();
    expect(attempts).toBe(3);
    expect(queued).toHaveLength(0);
    cancel();
  });

  test('cancels a pending retry on navigation cleanup', () => {
    let scheduled: (() => void) | undefined;
    let cancelled = false;
    let attempts = 0;
    const cancel = scheduleScrollRetry(
      () => {
        attempts += 1;
        return false;
      },
      (callback) => {
        scheduled = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      () => {
        cancelled = true;
      },
      [10],
    );

    cancel();
    scheduled?.();
    expect(cancelled).toBe(true);
    expect(attempts).toBe(1);
  });
});
