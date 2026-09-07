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
import { tierOf } from "../../src/editorial/corroboration/source-policy.js";

const service = () =>
  new EvidenceCorroborationService(DEFAULT_CORROBORATION_OPTIONS);

const rumour: CorroborationEvidence[] = [
  {
    url: "https://forum.example.com/thread/1",
    text: "A forum account says the deal is signed.",
    primary: false,
    verificationStatus: "unverified_community",
  },
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
      return {
        sources: url ? [{ url, title: "t", excerpt: "e", tier: tierOf(url) ?? "other" }] : [],
      };
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
      return {
        sources: (pages[i++] ?? []).map((url) => ({
          url,
          title: "t",
          excerpt: "e",
          tier: tierOf(url) ?? "other",
        })),
      };
    },
  };
}

test("nothing to ask means nothing is spent", async () => {
  const search = factSearch([]);
  const outcome = await service().corroborate({
    evidence: [
      {
        url: "https://acme.example/post",
        text: "Acme published the announcement.",
        primary: true,
        verificationStatus: "primary_source",
      },
    ],
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
    {
      url: "https://acme.example/pr",
      text: "Acme announced the acquisition.",
      primary: true,
      verificationStatus: "primary_source" as const,
    },
  ];
  const outcome = await service().corroborate({
    evidence: primary,
    requests,
    languageCode: "en",
    search: factSearch(["https://www.reuters.com/world/a", "https://apnews.com/article/b"]),
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
    "https://www.reuters.com/world/a",
    "https://apnews.com/article/b",
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
  assert.deepEqual(outcome.publishers, ["reuters.com", "apnews.com"]);

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
    ["https://www.reuters.com/world/a", "https://apnews.com/article/b"],
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

test("a deduplication failure costs one candidate, not the whole run", async () => {
  const { TypedResearchExecutionGateway } = await import(
    "../../src/research/typed-research-execution.gateway.js"
  );
  // Reaching the real gateway needs its whole dependency set, so the property
  // is asserted where it is decided instead: evaluateStoryDuplicate throwing
  // must not escape the candidate loop.
  const source = (
    await import("node:fs")
  ).readFileSync(
    new URL("../../src/research/typed-research-execution.gateway.ts", import.meta.url),
    "utf8",
  );

  assert.ok(TypedResearchExecutionGateway, "gateway must load");
  const call = source.slice(
    source.indexOf("storyDecision = await this.curation.evaluateStoryDuplicate"),
  );
  const guard = source.slice(
    source.indexOf("try {", source.indexOf("let storyDecision")),
    source.indexOf("storyDecision = await this.curation.evaluateStoryDuplicate"),
  );

  assert.ok(guard.includes("try {"), "the deduplication call must be guarded");
  const handler = call.slice(0, call.indexOf("await this.storyDedup"));
  assert.ok(
    handler.includes("catch") && handler.includes("continue"),
    "a failure must skip the candidate rather than propagate",
  );
  assert.ok(
    handler.includes("deduplicationRejectedArticleIds"),
    "a candidate whose duplicate check failed must not be treated as new",
  );
});

test("an unvetted publisher contributes detail without clearing the story", async () => {
  // The change this module exists for, stated as behaviour.
  //
  // The frozen `normalizeFactResult` discarded every result outside about
  // forty domains, so a Miami runway crash covered by the Miami Herald, CNN
  // and local broadcasters produced fifteen paid candidates and an article
  // citing one source -- the one it started with.
  //
  // Those publishers now reach the evidence, so the article can use and
  // attribute what they reported. They do not clear the story: the caveat is
  // still earned by two STRONG publishers and by nothing else.
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: listSearch([
      ["https://www.miamiherald.com/news/a", "https://www.cnn.com/2026/09/b"],
    ]),
  });

  assert.equal(outcome.status, "uncorroborated");
  assert.deepEqual(
    outcome.status === "uncorroborated" ? outcome.strongPublishers : null,
    [],
    "neither is a vetted publisher",
  );
  assert.deepEqual(outcome.publishers, ["miamiherald.com", "cnn.com"]);

  const urls = outcome.evidence.map((item) => item.url);
  assert.ok(
    urls.includes("https://www.miamiherald.com/news/a")
      && urls.includes("https://www.cnn.com/2026/09/b"),
    `both must reach the article as material to write from; got ${JSON.stringify(urls)}`,
  );
  assert.ok(
    outcome.evidence.every((item) => (item.text ?? "").length > 0),
    "and each with readable text, not as a bare link",
  );
});

test("one strong publisher is not two, and the story stays uncleared", async () => {
  // The threshold is unchanged by the tiers. Mixing an unvetted publisher in
  // must not become a way to reach two.
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: listSearch([
      ["https://www.reuters.com/world/a", "https://www.miamiherald.com/news/b"],
    ]),
  });

  assert.equal(outcome.status, "uncorroborated");
  assert.deepEqual(
    outcome.status === "uncorroborated" ? outcome.strongPublishers : null,
    ["reuters.com"],
  );
  assert.equal(outcome.evidence.length, rumour.length + 2, "both still supply detail");
});

test("searching stops once two strong publishers agree, not once two are found", async () => {
  // The budget guard follows the tier that matters. Stopping on any two would
  // spend the story's whole budget on publishers that cannot clear it.
  const seen: string[] = [];
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: listSearch(
      [
        ["https://www.miamiherald.com/news/a"],
        ["https://www.cnn.com/2026/09/b"],
        ["https://www.reuters.com/world/c", "https://apnews.com/article/d"],
      ],
      seen,
    ),
  });

  assert.equal(outcome.status, "corroborated");
  assert.deepEqual(
    outcome.status === "corroborated" ? outcome.strongPublishers : null,
    ["reuters.com", "apnews.com"],
  );
  assert.equal(seen.length, 3, "it kept searching while only weak sources had answered");
});

