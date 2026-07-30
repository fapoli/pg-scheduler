# @fapoli/pg-scheduler

[![npm](https://img.shields.io/npm/v/@fapoli/pg-scheduler)](https://www.npmjs.com/package/@fapoli/pg-scheduler)
[![GitHub repo](https://img.shields.io/badge/github-fapoli%2Fpg--scheduler-blue?logo=github)](https://github.com/fapoli/pg-scheduler)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A PostgreSQL-backed distributed task scheduler for Node.js. Inspired by [db-scheduler](https://github.com/kagkarlsson/db-scheduler).

## Why does this exist?

In distributed systems, running background jobs reliably is non-trivial.

When multiple instances of an application are running, naive schedulers will execute the same task in every instance—causing duplicate work, race conditions, and inconsistent state.

This project uses PostgreSQL as a coordination layer to ensure that tasks are executed by only one worker at a time. By leveraging row-level locking (`FOR UPDATE SKIP LOCKED`), it enables safe, distributed job execution without requiring additional infrastructure.

## Features

- Distributed-safe via `FOR UPDATE SKIP LOCKED`
- One-time, fixed-interval, and cron-scheduled recurring tasks
- Heartbeat-based dead execution recovery
- Configurable failure handlers with exponential backoff, fixed delay, or max retries
- Graceful shutdown
- No external dependencies beyond `pg` and [`cron-schedule`](https://www.npmjs.com/package/cron-schedule) (used only for its expression parser/next-date calculation — this library's own worker still owns polling and execution)

## Installation

Requires Node.js >= 20.

```bash
npm install @fapoli/pg-scheduler
```

`pg` is a peer dependency — install it if you haven't already:

```bash
npm install pg
```

## Database setup

Run this migration against your PostgreSQL database:

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  task_name            TEXT        NOT NULL,
  task_instance        TEXT        NOT NULL,
  task_data            JSONB,
  execution_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked               BOOLEAN     NOT NULL DEFAULT FALSE,
  picked_by            TEXT,
  last_success         TIMESTAMPTZ,
  last_failure         TIMESTAMPTZ,
  consecutive_failures INT         NOT NULL DEFAULT 0,
  last_heartbeat       TIMESTAMPTZ,
  version              BIGINT      NOT NULL DEFAULT 1,
  priority             INT,
  PRIMARY KEY (task_name, task_instance)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_last_heartbeat
    ON scheduled_tasks (last_heartbeat);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_picker
    ON scheduled_tasks (priority DESC NULLS LAST, execution_time ASC)
    WHERE picked = FALSE;
```

## Usage

### Register tasks and start the worker

```ts
import { Pool } from 'pg';
import { oneTime, recurring, scheduleTask, startWorker } from '@fapoli/pg-scheduler';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Register a one-time task
oneTime({
  name: 'send-welcome-email',
  run: async (data) => {
    await sendEmail(data.userId);
  },
});

// Register a recurring task
recurring({
  name: 'cleanup-expired-sessions',
  intervalMs: 60 * 60 * 1000, // every hour
  run: async () => {
    await deleteExpiredSessions();
  },
});

// Schedule initial executions (ON CONFLICT DO NOTHING — safe to call on every boot)
await scheduleTask({
  pool,
  taskName: 'send-welcome-email',
  taskInstance: 'user-123',
  taskData: { userId: 'user-123' },
});
await scheduleTask({
  pool,
  taskName: 'cleanup-expired-sessions',
  taskInstance: 'default',
  taskData: null,
});

// Start the worker
const worker = startWorker({ pool });

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.shutdown();
  process.exit(0);
});
```

### One-time tasks

One-time tasks are deleted after successful execution.

```ts
oneTime({
  name: 'my-task',
  run: async (data) => {
    /* ... */
  },
});
```

### Recurring tasks

Recurring tasks reschedule themselves after each successful execution based on `intervalMs`.

```ts
recurring({
  name: 'my-recurring-task',
  intervalMs: 5 * 60 * 1000, // every 5 minutes
  run: async (data) => {
    /* ... */
  },
});
```

### Cron tasks

Cron tasks work like recurring tasks, but the next execution is computed from a cron expression instead of a fixed interval. The expression is parsed once at registration time — an invalid expression throws immediately rather than failing later.

```ts
import { cron } from '@fapoli/pg-scheduler';

cron({
  name: 'weekly-report',
  cronExpression: '0 2 * * 1', // 02:00 every Monday
  run: async (data) => {
    /* ... */
  },
});
```

Cron expressions are evaluated in the server's local time zone (like `crontab` without `CRON_TZ` set) — there's no per-task IANA timezone override.

### Scheduling tasks

```ts
// Schedule immediately (or supply an executionTime)
await scheduleTask({
  pool,
  taskName: 'my-task',
  taskInstance: 'unique-instance-id',
  taskData: { foo: 'bar' }, // pass null if no data
  executionTime: new Date(Date.now() + 5000), // optional, defaults to now
  priority: 10, // optional, higher runs first
  tableName: 'scheduled_tasks', // optional, defaults to 'scheduled_tasks'
});

// Reschedule an existing task (throws if not found or currently running)
await rescheduleTask({
  pool,
  taskName: 'my-task',
  taskInstance: 'unique-instance-id',
  taskData: { foo: 'baz' },
  executionTime: new Date(Date.now() + 10000),
  priority: 10, // optional, omit to leave unchanged
  tableName: 'scheduled_tasks', // optional, defaults to 'scheduled_tasks'
});
```

### Priority

Tasks with a higher `priority` are picked before tasks with a lower (or no) priority whenever both are due. Ties are broken by `executionTime` ascending. Priority is optional — tasks without one are treated as lowest priority.

### Failure handlers

```ts
import { exponentialBackoff, fixedDelay, maxRetries } from '@fapoli/pg-scheduler';

recurring({
  name: 'my-task',
  intervalMs: 60000,
  run: async () => {
    /* ... */
  },
  failureHandler: exponentialBackoff(1000, 5), // 1s initial delay, max 5 retries
});

// Other built-ins
fixedDelay(5000, 3); // retry every 5s, max 3 times
maxRetries(3); // retry immediately, max 3 times
```

### Worker options

```ts
startWorker({
  pool,
  tableName: 'scheduled_tasks', // default
  workerId: 'my-worker-1', // default: hostname-pid
  pollingIntervalMs: 10000, // default: 10s
  batchSize: 10, // default: 10
  heartbeatTimeoutMs: 300000, // default: 5 minutes
  heartbeatIntervalMs: 100000, // default: heartbeatTimeoutMs / 3
  logger: console, // default: console — inject your own
});
```

### Custom logger

```ts
startWorker({
  pool,
  logger: {
    info: (msg) => myLogger.info(msg),
    warn: (msg) => myLogger.warn(msg),
    error: (msg, err) => myLogger.error(msg, err),
  },
});
```

## License

MIT
