import { describe, it, expect } from 'vitest';
import { maxRetries, exponentialBackoff, fixedDelay } from '../../src/failure-handler.js';

const baseParams = {
  executionTime: new Date(Date.now() - 10000),
  taskData: null,
  error: new Error('fail'),
};

describe('maxRetries', () => {
  it('returns a Date when consecutive failures < max', () => {
    const handler = maxRetries(3);
    const result = handler({ ...baseParams, consecutiveFailures: 2 });
    expect(result).toBeInstanceOf(Date);
  });

  it('returns null when consecutive failures === max', () => {
    const handler = maxRetries(3);
    const result = handler({ ...baseParams, consecutiveFailures: 3 });
    expect(result).toBeNull();
  });

  it('returns null when consecutive failures > max', () => {
    const handler = maxRetries(3);
    const result = handler({ ...baseParams, consecutiveFailures: 5 });
    expect(result).toBeNull();
  });

  it('retries immediately (returned date is close to now)', () => {
    const handler = maxRetries(5);
    const before = Date.now();
    const result = handler({ ...baseParams, consecutiveFailures: 1 });
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result!.getTime()).toBeLessThanOrEqual(after + 5);
  });
});

describe('exponentialBackoff', () => {
  it('applies delay of initialDelay * 2^(failures-1)', () => {
    const handler = exponentialBackoff(1000);
    const executionTime = new Date(Date.now() - 5000);
    const before = Date.now();
    const result = handler({
      executionTime,
      consecutiveFailures: 1,
      taskData: null,
      error: new Error(),
    });
    expect(result).not.toBeNull();
    // delay = 1000 * 2^0 = 1000ms
    expect(result!.getTime()).toBeGreaterThanOrEqual(before + 1000);
    expect(result!.getTime()).toBeLessThanOrEqual(before + 1100);
  });

  it('doubles delay on each consecutive failure', () => {
    const handler = exponentialBackoff(1000);
    const executionTime = new Date(Date.now() - 10000);
    const before = Date.now();
    const result2 = handler({
      executionTime,
      consecutiveFailures: 2,
      taskData: null,
      error: new Error(),
    });
    const result3 = handler({
      executionTime,
      consecutiveFailures: 3,
      taskData: null,
      error: new Error(),
    });
    // delay for failures=2: 1000 * 2^1 = 2000ms
    // delay for failures=3: 1000 * 2^2 = 4000ms
    expect(result2!.getTime()).toBeGreaterThanOrEqual(before + 2000);
    expect(result3!.getTime()).toBeGreaterThanOrEqual(before + 4000);
  });

  it('returns null at maxRetries', () => {
    const handler = exponentialBackoff(1000, 3);
    const result = handler({ ...baseParams, consecutiveFailures: 3 });
    expect(result).toBeNull();
  });

  it('continues indefinitely without maxRetries', () => {
    const handler = exponentialBackoff(1);
    const result = handler({ ...baseParams, consecutiveFailures: 50 });
    expect(result).toBeInstanceOf(Date);
  });

  it('uses now as base when executionTime is in the past', () => {
    const handler = exponentialBackoff(1000);
    const pastTime = new Date(Date.now() - 60000);
    const before = Date.now();
    const result = handler({
      executionTime: pastTime,
      consecutiveFailures: 1,
      taskData: null,
      error: new Error(),
    });
    expect(result!.getTime()).toBeGreaterThanOrEqual(before + 1000);
  });
});

describe('fixedDelay', () => {
  it('returns a date delayMs in the future from now', () => {
    const delayMs = 5000;
    const handler = fixedDelay(delayMs);
    const before = Date.now();
    const result = handler({ ...baseParams, consecutiveFailures: 1 });
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBeGreaterThanOrEqual(before + delayMs);
    expect(result!.getTime()).toBeLessThanOrEqual(after + delayMs + 10);
  });

  it('uses executionTime as base when it is in the future', () => {
    const futureTime = new Date(Date.now() + 10000);
    const handler = fixedDelay(5000);
    const result = handler({
      executionTime: futureTime,
      consecutiveFailures: 1,
      taskData: null,
      error: new Error(),
    });
    expect(result!.getTime()).toBeGreaterThanOrEqual(futureTime.getTime() + 5000);
  });

  it('returns null at maxRetries', () => {
    const handler = fixedDelay(5000, 2);
    const result = handler({ ...baseParams, consecutiveFailures: 2 });
    expect(result).toBeNull();
  });

  it('continues indefinitely without maxRetries', () => {
    const handler = fixedDelay(5000);
    const result = handler({ ...baseParams, consecutiveFailures: 100 });
    expect(result).toBeInstanceOf(Date);
  });
});