test("a source older than the window is discarded, however relevant it is", async () => {
  // A published article about a typhoon carried a forecast lifted from a press
  // conference four days earlier -- "residual circulation after 4 September
  // may bring heavy rain" -- printed on the 7th as though it were ahead of the
  // reader. The search had found a genuinely relevant document and nothing
  // anywhere asked when it was written.
  const now = new Date("2026-09-07T12:00:00Z");
  const dated = (url: string, publishedAt: string | null) => ({
    async find() {
      return {
        sources: [{
          url,
          title: "t",
          excerpt: "e",
          tier: tierOf(url) ?? ("other" as const),
          publishedAt,
        }],
      };
    },
  });

  const stale = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: dated("https://www.reuters.com/world/a", "2026-09-03T09:00:00Z"),
    now: () => now,
  });
  assert.equal(stale.evidence.length, rumour.length, "four days old is dropped");

  const fresh = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: dated("https://www.reuters.com/world/a", "2026-09-06T09:00:00Z"),
    now: () => now,
  });
  assert.equal(fresh.evidence.length, rumour.length + 1, "yesterday still corroborates");
});

test("a source with no date is kept, and the pipeline can see it has none", async () => {
  // Deliberate, and the trade is worth stating: the provider cannot always
  // estimate a date, and it fails most often on primary documents -- filings,
  // press releases -- which are the sources most worth having. Dropping every
  // undated result would cost more than it saves. The hole is real: a stale
  // source with no date still gets through.
  const outcome = await service().corroborate({
    evidence: rumour,
    requests,
    languageCode: "en",
    search: {
      async find() {
        return {
          sources: [{
            url: "https://storage.courtlistener.com/recap/filing.pdf",
            title: "t",
            excerpt: "e",
            tier: "other" as const,
            publishedAt: null,
          }],
        };
      },
    },
    now: () => new Date("2026-09-07T12:00:00Z"),
  });

  assert.equal(outcome.evidence.length, rumour.length + 1);
  assert.equal(
    outcome.evidence.at(-1)?.publishedAt,
    null,
    "and it reaches the model marked as undated, so the date can be judged there too",
  );
});
