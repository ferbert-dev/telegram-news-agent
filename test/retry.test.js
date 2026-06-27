import assert from "node:assert/strict";
import test from "node:test";
import { withRetry } from "../src/retry.js";

test("withRetry retries transient failures with exponential delays", async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("temporary");
      }
      return "ok";
    },
    {
      attempts: 3,
      baseDelayMs: 10,
      sleep: async (delay) => delays.push(delay),
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("withRetry stops when the error is not retryable", async () => {
  let calls = 0;

  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("permanent");
      },
      { shouldRetry: () => false },
    ),
    /permanent/,
  );
  assert.equal(calls, 1);
});
