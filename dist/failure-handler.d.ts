export type FailureHandler<T = unknown> = (params: {
    executionTime: Date;
    consecutiveFailures: number;
    taskData: T | null;
    error: unknown;
}) => Date | null;
export declare function maxRetries<T = unknown>(maxRetries: number): FailureHandler<T>;
export declare function exponentialBackoff<T = unknown>(initialDelayMs: number, maxRetries?: number): FailureHandler<T>;
export declare function fixedDelay<T = unknown>(delayMs: number, maxRetries?: number): FailureHandler<T>;
