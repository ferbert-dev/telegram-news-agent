import assert from "node:assert/strict";
import test from "node:test";
import { runTieredNewsSearch } from "../src/news-search.js";
import { NoResearchCandidatesError } from "../src/research.js";

test("tiered news search prefers the 48-hour window", async () => {
  const calls = [];
  const expected = { draft: { id: "draft-1" } };
  const result = await runTieredNewsSearch({
    repository: {},
    aiClient: {},
    model: "model",
    runWorkflow: async (options) => {
      calls.push(options);
      return expected;
    },
  });

  assert.equal(result.result, expected);
  assert.equal(result.tier.windowHours, 48);
  assert.equal(calls.length, 1);
});

test("tiered news search falls back to verified seven-day trends", async () => {
  const windows = [];
  const result = await runTieredNewsSearch({
    repository: {},
    aiClient: {},
    model: "model",
    runWorkflow: async (options) => {
      windows.push(options.windowHours);
      if (options.windowHours === 48) {
        throw new NoResearchCandidatesError("empty");
      }
      return { draft: { id: "weekly-trend" } };
    },
  });

  assert.deepEqual(windows, [48, 168]);
  assert.equal(result.result.draft.id, "weekly-trend");
  assert.match(result.tier.query, /trend/);
});

test("tiered news search does not hide operational failures", async () => {
  await assert.rejects(
    runTieredNewsSearch({
      repository: {},
      aiClient: {},
      model: "model",
      runWorkflow: async () => {
        throw new Error("database unavailable");
      },
    }),
    /database unavailable/,
  );
});
