import os from "os";
import { pickDueTasks, markSuccess, markFailure, updateTimedOutExecutions, deleteTask, heartbeat, } from "../postgres/store.js";
const tasks = new Map();
export function oneTime(params) {
    tasks.set(params.name, {
        name: params.name,
        run: params.run,
        nextExecutionTime: () => null,
        failureHandler: params.failureHandler,
    });
}
export function recurring(params) {
    tasks.set(params.name, {
        name: params.name,
        run: params.run,
        nextExecutionTime: (currentExecutionTime) => new Date(Math.max(Date.now(), currentExecutionTime.getTime()) + params.intervalMs),
        failureHandler: params.failureHandler,
    });
}
export async function runWorkerCycle(params) {
    const { pool, tableName, workerId, batchSize, heartbeatTimeoutMs, heartbeatIntervalMs, logger } = params;
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
    await Promise.all(scheduledTasks.map(async (scheduledTask) => {
        const task = tasks.get(scheduledTask.task_name);
        if (!task) {
            logger.error(`No handler registered for task "${scheduledTask.task_name}". Deleting task instance "${scheduledTask.task_instance}".`);
            await deleteTask({
                pool,
                tableName,
                taskName: scheduledTask.task_name,
                taskInstance: scheduledTask.task_instance,
                workerId,
                logger,
            });
            return;
        }
        const stopHeartbeat = heartbeatIntervalMs !== undefined && heartbeatIntervalMs > 0
            ? startHeartbeat({
                pool,
                tableName,
                taskName: scheduledTask.task_name,
                taskInstance: scheduledTask.task_instance,
                workerId,
                intervalMs: heartbeatIntervalMs,
                logger,
            })
            : null;
        try {
            await task.run(scheduledTask.task_data);
            const nextExecutionTime = task.nextExecutionTime(scheduledTask.execution_time, scheduledTask.task_data);
            if (nextExecutionTime === null) {
                await deleteTask({
                    pool,
                    tableName,
                    taskName: scheduledTask.task_name,
                    taskInstance: scheduledTask.task_instance,
                    workerId,
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
        }
        catch (error) {
            logger.error(`Task "${scheduledTask.task_name}" (instance: "${scheduledTask.task_instance}") failed:`, error);
            let nextExecutionTime;
            if (task.failureHandler) {
                nextExecutionTime = task.failureHandler({
                    executionTime: scheduledTask.execution_time,
                    consecutiveFailures: scheduledTask.consecutive_failures + 1,
                    taskData: scheduledTask.task_data,
                    error,
                });
            }
            else {
                nextExecutionTime = task.nextExecutionTime(scheduledTask.execution_time, scheduledTask.task_data);
            }
            if (nextExecutionTime === null) {
                await deleteTask({
                    pool,
                    tableName,
                    taskName: scheduledTask.task_name,
                    taskInstance: scheduledTask.task_instance,
                    workerId,
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
        }
        finally {
            stopHeartbeat?.();
        }
    }));
}
function startHeartbeat(params) {
    const { pool, tableName, taskName, taskInstance, workerId, intervalMs, logger } = params;
    let stopped = false;
    let timer = null;
    async function tick() {
        if (stopped)
            return;
        try {
            await heartbeat({ pool, tableName, taskName, taskInstance, workerId });
        }
        catch (error) {
            logger.error("Failed to send heartbeat", error);
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
export function startWorker(params) {
    const { pool, tableName = "scheduled_tasks", workerId = `${os.hostname()}-${process.pid}`, pollingIntervalMs = 10000, batchSize = 10, heartbeatTimeoutMs = 300000, heartbeatIntervalMs = heartbeatTimeoutMs / 3, logger = console, } = params;
    let stopping = false;
    let cyclePromise = Promise.resolve();
    let sleepAbort = null;
    async function run() {
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
                logger.error("Worker cycle failed", error);
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
        logger.error("Scheduler worker crashed", error);
    });
    return {
        async shutdown(timeoutMs = 30000) {
            stopping = true;
            sleepAbort?.();
            await Promise.race([
                cyclePromise,
                sleep(timeoutMs).then(() => {
                    logger.warn(`shutdown() timed out after ${timeoutMs}ms for worker "${workerId}" (table: "${tableName}") — returning while tasks may still be running`);
                }),
            ]);
        },
    };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function abortableSleep(ms, onAbort) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        onAbort(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}
