import assert from "node:assert/strict";
import test from "node:test";
import {
  runCheckpointedNewsSearch,
  runTieredNewsSearch,
} from "../src/news-search.js";
import { NoResearchCandidatesError } from "../src/research.js";

test("tiered news search prefers today's news and stops as soon as it finds some", async () => {
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
  assert.equal(result.tier.windowHours, 24);
  // The wider tiers exist for an empty day, not as extra passes on a normal
  // one. A second call here would mean every run paid for the whole ladder.
  assert.equal(calls.length, 1);
});

test("a quiet day widens by one step rather than jumping to the weekly tier", async () => {
  const windows = [];
  const result = await runTieredNewsSearch({
    repository: {},
    aiClient: {},
    model: "model",
    runWorkflow: async (options) => {
      windows.push(options.windowHours);
      if (options.windowHours === 24) {
        throw new NoResearchCandidatesError("empty");
      }
      return { draft: { id: "yesterday" } };
    },
  });

  assert.deepEqual(windows, [24, 48]);
  assert.equal(result.result.draft.id, "yesterday");
});

test("tiered news search falls back to verified seven-day trends", async () => {
  const windows = [];
  const result = await runTieredNewsSearch({
    repository: {},
    aiClient: {},
    model: "model",
    runWorkflow: async (options) => {
      windows.push(options.windowHours);
      if (options.windowHours < 168) {
        throw new NoResearchCandidatesError("empty");
      }
      return { draft: { id: "weekly-trend" } };
    },
  });

  assert.deepEqual(windows, [24, 48, 168]);
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
  assert.deepEqual(writes[0].settings_snapshot.excludedTopicCodes, [
    "war_conflict",
  ]);
  assert.deepEqual(writes[0].settings_snapshot.excludedTopicsProvenance, {
    source: "news_bot_settings",
    settingsVersion: 1,
  });
  assert.equal(result.resumed, false);
});

test("tiered search passes one normalized settings snapshot into workflow", async () => {
  let received;
  const result = await runTieredNewsSearch({
    repository: {},
    settings: {
      telegram_channel_id: "@channel",
      language_code: "de",
      topic_codes: ["nature", "animals"],
      custom_topics: ["Meeresbiologie"],
      excluded_topic_codes: ["war_conflict"],
      approval_policy: "automatic",
      version: 4,
    },
    telegram: { token: "token", channelId: "@channel" },
    runWorkflow: async (options) => {
      received = options;
      return {
        status: "published",
        draft: { id: "draft-auto" },
        preview: "Vorschau",
        publication: { telegram_message_id: 91 },
      };
    },
  });

  assert.equal(result.result.status, "published");
  assert.equal(received.approvalPolicy, "automatic");
  assert.equal(received.newsSettings.languageCode, "de");
  assert.deepEqual(received.newsSettings.topicCodes, ["nature", "animals"]);
  assert.deepEqual(received.newsSettings.excludedTopicCodes, ["war_conflict"]);
  assert.deepEqual(received.newsSettings.excludedTopicsProvenance, {
    source: "news_bot_settings",
    settingsVersion: 4,
  });
  assert.match(received.query, /Meeresbiologie/);
  assert.match(received.query, /German/);
});

test("checkpointed automatic search persists and returns publication receipt", async () => {
  const saved = [];
  let approved = false;
  const repository = {
    async getTelegramNewsCheckpoint() {
      return null;
    },
    async saveTelegramNewsCheckpoint(checkpoint) {
      saved.push(checkpoint);
      return checkpoint;
    },
    async getDraft() {
      return { id: "draft-published", status: "review" };
    },
    async approveDraft() {
      approved = true;
    },
  };

  const result = await runCheckpointedNewsSearch({
    updateId: 12,
    repository,
    settings: {
      approvalPolicy: "automatic",
      topicCodes: ["world"],
    },
    telegram: { token: "token", channelId: "@channel" },
    runWorkflow: async () => ({
      status: "awaiting_approval",
      draft: { id: "draft-published" },
      preview: "Published preview",
    }),
    publishDraft: async () => ({
      publication: { telegram_message_id: 123 },
    }),
  });

  assert.equal(saved[0].status, "review_ready");
  assert.equal(saved[0].publication_message_id, null);
  assert.equal(saved[1].status, "published");
  assert.equal(saved[1].publication_message_id, 123);
  assert.equal(approved, true);
  assert.equal(result.status, "published");
  assert.equal(result.draftId, "draft-published");
  assert.equal(result.preview, "Published preview");
  assert.equal(result.publicationMessageId, 123);
});

test("automatic checkpoint recovery republishes only the stored draft idempotently", async () => {
  let researched = false;
  let publishedDraft;
  const writes = [];
  const checkpoint = {
    update_id: 13,
    status: "review_ready",
    draft_id: "draft-stored",
    preview: "Stored preview",
    window_hours: 48,
    publication_message_id: null,
    settings_snapshot: {
      approvalPolicy: "automatic",
      topicCodes: ["world"],
    },
  };
  const repository = {
    async getTelegramNewsCheckpoint() { return checkpoint; },
    async getDraft() { return { id: "draft-stored", status: "published" }; },
    async saveTelegramNewsCheckpoint(value) {
      writes.push(value);
      return value;
    },
  };

  const result = await runCheckpointedNewsSearch({
    updateId: 13,
    repository,
    settings: { approvalPolicy: "automatic", topicCodes: ["world"] },
    telegram: { token: "token", channelId: "@channel" },
    runWorkflow: async () => { researched = true; },
    publishDraft: async ({ draftId }) => {
      publishedDraft = draftId;
      return { publication: { telegram_message_id: 321 } };
    },
  });

  assert.equal(researched, false);
  assert.equal(publishedDraft, "draft-stored");
  assert.equal(writes[0].status, "published");
  assert.equal(result.publicationMessageId, 321);
  assert.equal(result.resumed, true);
});
