import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateExcludedTopics,
  EXCLUDED_TOPIC_RELATIONS,
  EXCLUDED_TOPIC_TAXONOMY,
  normalizeExcludedTopicCodes,
} from "../src/excluded-topics.js";

test("excluded-topic taxonomy is canonical, provider-neutral, and supports the explicit kill switch", () => {
  assert.deepEqual(Object.keys(EXCLUDED_TOPIC_TAXONOMY), ["war_conflict"]);
  assert.deepEqual(EXCLUDED_TOPIC_RELATIONS, [
    "main_subject",
    "incidental",
    "unrelated",
    "uncertain",
  ]);
  assert.deepEqual(
    normalizeExcludedTopicCodes([" WAR_CONFLICT ", "war_conflict"]),
    ["war_conflict"],
  );
  assert.deepEqual(normalizeExcludedTopicCodes([]), []);
  assert.throws(
    () => normalizeExcludedTopicCodes(["free form"]),
    /Unknown excluded topic code/,
  );
});

test("excluded-topic evaluator normalizes provider results without wiring a provider", async () => {
  let request;
  const assessments = await evaluateExcludedTopics({
    article: { title: "Verified article", text: "Grounded text" },
    excludedTopicCodes: ["war_conflict"],
    classify: async (value) => {
      request = value;
      return {
        assessments: [
          { topicCode: " WAR_CONFLICT ", relation: "MAIN_SUBJECT" },
        ],
      };
    },
  });

  assert.equal(typeof request.classify, "undefined");
  assert.deepEqual(request.topicCodes, ["war_conflict"]);
  assert.deepEqual(assessments, [
    { topicCode: "war_conflict", relation: "main_subject" },
  ]);
});

test("unknown, malformed, missing, and exhausted classifier results fail closed to uncertain", async () => {
  for (const classify of [
    async () => ({ assessments: [{ topicCode: "war_conflict", relation: "opinion" }] }),
    async () => ({ assessments: "malformed" }),
    async () => ({ assessments: [] }),
    async () => {
      throw new Error("provider exhausted");
    },
  ]) {
    assert.deepEqual(
      await evaluateExcludedTopics({
        article: { title: "Article", text: "Text" },
        excludedTopicCodes: ["war_conflict"],
        classify,
      }),
      [{ topicCode: "war_conflict", relation: "uncertain" }],
    );
  }
});

test("duplicate and unknown classifier topic IDs fail the complete requested evaluation closed", async () => {
  for (const assessments of [
    [
      { topicCode: "war_conflict", relation: "main_subject" },
      { topicCode: "war_conflict", relation: "unrelated" },
    ],
    [
      { topicCode: "war_conflict", relation: "main_subject" },
      { topicCode: "invented", relation: "unrelated" },
    ],
  ]) {
    assert.deepEqual(
      await evaluateExcludedTopics({
        article: { title: "Article", text: "Text" },
        excludedTopicCodes: ["war_conflict"],
        classify: async () => ({ assessments }),
      }),
      [{ topicCode: "war_conflict", relation: "uncertain" }],
    );
  }
});

test("empty exclusions skip the classifier entirely", async () => {
  let called = false;
  assert.deepEqual(
    await evaluateExcludedTopics({
      article: {},
      excludedTopicCodes: [],
      classify: async () => {
        called = true;
      },
    }),
    [],
  );
  assert.equal(called, false);
});
