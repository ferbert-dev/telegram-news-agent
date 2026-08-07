import test from "node:test";
import assert from "node:assert/strict";
import { getDatabaseConfig } from "../src/database.js";
import { assertTransition } from "../src/pipeline-states.js";

test("getDatabaseConfig returns a bounded PostgreSQL pool configuration", () => {
  assert.deepEqual(
    getDatabaseConfig({
      DATABASE_URL: " postgres://agent:secret@db:5432/news ",
      DATABASE_POOL_MAX: " 3 ",
      DATABASE_CONNECT_TIMEOUT_MS: " 7000 ",
      DATABASE_IDLE_TIMEOUT_MS: " 45000 ",
    }),
    {
      connectionString: "postgres://agent:secret@db:5432/news",
      max: 3,
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 45000,
      allowExitOnIdle: true,
    },
  );
});

test("getDatabaseConfig rejects missing or invalid database settings", () => {
  assert.throws(() => getDatabaseConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () =>
      getDatabaseConfig({
        DATABASE_URL: "postgres://db/news",
        DATABASE_POOL_MAX: "0",
      }),
    /DATABASE_POOL_MAX must be a positive integer/,
  );
});

test("state transitions accept only configured forward movement", () => {
  assert.doesNotThrow(() =>
    assertTransition("article", "reviewed", "drafted"),
  );
  assert.doesNotThrow(() => assertTransition("draft", "review", "approved"));
  assert.throws(
    () => assertTransition("draft", "review", "published"),
    /Invalid draft transition/,
  );
  assert.throws(
    () => assertTransition("article", "published", "drafted"),
    /Invalid article transition/,
  );
});
