import type { Pool } from "pg";
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}
export declare function oneTime<T = unknown>(params: {
    name: string;
    run(data: T | null): Promise<void>;
    failureHandler?(params: {
        executionTime: Date;
        consecutiveFailures: number;
        taskData: T | null;
        error: unknown;
    }): Date | null;
}): void;
export declare function recurring<T = unknown>(params: {
    name: string;
    intervalMs: number;
    run(data: T | null): Promise<void>;
    failureHandler?(params: {
        executionTime: Date;
        consecutiveFailures: number;
        taskData: T | null;
        error: unknown;
    }): Date | null;
}): void;
export declare function runWorkerCycle(params: {
    pool: Pool;
    tableName: string;
    workerId: string;
    batchSize: number;
    heartbeatTimeoutMs: number;
    heartbeatIntervalMs?: number;
    logger: Logger;
}): Promise<void>;
export interface WorkerHandle {
    /**
     * Stops the worker from picking new tasks and waits for the current cycle to finish.
     * If the cycle does not complete within timeoutMs, resolves anyway — in-flight tasks
     * may still be running. Callers should treat this as best-effort.
     */
    shutdown(timeoutMs?: number): Promise<void>;
}
export declare function startWorker(params: {
    pool: Pool;
    tableName?: string;
    workerId?: string;
    pollingIntervalMs?: number;
    batchSize?: number;
    heartbeatTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    logger?: Logger;
}): WorkerHandle;
