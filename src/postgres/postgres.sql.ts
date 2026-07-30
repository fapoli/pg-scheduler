export const UPDATE_DUE_TASKS_PICKED_SQL = (table: string): string => `
  UPDATE ${table}
  SET picked = TRUE,
      picked_by = $2,
      last_heartbeat = NOW(),
      version = version + 1
  FROM (
    SELECT task_name, task_instance
    FROM ${table}
    WHERE execution_time <= NOW()
      AND picked = FALSE
    ORDER BY priority DESC NULLS LAST, execution_time ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $1
  ) AS candidates
  WHERE ${table}.task_name = candidates.task_name
    AND ${table}.task_instance = candidates.task_instance
  RETURNING
    ${table}.task_name,
    ${table}.task_instance,
    ${table}.task_data,
    ${table}.execution_time,
    ${table}.picked,
    ${table}.picked_by,
    ${table}.last_success,
    ${table}.last_failure,
    ${table}.consecutive_failures,
    ${table}.last_heartbeat,
    ${table}.version,
    ${table}.priority
`;

export const UPDATE_TASK_SUCCESS_SQL = (table: string): string => `
  UPDATE ${table}
  SET execution_time = $3,
      picked = FALSE,
      picked_by = NULL,
      last_success = NOW(),
      consecutive_failures = 0,
      last_heartbeat = NULL,
      version = version + 1
  WHERE task_name = $1
    AND task_instance = $2
    AND picked_by = $4
    AND version = $5
`;

export const UPDATE_TASK_FAILURE_SQL = (table: string): string => `
  UPDATE ${table}
  SET execution_time = $3,
      picked = FALSE,
      picked_by = NULL,
      last_failure = NOW(),
      consecutive_failures = consecutive_failures + 1,
      last_heartbeat = NULL,
      version = version + 1
  WHERE task_name = $1
    AND task_instance = $2
    AND picked_by = $4
    AND version = $5
`;

// Deliberately does not bump version: the version captured at pick time
// must stay valid as the concurrency guard for the whole lifetime of the
// execution (heartbeats, and the eventual success/failure/delete).
export const UPDATE_TASK_HEARTBEAT_SQL = (table: string): string => `
  UPDATE ${table}
  SET last_heartbeat = NOW()
  WHERE task_name = $1
    AND task_instance = $2
    AND picked_by = $3
    AND version = $4
`;

export const UPDATE_TIMED_OUT_EXECUTIONS_SQL = (table: string): string => `
  UPDATE ${table}
  SET picked = FALSE,
      picked_by = NULL,
      last_heartbeat = NULL,
      version = version + 1
  WHERE picked = TRUE
    AND (last_heartbeat IS NULL
      OR last_heartbeat < NOW() - ($1 * INTERVAL '1 millisecond'))
`;

export const DELETE_TASK_SQL = (tableName: string): string => `
  DELETE FROM ${tableName}
  WHERE task_name = $1
    AND task_instance = $2
    AND picked_by = $3
    AND version = $4
`;

export const INSERT_TASK_IF_NOT_EXISTS_SQL = (tableName: string): string => `
  INSERT INTO ${tableName} (task_name, task_instance, task_data, execution_time, priority)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (task_name, task_instance) DO NOTHING
`;

export const UPDATE_TASK_SCHEDULE_SQL = (tableName: string): string => `
  UPDATE ${tableName}
  SET execution_time = $3,
      task_data = $4,
      priority = COALESCE($5, priority),
      version = version + 1
  WHERE task_name = $1
    AND task_instance = $2
    AND picked = FALSE
`;
