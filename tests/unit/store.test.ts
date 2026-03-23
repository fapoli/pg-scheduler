import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { pickDueTasks } from "../../src/postgres/store.js";

function makePool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

describe("table name validation", () => {
  it("throws for names with spaces", async () => {
    await expect(pickDueTasks({ pool: makePool(), tableName: "my tasks", workerId: "w1", limit: 10 })).rejects.toThrow(
      "Invalid table name"
    );
  });

  it("throws for SQL injection attempt", async () => {
    await expect(
      pickDueTasks({ pool: makePool(), tableName: "tasks; DROP TABLE tasks", workerId: "w1", limit: 10 })
    ).rejects.toThrow("Invalid table name");
  });

  it("throws for names starting with a digit", async () => {
    await expect(
      pickDueTasks({ pool: makePool(), tableName: "1tasks", workerId: "w1", limit: 10 })
    ).rejects.toThrow("Invalid table name");
  });
});
