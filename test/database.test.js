import test from "node:test";
import assert from "node:assert/strict";
import { getDatabaseConfig, requireResult } from "../src/database.js";
import { assertTransition } from "../src/pipeline-states.js";

test("getDatabaseConfig returns trimmed server credentials", () => {
  assert.deepEqual(
    getDatabaseConfig({
      SUPABASE_URL: " https://project.supabase.co ",
      SUPABASE_SECRET_KEY: " secret ",
    }),
    {
      url: "https://project.supabase.co",
      secretKey: "secret",
    },
  );
});

test("getDatabaseConfig rejects missing server secret", () => {
  assert.throws(
    () => getDatabaseConfig({ SUPABASE_URL: "https://project.supabase.co" }),
    /SUPABASE_SECRET_KEY is required/,
  );
});

test("requireResult returns data and normalizes errors", () => {
  assert.deepEqual(requireResult({ data: [{ id: 1 }], error: null }, "Read"), [
    { id: 1 },
  ]);
  assert.throws(
    () => requireResult({ data: null, error: new Error("denied") }, "Read"),
    /Read failed: denied/,
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
