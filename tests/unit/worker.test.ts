import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('../../src/postgres/store.js', () => ({
  pickDueTasks: vi.fn(),
  markSuccess: vi.fn(),
  markFailure: vi.fn(),
  updateTimedOutExecutions: vi.fn(),
  deleteTask: vi.fn(),
  heartbeat: vi.fn(),
}));

import { parseCronExpression } from 'cron-schedule';
import { runWorkerCycle, oneTime, recurring, cron } from '../../src/worker/worker.js';
import * as store from '../../src/postgres/store.js';

const mockPool = {} as Pool;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const baseParams = {
  pool: mockPool,
  tableName: 'tasks',
  workerId: 'test-worker',
  batchSize: 10,
  heartbeatTimeoutMs: 30000,
  logger,
};

function makeScheduledTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_name: 'default-task',
    task_instance: 'inst-1',
    task_data: null,
    execution_time: new Date('2024-01-01T00:00:00.000Z'),
    picked: true,
    picked_by: 'test-worker',
    last_success: null,
    last_failure: null,
    consecutive_failures: 0,
    last_heartbeat: null,
    version: 1,
    priority: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.updateTimedOutExecutions).mockResolvedValue(0);
  vi.mocked(store.pickDueTasks).mockResolvedValue([]);
  vi.mocked(store.markSuccess).mockResolvedValue(undefined);
  vi.mocked(store.markFailure).mockResolvedValue(undefined);
  vi.mocked(store.deleteTask).mockResolvedValue(undefined);
});

describe('runWorkerCycle', () => {
  it('always calls updateTimedOutExecutions and pickDueTasks', async () => {
    await runWorkerCycle(baseParams);
    expect(store.updateTimedOutExecutions).toHaveBeenCalledOnce();
    expect(store.pickDueTasks).toHaveBeenCalledOnce();
  });

  it('does nothing further when no tasks are due', async () => {
    await runWorkerCycle(baseParams);
    expect(store.markSuccess).not.toHaveBeenCalled();
    expect(store.markFailure).not.toHaveBeenCalled();
    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it('logs an error and deletes the task when no handler is registered', async () => {
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'unregistered-task' }),
    ] as any);
    await runWorkerCycle(baseParams);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No handler registered'));
    expect(store.deleteTask).toHaveBeenCalledOnce();
    expect(store.deleteTask).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
  });

  it('deletes a one-time task after successful execution', async () => {
    oneTime({ name: 'wc-one-time', run: async () => {} });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-one-time' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(store.deleteTask).toHaveBeenCalledOnce();
    expect(store.markSuccess).not.toHaveBeenCalled();
  });

  it('marks success for a recurring task after successful execution', async () => {
    recurring({ name: 'wc-recurring', intervalMs: 5000, run: async () => {} });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-recurring' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(store.markSuccess).toHaveBeenCalledOnce();
    expect(store.deleteTask).not.toHaveBeenCalled();
    const nextTime: Date = vi.mocked(store.markSuccess).mock.calls[0][0].nextExecutionTime;
    expect(nextTime.getTime()).toBeGreaterThan(Date.now());
  });

  it('calls markFailure when a task throws and failureHandler returns a date', async () => {
    const failureHandler = vi.fn().mockReturnValue(new Date(Date.now() + 5000));
    oneTime({
      name: 'wc-failing',
      run: async () => {
        throw new Error('boom');
      },
      failureHandler,
    });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-failing' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(failureHandler).toHaveBeenCalledOnce();
    expect(store.markFailure).toHaveBeenCalledOnce();
    expect(store.deleteTask).not.toHaveBeenCalled();
  });

  it('deletes the task when failureHandler returns null (retries exhausted)', async () => {
    const failureHandler = vi.fn().mockReturnValue(null);
    oneTime({
      name: 'wc-exhausted',
      run: async () => {
        throw new Error('boom');
      },
      failureHandler,
    });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-exhausted' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(store.deleteTask).toHaveBeenCalledOnce();
    expect(store.markFailure).not.toHaveBeenCalled();
  });

  it('passes consecutiveFailures + 1 to failureHandler', async () => {
    const failureHandler = vi.fn().mockReturnValue(null);
    oneTime({
      name: 'wc-count-failures',
      run: async () => {
        throw new Error('boom');
      },
      failureHandler,
    });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-count-failures', consecutive_failures: 2 }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(failureHandler).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 3 })
    );
  });

  it('uses nextExecutionTime for failure when no failureHandler is provided (recurring)', async () => {
    const interval = 5000;
    recurring({
      name: 'wc-recurring-fail',
      intervalMs: interval,
      run: async () => {
        throw new Error('oops');
      },
    });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-recurring-fail' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(store.markFailure).toHaveBeenCalledOnce();
    const nextTime: Date = vi.mocked(store.markFailure).mock.calls[0][0].nextExecutionTime;
    expect(nextTime.getTime()).toBeGreaterThan(Date.now());
  });

  it('passes heartbeatTimeoutMs to updateTimedOutExecutions', async () => {
    await runWorkerCycle({ ...baseParams, heartbeatTimeoutMs: 60000 });
    expect(store.updateTimedOutExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatTimeoutMs: 60000 })
    );
  });
});

describe('cron', () => {
  it('throws immediately when the cron expression is invalid', () => {
    expect(() =>
      cron({
        name: 'wc-cron-invalid',
        cronExpression: 'not a cron expression',
        run: async () => {},
      })
    ).toThrow();
  });

  it('computes nextExecutionTime from the cron expression via getNextDate', async () => {
    const now = new Date(2026, 7, 4, 0, 0, 0); // Tue Aug 4, 2026, local time
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      cron({ name: 'wc-cron', cronExpression: '0 2 * * 1', run: async () => {} });
      vi.mocked(store.pickDueTasks).mockResolvedValue([
        makeScheduledTask({
          task_name: 'wc-cron',
          execution_time: new Date(now.getTime() - 60000),
        }),
      ] as any);

      await runWorkerCycle(baseParams);

      const expected = parseCronExpression('0 2 * * 1').getNextDate(now);
      expect(store.markSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ nextExecutionTime: expected })
      );
      // Sanity check: it's actually the following Monday at 02:00, not just
      // "some date the mock happened to accept".
      expect(expected.getDay()).toBe(1);
      expect(expected.getHours()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes a cron task when failureHandler returns null (retries exhausted)', async () => {
    const failureHandler = vi.fn().mockReturnValue(null);
    cron({
      name: 'wc-cron-failing',
      cronExpression: '0 2 * * 1',
      run: async () => {
        throw new Error('boom');
      },
      failureHandler,
    });
    vi.mocked(store.pickDueTasks).mockResolvedValue([
      makeScheduledTask({ task_name: 'wc-cron-failing' }),
    ] as any);

    await runWorkerCycle(baseParams);

    expect(failureHandler).toHaveBeenCalledOnce();
    expect(store.deleteTask).toHaveBeenCalledOnce();
    expect(store.markFailure).not.toHaveBeenCalled();
  });
});
