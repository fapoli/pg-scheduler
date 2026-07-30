import os from 'os';
import type { Pool } from 'pg';
import {
  pickDueTasks,
  markSuccess,
  markFailure,
  updateTimedOutExecutions,
  deleteTask,
  heartbeat,
  DEFAULT_TABLE_NAME,
} from '../postgres/store.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface Task<T = unknown> {
  name: string;
  run(data: T | null): Promise<void>;
  nextExecutionTime(currentExecutionTime: Date, data: T | null): Date | null;
  failureHandler?(params: {
    executionTime: Date;
    consecutiveFailures: number;
    taskData: T | null;
    error: unknown;
  }): Date | null;
}

const tasks = new Map<string, Task>();

export function oneTime<T = unknown>(params: {
  name: string;
  run(data: T | null): Promise<void>;
  failureHandler?(params: {
    executionTime: Date;
    consecutiveFailures: number;
    taskData: T | null;
    error: unknown;
  }): Date | null;
}): void {
  tasks.set(params.name, {
    name: params.name,
    run: params.run,
    nextExecutionTime: () => null,
    failureHandler: params.failureHandler,
  });
}

export function recurring<T = unknown>(params: {
  name: string;
  intervalMs: number;
  run(data: T | null): Promise<void>;
  failureHandler?(params: {
    executionTime: Date;
    consecutiveFailures: number;
    taskData: T | null;
    error: unknown;
  }): Date | null;
}): void {
  tasks.set(params.name, {
    name: params.name,
    run: params.run,
    nextExecutionTime: (currentExecutionTime: Date) =>
      new Date(Math.max(Date.now(), currentExecutionTime.getTime()) + params.intervalMs),
    failureHandler: params.failureHandler,
  });
}

export async function runWorkerCycle(params: {
  pool: Pool;
  tableName: string;
  workerId: string;
  batchSize: number;
  heartbeatTimeoutMs: number;
  heartbeatIntervalMs?: number;
  logger: Logger;
}): Promise<void> {
  const { pool, tableName, workerId, batchSize, heartbeatTimeoutMs, heartbeatIntervalMs, logger } =
    params;

  await updateTimedOutExecutions({
    pool,
    tableName,
    heartbeatTimeoutMs,
  });

  const scheduledTasks = await pickDueTasks({
    pool,
    tableName,
    workerId,
    limit: batchSize,
  });

  await Promise.all(
    scheduledTasks.map(async (scheduledTask) => {
      const task = tasks.get(scheduledTask.task_name);

      if (!task) {
        logger.error(
          `No handler registered for task "${scheduledTask.task_name}". Deleting task instance "${scheduledTask.task_instance}".`
        );
        await deleteTask({
          pool,
          tableName,
          taskName: scheduledTask.task_name,
          taskInstance: scheduledTask.task_instance,
          workerId,
          version: scheduledTask.version,
          logger,
        });
        return;
      }

      const stopHeartbeat =
        heartbeatIntervalMs !== undefined && heartbeatIntervalMs > 0
          ? startHeartbeat({
              pool,
              tableName,
              taskName: scheduledTask.task_name,
              taskInstance: scheduledTask.task_instance,
              workerId,
              version: scheduledTask.version,
              intervalMs: heartbeatIntervalMs,
              logger,
            })
          : null;

      try {
        await task.run(scheduledTask.task_data);

        const nextExecutionTime = task.nextExecutionTime(
          scheduledTask.execution_time,
          scheduledTask.task_data
        );

        if (nextExecutionTime === null) {
          await deleteTask({
            pool,
            tableName,
            taskName: scheduledTask.task_name,
            taskInstance: scheduledTask.task_instance,
            workerId,
            version: scheduledTask.version,
            logger,
          });
          return;
        }

        await markSuccess({
          pool,
          tableName,
          task: scheduledTask,
          nextExecutionTime,
          workerId,
          logger,
        });
      } catch (error) {
        logger.error(
          `Task "${scheduledTask.task_name}" (instance: "${scheduledTask.task_instance}") failed:`,
          error
        );

        let nextExecutionTime: Date | null;

        if (task.failureHandler) {
          nextExecutionTime = task.failureHandler({
            executionTime: scheduledTask.execution_time,
            consecutiveFailures: scheduledTask.consecutive_failures + 1,
            taskData: scheduledTask.task_data,
            error,
          });
        } else {
          nextExecutionTime = task.nextExecutionTime(
            scheduledTask.execution_time,
            scheduledTask.task_data
          );
        }

        if (nextExecutionTime === null) {
          await deleteTask({
            pool,
            tableName,
            taskName: scheduledTask.task_name,
            taskInstance: scheduledTask.task_instance,
            workerId,
            version: scheduledTask.version,
            logger,
          });
          return;
        }

        await markFailure({
          pool,
          tableName,
          task: scheduledTask,
          nextExecutionTime,
          workerId,
          logger,
        });
      } finally {
        stopHeartbeat?.();
      }
    })
  );
}

function startHeartbeat(params: {
  pool: Pool;
  tableName: string;
  taskName: string;
  taskInstance: string;
  workerId: string;
  version: number;
  intervalMs: number;
  logger: Logger;
}): () => void {
  const { pool, tableName, taskName, taskInstance, workerId, version, intervalMs, logger } = params;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await heartbeat({ pool, tableName, taskName, taskInstance, workerId, version });
    } catch (error) {
      logger.error('Failed to send heartbeat', error);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export interface WorkerHandle {
  /**
   * Stops the worker from picking new tasks and waits for the current cycle to finish.
   * If the cycle does not complete within timeoutMs, resolves anyway — in-flight tasks
   * may still be running. Callers should treat this as best-effort.
   */
  shutdown(timeoutMs?: number): Promise<void>;
}

export function startWorker({
  pool,
  tableName = DEFAULT_TABLE_NAME,
  workerId = `${os.hostname()}-${process.pid}`,
  pollingIntervalMs = 10000,
  batchSize = 10,
  heartbeatTimeoutMs = 300000,
  heartbeatIntervalMs = heartbeatTimeoutMs / 3,
  logger = console,
}: {
  pool: Pool;
  tableName?: string;
  workerId?: string;
  pollingIntervalMs?: number;
  batchSize?: number;
  heartbeatTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  logger?: Logger;
}): WorkerHandle {
  let stopping = false;
  let cyclePromise: Promise<void> = Promise.resolve();
  let sleepAbort: (() => void) | null = null;

  async function run(): Promise<void> {
    while (!stopping) {
      cyclePromise = runWorkerCycle({
        pool,
        tableName,
        workerId,
        batchSize,
        heartbeatTimeoutMs,
        heartbeatIntervalMs,
        logger,
      }).catch((error) => {
        logger.error('Worker cycle failed', error);
      });

      await cyclePromise;

      if (!stopping) {
        await abortableSleep(pollingIntervalMs, (abort) => {
          sleepAbort = abort;
        });
        sleepAbort = null;
      }
    }
  }

  run().catch((error) => {
    logger.error('Scheduler worker crashed', error);
  });

  return {
    async shutdown(timeoutMs = 30000): Promise<void> {
      stopping = true;
      sleepAbort?.();

      await Promise.race([
        cyclePromise,
        sleep(timeoutMs).then(() => {
          logger.warn(
            `shutdown() timed out after ${timeoutMs}ms for worker "${workerId}" (table: "${tableName}") — returning while tasks may still be running`
          );
        }),
      ]);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, onAbort: (abort: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onAbort(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
