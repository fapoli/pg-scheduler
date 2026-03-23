import { execSync } from "child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const { Client } = pg;

let container: StartedPostgreSqlContainer;

export async function setup() {
  // Testcontainers looks for the Docker socket at /var/run/docker.sock by default.
  // If DOCKER_HOST isn't set, detect it from the active Docker context (e.g. Colima).
  if (!process.env.DOCKER_HOST) {
    try {
      const host = execSync('docker context inspect --format "{{.Endpoints.docker.Host}}"', {
        encoding: "utf8",
      }).trim().replace(/^"|"$/g, "");
      if (host) {
        process.env.DOCKER_HOST = host;
        // When using a non-standard socket (e.g. Colima), Testcontainers needs to know
        // the path *inside* the VM where it mounts the socket for its Ryuk reaper container.
        if (!process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE) {
          process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = "/var/run/docker.sock";
        }
      }
    } catch {
      // ignore — Testcontainers will fall back to its own detection
    }
  }

  container = await new PostgreSqlContainer("postgres:16").start();

  process.env.TEST_PG_HOST = container.getHost();
  process.env.TEST_PG_PORT = String(container.getMappedPort(5432));
  process.env.TEST_PG_USER = container.getUsername();
  process.env.TEST_PG_PASSWORD = container.getPassword();
  process.env.TEST_PG_DB = container.getDatabase();

  const client = new Client({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  });
  await client.connect();
  await client.query(`
    CREATE TABLE test_tasks (
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
    )
  `);
  await client.end();
}

export async function teardown() {
  await container.stop();
}
