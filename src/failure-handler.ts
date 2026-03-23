export type FailureHandler<T = unknown> = (params: {
  executionTime: Date;
  consecutiveFailures: number;
  taskData: T | null;
  error: unknown;
}) => Date | null;

export function maxRetries<T = unknown>(maxRetries: number): FailureHandler<T> {
  return ({ consecutiveFailures }) => {
    if (consecutiveFailures >= maxRetries) {
      return null; // Stop retrying
    }
    return new Date(); // Retry immediately
  };
}

export function exponentialBackoff<T = unknown>(
  initialDelayMs: number,
  maxRetries?: number
): FailureHandler<T> {
  return ({ executionTime, consecutiveFailures }) => {
    if (maxRetries !== undefined && consecutiveFailures >= maxRetries) {
      return null;
    }

    const base = Math.max(Date.now(), executionTime.getTime());
    const delayMs = initialDelayMs * Math.pow(2, consecutiveFailures - 1);
    return new Date(base + delayMs);
  };
}

export function fixedDelay<T = unknown>(delayMs: number, maxRetries?: number): FailureHandler<T> {
  return ({ executionTime, consecutiveFailures }) => {
    if (maxRetries !== undefined && consecutiveFailures >= maxRetries) {
      return null;
    }

    const base = Math.max(Date.now(), executionTime.getTime());
    return new Date(base + delayMs);
  };
}
