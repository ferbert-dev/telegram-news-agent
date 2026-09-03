import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { createFallbackAiProvider } from "../../src/ai/ai-provider-composition.js";

/** A 429, shaped the way the classifier recognises it. */
/** Threshold x per-call attempts, plus one call's worth of slack. */
const THROTTLE_BUDGET = 5 * 3 + 3;

function rateLimited() {
  return Object.assign(new Error("Too Many Requests"), { status: 429 });
}

function provider(name: string, behaviour: () => Promise<unknown>) {
  return {
    name,
    model: "test-model",
    async generateStructured() {
      return behaviour();
    },
  };
}

test("a provider that is rate limiting is stopped, not called once per candidate forever", async () => {
  // The storm this prevents, measured from a real run: 344 separate
  // classification calls, each correctly retried 3 times and each correctly
  // giving up -- 1005 requests at 2.8/sec for six minutes, 986 of them 429s.
  // Per-call retry was already bounded. Nothing was bounded ACROSS calls, so a
  // provider saying "stop" was asked 344 more times.
  let requests = 0;
  const ai = createFallbackAiProvider(
    [
      provider("openai", async () => {
        requests += 1;
        throw rateLimited();
      }) as never,
    ],
    { sleep: async () => undefined, log: { warn() {}, info() {} } as never },
  );

  // Simulate the caller: one classification per candidate, many candidates.
  for (let candidate = 0; candidate < 200; candidate += 1) {
    try {
      await ai.generateStructured({ schemaName: "excluded_topic_classification", input: {} } as never);
    } catch {
      /* every call is expected to fail; what matters is how many reached the provider */
    }
  }

  // 200 candidates used to cost 600 requests. With the breaker it costs the
  // handful needed to notice, then nothing.
  assert.ok(
    requests <= THROTTLE_BUDGET,
    `expected the breaker to stop calling a rate-limited provider, but it made ${requests} requests for 200 candidates`,
  );
});

test("the breaker recovers, so a transient burst does not disable the provider for the process", async () => {
  let limited = true;
  let calls = 0;
  let clock = 0;
  const ai = createFallbackAiProvider(
    [
      provider("openai", async () => {
        calls += 1;
        if (limited) throw rateLimited();
        return { value: { ok: true }, usageEvents: [] };
      }) as never,
    ],
    {
      sleep: async () => undefined,
      now: () => new Date(clock),
      log: { warn() {}, info() {} } as never,
    },
  );

  for (let i = 0; i < 40; i += 1) {
    await ai.generateStructured({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  const duringOutage = calls;

  // The limit lifts, and enough time passes for the breaker to re-test.
  limited = false;
  clock += 5 * 60_000;
  const recovered = await ai.generateStructured({ schemaName: "s", input: {} } as never);

  assert.deepEqual((recovered as { value: unknown }).value, { ok: true });
  assert.ok(calls > duringOutage, "the provider must be tried again after the cooldown");
});

test("a non-throttling failure does not open the breaker", async () => {
  // Only "you are asking too often" counts. An ordinary error is a different
  // failure mode, and disabling a provider for it would turn one bad call into
  // a minute of unavailability.
  let calls = 0;
  const ai = createFallbackAiProvider(
    [
      provider("openai", async () => {
        calls += 1;
        throw Object.assign(new Error("upstream exploded"), { status: 500 });
      }) as never,
    ],
    { sleep: async () => undefined, log: { warn() {}, info() {} } as never },
  );

  for (let i = 0; i < 20; i += 1) {
    await ai.generateStructured({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  assert.equal(calls, 60, "every call should still have been attempted three times");
});

test("a healthy call between throttles resets the streak", async () => {
  let mode: "limited" | "ok" = "limited";
  let calls = 0;
  const ai = createFallbackAiProvider(
    [
      provider("openai", async () => {
        calls += 1;
        if (mode === "limited") throw rateLimited();
        return { value: { ok: true }, usageEvents: [] };
      }) as never,
    ],
    { sleep: async () => undefined, log: { warn() {}, info() {} } as never },
  );

  // Four throttled calls -- one short of the threshold.
  for (let i = 0; i < 4; i += 1) {
    await ai.generateStructured({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  mode = "ok";
  await ai.generateStructured({ schemaName: "s", input: {} } as never);
  const afterSuccess = calls;

  // The streak is cleared, so another four throttled calls still do not open it.
  mode = "limited";
  for (let i = 0; i < 4; i += 1) {
    await ai.generateStructured({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  assert.equal(calls, afterSuccess + 12, "the breaker must not still be counting the earlier streak");
});

test("the single-attempt path shares the breaker rather than being invisible to it", async () => {
  // generateStructuredOnce is the non-cascading path, used by semantic story
  // deduplication. It is bounded elsewhere, so it cannot storm on its own --
  // but a 429 there is the same evidence of throttling, and once the breaker is
  // open it must stop calling too.
  let calls = 0;
  const ai = createFallbackAiProvider(
    [
      provider("openai", async () => {
        calls += 1;
        throw rateLimited();
      }) as never,
    ],
    { sleep: async () => undefined, log: { warn() {}, info() {} } as never },
  );

  // Five throttled single-attempt calls reach the threshold...
  for (let i = 0; i < 5; i += 1) {
    await ai.generateStructuredOnce({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  const afterThreshold = calls;
  assert.equal(afterThreshold, 5, "each single-attempt call makes exactly one request");

  // ...and the next ones make no request at all.
  for (let i = 0; i < 10; i += 1) {
    await ai.generateStructuredOnce({ schemaName: "s", input: {} } as never).catch(() => undefined);
  }
  assert.equal(calls, afterThreshold, "an open breaker must stop the single-attempt path too");

  // And the streak it built is shared: the cascading path is open as well.
  await ai.generateStructured({ schemaName: "s", input: {} } as never).catch(() => undefined);
  assert.equal(calls, afterThreshold, "the streak must be shared across both entry points");
});
