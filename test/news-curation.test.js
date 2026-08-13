import assert from "node:assert/strict";
import test from "node:test";
import {
  curateNewsCandidates,
  InvalidNewsCandidateCurationError,
  selectCurationSample,
} from "../src/news-curation.js";

function candidate(id, publisher) {
  return {
    title: `Story ${id}`,
    canonicalUrl: `https://${publisher}.example/${id}`,
    publishedAt: "2026-08-07T12:00:00Z",
    summary: `<p>Summary ${id}</p>`,
    publisher,
    score: 90 - id,
    source: {
      name: publisher,
      topic_codes: ["world"],
      reliability_score: 90,
    },
  };
}

test("selectCurationSample gives independent publishers the first pass", () => {
  const candidates = [
    candidate(1, "one"),
    candidate(2, "one"),
    candidate(3, "two"),
  ];

  assert.deepEqual(
    selectCurationSample(candidates, 3).map((item) => item.canonicalUrl),
    [
      "https://one.example/1",
      "https://two.example/3",
      "https://one.example/2",
    ],
  );
});

test("curateNewsCandidates ranks supplied IDs without using web search", async () => {
  const calls = [];
  const candidates = [candidate(1, "one"), candidate(2, "two")];
  const result = await curateNewsCandidates({
    candidates,
    newsSettings: {
      languageCode: "de",
      topicCodes: ["world"],
      customTopics: [],
    },
    aiProvider: {
      async generateStructured(request) {
        calls.push(request);
        return {
          value: {
            rankedCandidateIds: ["candidate-2", "candidate-1"],
          },
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [{ operation: "feed_candidate_curation" }],
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].usageOperation, "feed_candidate_curation");
  assert.equal(calls[0].input.outputLanguage, "German");
  assert.match(calls[0].systemInstruction, /do not browse/i);
  assert.deepEqual(
    result.candidates.slice(0, 2).map((item) => item.canonicalUrl),
    ["https://two.example/2", "https://one.example/1"],
  );
  assert.equal(result.consideredCount, 2);
  assert.equal(result.rankedCount, 2);
});

test("curation rejects unknown or duplicate IDs instead of resurrecting an ineligible candidate", async () => {
  const candidates = [candidate(1, "one")];
  for (const rankedCandidateIds of [
    ["candidate-1", "candidate-2"],
    ["candidate-1", "candidate-1"],
  ]) {
    let error;
    await assert.rejects(
      curateNewsCandidates({
        candidates,
        newsSettings: {
          languageCode: "en",
          topicCodes: ["world"],
          customTopics: [],
        },
        aiProvider: {
          async generateStructured() {
            return {
              value: { rankedCandidateIds },
              provider: "configured-provider",
              model: "configured-model",
              usageEvents: [
                {
                  provider: "configured-provider",
                  providerResponseId: "curation-response",
                  operation: "feed_candidate_curation",
                  rawProviderOutput: "must-not-escape",
                },
              ],
            };
          },
        },
      }),
      (value) => {
        error = value;
        return /invalid candidate IDs/.test(value.message);
      },
    );
    assert.equal(error instanceof InvalidNewsCandidateCurationError, true);
    assert.equal(error.code, "invalid_candidate_ids");
    assert.equal(error.usageEvents.length, 1);
    assert.equal(error.usageEvents[0].providerResponseId, "curation-response");
    assert.equal(
      Object.hasOwn(error.usageEvents[0], "rawProviderOutput"),
      false,
    );
  }
});
