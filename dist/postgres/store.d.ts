import type { Pool, QueryResultRow } from "pg";
import type { Logger } from "../worker/worker.js";
export interface ScheduledTaskRow extends QueryResultRow {
    task_name: string;
    task_instance: string;
    task_data: unknown | null;
    execution_time: Date;
    picked: boolean;
    picked_by: string | null;
    last_success: Date | null;
    last_failure: Date | null;
    consecutive_failures: number;
    last_heartbeat: Date | null;
    version: number;
    priority: number | null;
}
export declare function pickDueTasks(params: {
    pool: Pool;
    tableName: string;
    workerId: string;
    limit: number;
}): Promise<ScheduledTaskRow[]>;
export declare function markSuccess(params: {
    pool: Pool;
    tableName: string;
    task: ScheduledTaskRow;
    nextExecutionTime: Date;
    workerId: string;
    logger: Logger;
}): Promise<void>;
export declare function markFailure(params: {
    pool: Pool;
    tableName: string;
    task: ScheduledTaskRow;
    nextExecutionTime: Date;
    workerId: string;
    logger: Logger;
}): Promise<void>;
export declare function heartbeat(params: {
    pool: Pool;
    tableName: string;
    taskName: string;
    taskInstance: string;
    workerId: string;
}): Promise<void>;
export declare function updateTimedOutExecutions(params: {
    pool: Pool;
    tableName: string;
    heartbeatTimeoutMs: number;
}): Promise<number>;
export declare function deleteTask(params: {
    pool: Pool;
    tableName: string;
    taskName: string;
    taskInstance: string;
    workerId: string;
    logger: Logger;
}): Promise<void>;
export declare function scheduleTask(params: {
    pool: Pool;
    tableName: string;
    taskName: string;
    taskInstance: string;
    taskData: unknown;
    executionTime?: Date;
}): Promise<void>;
export declare function rescheduleTask(params: {
    pool: Pool;
    tableName: string;
    taskName: string;
    taskInstance: string;
    taskData: unknown;
    executionTime: Date;
}): Promise<void>;
