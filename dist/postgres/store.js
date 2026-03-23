import { UPDATE_DUE_TASKS_PICKED_SQL, UPDATE_TASK_SUCCESS_SQL, UPDATE_TASK_FAILURE_SQL, UPDATE_TASK_HEARTBEAT_SQL, UPDATE_TIMED_OUT_EXECUTIONS_SQL, DELETE_TASK_SQL, INSERT_TASK_IF_NOT_EXISTS_SQL, UPDATE_TASK_SCHEDULE_SQL, } from "./postgres.sql.js";
function assertValidTableName(tableName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
        throw new Error(`Invalid table name: "${tableName}"`);
    }
}
async function query(pool, text, params = []) {
    return pool.query(text, params);
}
function normalizeRow(row) {
    return {
        ...row,
        execution_time: new Date(row.execution_time),
        last_success: row.last_success ? new Date(row.last_success) : null,
        last_failure: row.last_failure ? new Date(row.last_failure) : null,
        last_heartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : null,
    };
}
export async function pickDueTasks(params) {
    const { pool, tableName, workerId, limit } = params;
    assertValidTableName(tableName);
    const result = await query(pool, UPDATE_DUE_TASKS_PICKED_SQL(tableName), [
        limit,
        workerId,
    ]);
    return result.rows.map(normalizeRow);
}
export async function markSuccess(params) {
    const { pool, tableName, task, nextExecutionTime, workerId, logger } = params;
    assertValidTableName(tableName);
    const result = await query(pool, UPDATE_TASK_SUCCESS_SQL(tableName), [
        task.task_name,
        task.task_instance,
        nextExecutionTime,
        workerId,
    ]);
    if (result.rowCount === 0) {
        logger.warn(`markSuccess had no effect for task "${task.task_name}" (instance: "${task.task_instance}"): task may have been recovered and re-picked by another worker`);
    }
}
export async function markFailure(params) {
    const { pool, tableName, task, nextExecutionTime, workerId, logger } = params;
    assertValidTableName(tableName);
    const result = await query(pool, UPDATE_TASK_FAILURE_SQL(tableName), [
        task.task_name,
        task.task_instance,
        nextExecutionTime,
        workerId,
    ]);
    if (result.rowCount === 0) {
        logger.warn(`markFailure had no effect for task "${task.task_name}" (instance: "${task.task_instance}"): task may have been recovered and re-picked by another worker`);
    }
}
export async function heartbeat(params) {
    const { pool, tableName, taskName, taskInstance, workerId } = params;
    assertValidTableName(tableName);
    await query(pool, UPDATE_TASK_HEARTBEAT_SQL(tableName), [taskName, taskInstance, workerId]);
}
export async function updateTimedOutExecutions(params) {
    const { pool, tableName, heartbeatTimeoutMs } = params;
    assertValidTableName(tableName);
    const result = await query(pool, UPDATE_TIMED_OUT_EXECUTIONS_SQL(tableName), [heartbeatTimeoutMs]);
    return result.rowCount ?? 0;
}
export async function deleteTask(params) {
    const { pool, tableName, taskName, taskInstance, workerId, logger } = params;
    assertValidTableName(tableName);
    const result = await query(pool, DELETE_TASK_SQL(tableName), [taskName, taskInstance, workerId]);
    if (result.rowCount === 0) {
        logger.warn(`deleteTask had no effect for task "${taskName}" (instance: "${taskInstance}"): task may have been recovered and re-picked by another worker`);
    }
}
export async function scheduleTask(params) {
    const { pool, tableName, taskName, taskInstance, taskData, executionTime } = params;
    assertValidTableName(tableName);
    await query(pool, INSERT_TASK_IF_NOT_EXISTS_SQL(tableName), [
        taskName,
        taskInstance,
        taskData,
        executionTime ?? new Date(),
    ]);
}
export async function rescheduleTask(params) {
    const { pool, tableName, taskName, taskInstance, taskData, executionTime } = params;
    assertValidTableName(tableName);
    const result = await query(pool, UPDATE_TASK_SCHEDULE_SQL(tableName), [
        taskName,
        taskInstance,
        executionTime,
        taskData,
    ]);
    if (result.rowCount === 0) {
        throw new Error(`Cannot reschedule task "${taskName}" (instance: "${taskInstance}"): task not found or currently picked`);
    }
}
