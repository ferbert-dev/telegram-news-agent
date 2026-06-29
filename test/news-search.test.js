import assert from "node:assert/strict";
import test from "node:test";
import {
  runCheckpointedNewsSearch,
  runTieredNewsSearch,
} from "../src/news-search.js";
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

test("checkpointed news search resumes without running research again", async () => {
  let workflowCalls = 0;
  const repository = {
    async getTelegramNewsCheckpoint() {
      return {
        status: "review_ready",
        draft_id: "draft-existing",
        preview: "Existing preview",
        window_hours: 168,
      };
    },
  };
  const result = await runCheckpointedNewsSearch({
    updateId: 10,
    repository,
    aiClient: {},
    model: "model",
    runWorkflow: async () => {
      workflowCalls += 1;
    },
  });

  assert.equal(workflowCalls, 0);
  assert.equal(result.draftId, "draft-existing");
  assert.equal(result.resumed, true);
});

test("checkpointed news search saves the completed draft before returning", async () => {
  const writes = [];
  const repository = {
    async getTelegramNewsCheckpoint() {
      return null;
    },
    async saveTelegramNewsCheckpoint(checkpoint) {
      writes.push(checkpoint);
      return checkpoint;
    },
  };
  const result = await runCheckpointedNewsSearch({
    updateId: 11,
    repository,
    aiClient: {},
    model: "model",
    runWorkflow: async () => ({
      draft: { id: "draft-new" },
      preview: "New preview",
    }),
  });

  assert.equal(writes[0].update_id, 11);
  assert.equal(writes[0].draft_id, "draft-new");
  assert.equal(result.resumed, false);
});
