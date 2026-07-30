import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { Logger } from '../worker/worker.js';
import {
  UPDATE_DUE_TASKS_PICKED_SQL,
  UPDATE_TASK_SUCCESS_SQL,
  UPDATE_TASK_FAILURE_SQL,
  UPDATE_TASK_HEARTBEAT_SQL,
  UPDATE_TIMED_OUT_EXECUTIONS_SQL,
  DELETE_TASK_SQL,
  INSERT_TASK_IF_NOT_EXISTS_SQL,
  UPDATE_TASK_SCHEDULE_SQL,
} from './postgres.sql.js';

export const DEFAULT_TABLE_NAME = 'scheduled_tasks';

function assertValidTableName(tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}"`);
  }
}

interface ScheduledTaskDbRow extends QueryResultRow {
  task_name: string;
  task_instance: string;
  task_data: unknown | null;
  execution_time: Date | string;
  picked: boolean;
  picked_by: string | null;
  last_success: Date | string | null;
  last_failure: Date | string | null;
  consecutive_failures: number;
  last_heartbeat: Date | string | null;
  version: number;
  priority: number | null;
}

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

async function query<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

function normalizeRow(row: ScheduledTaskDbRow): ScheduledTaskRow {
  return {
    ...row,
    execution_time: new Date(row.execution_time),
    last_success: row.last_success ? new Date(row.last_success) : null,
    last_failure: row.last_failure ? new Date(row.last_failure) : null,
    last_heartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : null,
  };
}

export async function pickDueTasks(params: {
  pool: Pool;
  tableName: string;
  workerId: string;
  limit: number;
}): Promise<ScheduledTaskRow[]> {
  const { pool, tableName, workerId, limit } = params;
  assertValidTableName(tableName);

  const result = await query<ScheduledTaskDbRow>(pool, UPDATE_DUE_TASKS_PICKED_SQL(tableName), [
    limit,
    workerId,
  ]);

  return result.rows.map(normalizeRow);
}

export async function markSuccess(params: {
  pool: Pool;
  tableName: string;
  task: ScheduledTaskRow;
  nextExecutionTime: Date;
  workerId: string;
  logger: Logger;
}): Promise<void> {
  const { pool, tableName, task, nextExecutionTime, workerId, logger } = params;
  assertValidTableName(tableName);

  const result = await query(pool, UPDATE_TASK_SUCCESS_SQL(tableName), [
    task.task_name,
    task.task_instance,
    nextExecutionTime,
    workerId,
    task.version,
  ]);

  if (result.rowCount === 0) {
    logger.warn(
      `markSuccess had no effect for task "${task.task_name}" (instance: "${task.task_instance}"): task may have been recovered and re-picked since this execution started (possibly by this same worker)`
    );
  }
}

export async function markFailure(params: {
  pool: Pool;
  tableName: string;
  task: ScheduledTaskRow;
  nextExecutionTime: Date;
  workerId: string;
  logger: Logger;
}): Promise<void> {
  const { pool, tableName, task, nextExecutionTime, workerId, logger } = params;
  assertValidTableName(tableName);

  const result = await query(pool, UPDATE_TASK_FAILURE_SQL(tableName), [
    task.task_name,
    task.task_instance,
    nextExecutionTime,
    workerId,
    task.version,
  ]);

  if (result.rowCount === 0) {
    logger.warn(
      `markFailure had no effect for task "${task.task_name}" (instance: "${task.task_instance}"): task may have been recovered and re-picked since this execution started (possibly by this same worker)`
    );
  }
}

export async function heartbeat(params: {
  pool: Pool;
  tableName: string;
  taskName: string;
  taskInstance: string;
  workerId: string;
  version: number;
}): Promise<void> {
  const { pool, tableName, taskName, taskInstance, workerId, version } = params;
  assertValidTableName(tableName);

  await query(pool, UPDATE_TASK_HEARTBEAT_SQL(tableName), [
    taskName,
    taskInstance,
    workerId,
    version,
  ]);
}

export async function updateTimedOutExecutions(params: {
  pool: Pool;
  tableName: string;
  heartbeatTimeoutMs: number;
}): Promise<number> {
  const { pool, tableName, heartbeatTimeoutMs } = params;
  assertValidTableName(tableName);

  const result = await query(pool, UPDATE_TIMED_OUT_EXECUTIONS_SQL(tableName), [
    heartbeatTimeoutMs,
  ]);

  return result.rowCount ?? 0;
}

export async function deleteTask(params: {
  pool: Pool;
  tableName: string;
  taskName: string;
  taskInstance: string;
  workerId: string;
  version: number;
  logger: Logger;
}): Promise<void> {
  const { pool, tableName, taskName, taskInstance, workerId, version, logger } = params;
  assertValidTableName(tableName);

  const result = await query(pool, DELETE_TASK_SQL(tableName), [
    taskName,
    taskInstance,
    workerId,
    version,
  ]);

  if (result.rowCount === 0) {
    logger.warn(
      `deleteTask had no effect for task "${taskName}" (instance: "${taskInstance}"): task may have been recovered and re-picked since this execution started (possibly by this same worker)`
    );
  }
}

export async function scheduleTask({
  pool,
  tableName = DEFAULT_TABLE_NAME,
  taskName,
  taskInstance,
  taskData,
  executionTime,
  priority,
}: {
  pool: Pool;
  tableName?: string;
  taskName: string;
  taskInstance: string;
  taskData: unknown;
  executionTime?: Date;
  priority?: number;
}): Promise<void> {
  assertValidTableName(tableName);

  await query(pool, INSERT_TASK_IF_NOT_EXISTS_SQL(tableName), [
    taskName,
    taskInstance,
    taskData,
    executionTime ?? new Date(),
    priority ?? null,
  ]);
}

export async function rescheduleTask({
  pool,
  tableName = DEFAULT_TABLE_NAME,
  taskName,
  taskInstance,
  taskData,
  executionTime,
  priority,
}: {
  pool: Pool;
  tableName?: string;
  taskName: string;
  taskInstance: string;
  taskData: unknown;
  executionTime: Date;
  priority?: number;
}): Promise<void> {
  assertValidTableName(tableName);

  const result = await query(pool, UPDATE_TASK_SCHEDULE_SQL(tableName), [
    taskName,
    taskInstance,
    executionTime,
    taskData,
    priority ?? null,
  ]);

  if (result.rowCount === 0) {
    throw new Error(
      `Cannot reschedule task "${taskName}" (instance: "${taskInstance}"): task not found or currently picked`
    );
  }
}
