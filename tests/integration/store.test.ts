import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  scheduleTask,
  pickDueTasks,
  markSuccess,
  markFailure,
  deleteTask,
  rescheduleTask,
  updateTimedOutExecutions,
  heartbeat,
  DEFAULT_TABLE_NAME,
} from "../../src/postgres/store.js";

const TABLE = "test_tasks";
const WORKER = "test-worker";
const logger = { info: () => {}, warn: () => {}, error: () => {} };

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({
    host: process.env.TEST_PG_HOST,
    port: Number(process.env.TEST_PG_PORT),
    user: process.env.TEST_PG_USER,
    password: process.env.TEST_PG_PASSWORD,
    database: process.env.TEST_PG_DB,
  });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLE}`);
  await pool.query(`TRUNCATE TABLE ${DEFAULT_TABLE_NAME}`);
});

// Helper to read a row directly from the DB
async function getRow(taskName: string, taskInstance: string) {
  const result = await pool.query(
    `SELECT * FROM ${TABLE} WHERE task_name = $1 AND task_instance = $2`,
    [taskName, taskInstance]
  );
  return result.rows[0] ?? null;
}

describe("default tableName", () => {
  it("scheduleTask uses the default table when tableName is omitted", async () => {
    await scheduleTask({ pool, taskName: "default-t", taskInstance: "i1", taskData: { x: 1 } });

    const result = await pool.query(
      `SELECT * FROM ${DEFAULT_TABLE_NAME} WHERE task_name = $1 AND task_instance = $2`,
      ["default-t", "i1"]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].task_data).toEqual({ x: 1 });
  });
});

describe("scheduleTask", () => {
  it("inserts a row with the given task data", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: { x: 1 } });

    const row = await getRow("t1", "i1");
    expect(row).not.toBeNull();
    expect(row.task_name).toBe("t1");
    expect(row.task_instance).toBe("i1");
    expect(row.task_data).toEqual({ x: 1 });
    expect(row.picked).toBe(false);
  });

  it("is idempotent — a second call does not overwrite the existing row", async () => {
    const time1 = new Date(Date.now() - 5000);
    const time2 = new Date(Date.now() + 5000);

    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: time1 });
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: time2 });

    const row = await getRow("t1", "i1");
    // Second call should have done nothing (ON CONFLICT DO NOTHING)
    expect(new Date(row.execution_time).getTime()).toBeCloseTo(time1.getTime(), -3);
  });
});

describe("pickDueTasks", () => {
  it("returns tasks whose execution_time is in the past", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "past", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });

    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_name).toBe("past");
  });

  it("does not return future tasks", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "future", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() + 60000) });

    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });

    expect(tasks).toHaveLength(0);
  });

  it("marks picked tasks as picked in the database", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });

    const row = await getRow("t1", "i1");
    expect(row.picked).toBe(true);
    expect(row.picked_by).toBe(WORKER);
  });

  it("does not return already-picked tasks", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });

    // Pick again — should get nothing
    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: "other-worker", limit: 10 });
    expect(tasks).toHaveLength(0);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await scheduleTask({ pool, tableName: TABLE, taskName: "t", taskInstance: `i${i}`, taskData: null, executionTime: new Date(Date.now() - 1000) });
    }

    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 3 });
    expect(tasks).toHaveLength(3);
  });

  it("orders by priority descending, then execution_time ascending", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "low",  taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 3000) });
    await scheduleTask({ pool, tableName: TABLE, taskName: "high", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pool.query(`UPDATE ${TABLE} SET priority = 10 WHERE task_name = 'high'`);
    await pool.query(`UPDATE ${TABLE} SET priority = 1  WHERE task_name = 'low'`);

    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });
    expect(tasks[0].task_name).toBe("high");
    expect(tasks[1].task_name).toBe("low");
  });

  it("returns normalized Date objects", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });

    const tasks = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 10 });
    expect(tasks[0].execution_time).toBeInstanceOf(Date);
  });
});

describe("markSuccess", () => {
  it("unpicks the task and updates execution_time", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    const [task] = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    const nextTime = new Date(Date.now() + 60000);
    await markSuccess({ pool, tableName: TABLE, task, nextExecutionTime: nextTime, workerId: WORKER, logger });

    const row = await getRow("t1", "i1");
    expect(row.picked).toBe(false);
    expect(row.picked_by).toBeNull();
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_success).not.toBeNull();
    expect(new Date(row.execution_time).getTime()).toBeCloseTo(nextTime.getTime(), -3);
  });

  it("resets consecutive_failures to 0", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pool.query(`UPDATE ${TABLE} SET consecutive_failures = 3 WHERE task_name = 't1'`);
    const [task] = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    await markSuccess({ pool, tableName: TABLE, task, nextExecutionTime: new Date(), workerId: WORKER, logger });

    const row = await getRow("t1", "i1");
    expect(row.consecutive_failures).toBe(0);
  });
});

describe("markFailure", () => {
  it("unpicks the task and increments consecutive_failures", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    const [task] = await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    const nextTime = new Date(Date.now() + 5000);
    await markFailure({ pool, tableName: TABLE, task, nextExecutionTime: nextTime, workerId: WORKER, logger });

    const row = await getRow("t1", "i1");
    expect(row.picked).toBe(false);
    expect(row.picked_by).toBeNull();
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_failure).not.toBeNull();
    expect(new Date(row.execution_time).getTime()).toBeCloseTo(nextTime.getTime(), -3);
  });
});

describe("deleteTask", () => {
  it("removes the row from the database", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    await deleteTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", workerId: WORKER, logger });

    const row = await getRow("t1", "i1");
    expect(row).toBeNull();
  });
});

describe("rescheduleTask", () => {
  it("updates execution_time and task_data on an unpicked task", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: { v: 1 }, executionTime: new Date(Date.now() - 1000) });

    const newTime = new Date(Date.now() + 10000);
    await rescheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: { v: 2 }, executionTime: newTime });

    const row = await getRow("t1", "i1");
    expect(row.task_data).toEqual({ v: 2 });
    expect(new Date(row.execution_time).getTime()).toBeCloseTo(newTime.getTime(), -3);
  });

  it("throws when the task does not exist", async () => {
    await expect(
      rescheduleTask({ pool, tableName: TABLE, taskName: "ghost", taskInstance: "i1", taskData: null, executionTime: new Date() })
    ).rejects.toThrow('Cannot reschedule task "ghost"');
  });

  it("throws when the task is currently picked", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    await expect(
      rescheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date() })
    ).rejects.toThrow('Cannot reschedule task "t1"');
  });
});

describe("updateTimedOutExecutions", () => {
  it("releases tasks whose heartbeat has expired", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    // Backdate the heartbeat so it looks stale
    await pool.query(`UPDATE ${TABLE} SET last_heartbeat = NOW() - INTERVAL '10 minutes'`);

    const recovered = await updateTimedOutExecutions({ pool, tableName: TABLE, heartbeatTimeoutMs: 5 * 60 * 1000 });

    expect(recovered).toBe(1);
    const row = await getRow("t1", "i1");
    expect(row.picked).toBe(false);
    expect(row.picked_by).toBeNull();
  });

  it("does not release tasks whose heartbeat is fresh", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    const recovered = await updateTimedOutExecutions({ pool, tableName: TABLE, heartbeatTimeoutMs: 5 * 60 * 1000 });

    expect(recovered).toBe(0);
    const row = await getRow("t1", "i1");
    expect(row.picked).toBe(true);
  });
});

describe("heartbeat", () => {
  it("updates last_heartbeat for a picked task", async () => {
    await scheduleTask({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", taskData: null, executionTime: new Date(Date.now() - 1000) });
    await pickDueTasks({ pool, tableName: TABLE, workerId: WORKER, limit: 1 });

    // Backdate the heartbeat
    await pool.query(`UPDATE ${TABLE} SET last_heartbeat = NOW() - INTERVAL '1 minute'`);
    const before = await getRow("t1", "i1");

    await heartbeat({ pool, tableName: TABLE, taskName: "t1", taskInstance: "i1", workerId: WORKER });

    const after = await getRow("t1", "i1");
    expect(new Date(after.last_heartbeat).getTime()).toBeGreaterThan(new Date(before.last_heartbeat).getTime());
  });
});
