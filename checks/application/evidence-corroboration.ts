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

// One call, zero or one source -- what our AI searchFact can return.
function factSearch(urls: Array<string | null>, seen: string[] = []) {
  let i = 0;
  return {
    seen,
    async find(request: FactRequest) {
      seen.push(request.query);
      const url = urls[i++] ?? null;
      return url ? [{ url, title: "t", excerpt: "e" }] : [];
    },
  };
}

// A provider that answers with a list, as most search APIs do.
function listSearch(pages: string[][], seen: string[] = []) {
  let i = 0;
  return {
    seen,
    async find(request: FactRequest) {
      seen.push(request.query);
      return (pages[i++] ?? []).map((url) => ({ url, title: "t", excerpt: "e" }));
    },
  };
}

test("nothing to ask means nothing is spent", async () => {
  const search = factSearch([]);
  const outcome = await service().corroborate({
    evidence: [{ sourceUrl: "https://acme.example/post", verificationStatus: "primary_source" }],
    requests: [],
    languageCode: "en",
    search,
  });

  // `not_needed` no longer means "primary source" -- searches run for every
  // article now. It means the model asked for nothing.
  assert.equal(outcome.status, "not_needed");
  assert.equal(outcome.searches, 0);
  assert.deepEqual(search.seen, []);
});

test("a primary-source article is searched too, and keeps its status", async () => {
  const primary = [
    { sourceUrl: "https://acme.example/pr", verificationStatus: "primary_source" as const },
  ];
  const outcome = await service().corroborate({
    evidence: primary,
    requests,
    languageCode: "en",
    search: factSearch(["https://reuters.example/a", "https://apnews.example/b"]),
  });

  assert.equal(outcome.status, "corroborated");
  if (outcome.status !== "corroborated") return;
  // The extra sources are what the draft writes from. The original must not be
  // downgraded from primary_source on its way through.
  assert.equal(outcome.evidence.length, 3);
  assert.equal(outcome.evidence[0].verificationStatus, "primary_source");
});

test("the model's own queries are used, in its order, and only up to the budget", async () => {
  const search = factSearch([null, null, null, null]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search,
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
    search,
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
    search,
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
    search,
  });

  assert.equal(outcome.status, "uncorroborated");
  assert.deepEqual(outcome.publishers, []);
});

test("an uncorroborated story gains sources but keeps its caveat", async () => {
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: factSearch(["https://only.example/a", null, null]),
  });

  assert.equal(outcome.status, "uncorroborated");
  if (outcome.status !== "uncorroborated") return;
  assert.equal(outcome.tag, RUMOUR_TAG);

  // The found source is added -- the draft has more to write from, which is
  // why every article is searched now. But the original KEEPS
  // unverified_community, so draft.js still applies the caveat.
  //
  // Clearing it while the #rumor tag does not reach the published text would
  // put a rumour in the channel unmarked. That is what this assertion exists
  // to prevent.
  assert.equal(outcome.evidence.length, 2);
  assert.equal(outcome.evidence[0].verificationStatus, "unverified_community");
});

test("a search that throws spends its budget and does not retry the same question", async () => {
  const seen: string[] = [];
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: {
      async find(request: FactRequest) {
        seen.push(request.query);
        throw new Error("provider down");
      },
    },
  });

  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.equal(outcome.searches, 3);
  assert.equal(outcome.status, "uncorroborated");
});

test("a provider that returns a list can clear a story in one search", async () => {
  const search = listSearch([
    ["https://reuters.example/a", "https://apnews.example/b"],
  ]);
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search,
  });

  assert.equal(outcome.status, "corroborated");
  // One question, two independent publishers. On a metered budget this is the
  // difference between three articles a day and six -- and it is why the port
  // returns a list rather than the single fact our own searchFact gives.
  assert.equal(outcome.searches, 1);
  assert.deepEqual(search.seen, ["first"]);
});
