import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CORROBORATION_OPTIONS,
  EvidenceCorroborationService,
  RUMOUR_TAG,
} from "../../src/editorial/corroboration/evidence-corroboration.service.js";
import type {
  CorroborationEvidence,
  FactRequest,
} from "../../src/editorial/corroboration/evidence-corroboration.contracts.js";

const service = () =>
  new EvidenceCorroborationService(DEFAULT_CORROBORATION_OPTIONS);

const rumour: CorroborationEvidence[] = [
  { sourceUrl: "https://forum.example.com/thread/1", verificationStatus: "unverified_community" },
];

const requests: FactRequest[] = [
  { query: "first", reason: "r", expectedClaim: "c" },
  { query: "second", reason: "r", expectedClaim: "c" },
  { query: "third", reason: "r", expectedClaim: "c" },
  { query: "fourth", reason: "r", expectedClaim: "c" },
];

function factSearch(urls: Array<string | null>, seen: string[] = []) {
  let i = 0;
  return {
    seen,
    async searchFact(input: { query: string }) {
      seen.push(input.query);
      const url = urls[i++] ?? null;
      return { value: { fact: url ? { sourceUrl: url, sourceTitle: "t", evidenceText: "e" } : null } };
    },
  };
}

test("a story already resting on a primary source costs no searches at all", async () => {
  const search = factSearch([]);
  const outcome = await service().corroborate({
    evidence: [{ sourceUrl: "https://acme.example/post", verificationStatus: "primary_source" }],
    requests,
    languageCode: "en",
    factSearch: search,
  });

  assert.equal(outcome.status, "not_needed");
  // The month's Exa budget must not be spent on the articles that least need
  // it -- this is the assertion that keeps that true.
  assert.equal(outcome.searches, 0);
  assert.deepEqual(search.seen, []);
});

test("the model's own queries are used, in its order, and only up to the budget", async () => {
  const search = factSearch([null, null, null, null]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: search,
  });

  // The model chooses the questions; the budget chooses how many get asked.
  assert.deepEqual(search.seen, ["first", "second", "third"]);
  assert.equal(outcome.searches, DEFAULT_CORROBORATION_OPTIONS.maxSearches);
  assert.equal(outcome.status, "uncorroborated");
});

test("two independent publishers clear the story, and searching stops there", async () => {
  const search = factSearch([
    "https://reuters.example/a",
    "https://apnews.example/b",
    "https://third.example/c",
  ]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: search,
  });

  assert.equal(outcome.status, "corroborated");
  // Stopped at two: the threshold is a stopping condition, not a quota to burn.
  assert.equal(outcome.searches, 2);
  assert.deepEqual(outcome.publishers, ["reuters.example", "apnews.example"]);

  if (outcome.status !== "corroborated") return;
  // Every original must leave unverified_community behind: draft.js takes the
  // WEAKEST status in the set, so one straggler keeps the caveat.
  assert.ok(
    outcome.evidence.every((item) => item.verificationStatus !== "unverified_community"),
  );
  assert.equal(outcome.evidence.length, 3);
});

test("more pages from the same publisher are one source, not two", async () => {
  const search = factSearch([
    "https://blog.example/a",
    "https://www.blog.example/b",
    "https://blog.example/c",
  ]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: search,
  });

  // www. is the same newsroom, and a newsroom cannot corroborate itself.
  assert.equal(outcome.status, "uncorroborated");
  assert.deepEqual(outcome.publishers, ["blog.example"]);
});

test("the publisher that broke the rumour cannot corroborate it", async () => {
  const search = factSearch([
    "https://forum.example.com/thread/2",
    "https://forum.example.com/thread/3",
    "https://forum.example.com/thread/4",
  ]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: search,
  });

  assert.equal(outcome.status, "uncorroborated");
  assert.deepEqual(outcome.publishers, []);
});

test("an uncorroborated story is published with a tag, never suppressed", async () => {
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: factSearch([null, null, null]),
  });

  assert.equal(outcome.status, "uncorroborated");
  if (outcome.status !== "uncorroborated") return;
  assert.equal(outcome.tag, RUMOUR_TAG);
  // The heavy legacy caveat must not fire: draft.js reads the evidence, so the
  // originals are cleared here even though nothing corroborated them. That is
  // the trade the operator chose, and it is asserted rather than implied.
  assert.ok(
    outcome.evidence.every((item) => item.verificationStatus !== "unverified_community"),
  );
});

test("a search that throws spends its budget and does not retry the same question", async () => {
  const seen: string[] = [];
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    factSearch: {
      async searchFact(input: { query: string }) {
        seen.push(input.query);
        throw new Error("provider down");
      },
    },
  });

  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.equal(outcome.searches, 3);
  assert.equal(outcome.status, "uncorroborated");
});
