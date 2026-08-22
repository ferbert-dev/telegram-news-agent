import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { EvidenceCurationService, InvalidNewsCandidateCurationError } from "../../src/research/curation/evidence-curation.engine.js";
import { PinnedEvidenceHttpTransport } from "../../src/research/curation/evidence-curation.http.js";
import { EvidenceCurationModule } from "../../src/research/curation/evidence-curation.module.js";
import { evaluateStoryDuplicate as legacyDedup, storyFingerprint as legacyFingerprint } from "../../src/story-deduplication.js";
import { extractArticleText as legacyExtract } from "../../src/article-extractor.js";
import { selectCurationSample as legacySample } from "../../src/news-curation.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const sleep = { async sleep() {} };
function service(fetch = async () => new Response("", { status: 200, headers: { "content-type": "text/html" } })) {
  return new EvidenceCurationService(publicDns, { fetchPinned: fetch }, sleep);
}
const article = "The research team announced a new artificial intelligence model with documented evaluation results and limitations. ".repeat(4);
const prior = {
  article_id: "published-1", title: "Kimi AI model escaped cybersecurity testing",
  feed_summary: "Researchers reported Kimi tried to bypass its test harness.",
  message_text: "A Kimi model attempted to escape a controlled cybersecurity evaluation.",
  telegram_channel_id: "@channel", telegram_message_id: 1, published_at: "2026-08-07T08:00:00.000Z", story_fingerprint: null,
};

test("typed safe fetch preserves hostile DNS and redirect guards", async () => {
  const blocked = new EvidenceCurationService(async () => [{ address: "::ffff:127.0.0.1", family: 6 }], { fetchPinned: async () => { throw new Error("must not fetch"); } }, sleep);
  await assert.rejects(blocked.fetchPublicHttp("https://example.com"), /not allowed/);
  const requests: string[] = [];
  const pinned: unknown[][] = [];
  const redirecting = new EvidenceCurationService(async (hostname) => [{ address: hostname === "public.example" ? "93.184.216.34" : "10.0.0.1", family: 4 }], { fetchPinned: async (url, _init, addresses) => { requests.push(url.href); pinned.push(addresses); return new Response(null, { status: 302, headers: { location: "https://internal.example" } }); } }, sleep);
  await assert.rejects(redirecting.fetchPublicHttp("https://public.example"), /not allowed/);
  assert.deepEqual(requests, ["https://public.example/"]);
  assert.deepEqual(pinned, [[{ address: "93.184.216.34", family: 4 }]]);
});

test("native evidence transport connects only to the validated address", async (context) => {
  let expectedHost = "";
  const server = createServer((request, response) => {
    assert.equal(request.headers.host, expectedHost);
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<article><p>${article}</p></article>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  expectedHost = `rebind.invalid:${address.port}`;
  const response = await new PinnedEvidenceHttpTransport().fetchPinned(
    new URL(`http://${expectedHost}/story`),
    {},
    [{ address: "127.0.0.1", family: 4 }],
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /research team/);
});

test("typed extraction, retry, fact provenance and sampling match legacy contracts", async () => {
  const typed = service(async () => new Response(`<article><p>${article}</p></article>`, { status: 200, headers: { "content-type": "text/html" } }));
  const html = `<nav>ignore</nav><article><h1>Evidence</h1><p>${article}</p></article>`;
  assert.equal(typed.extractArticleText(html), legacyExtract(html));
  const postContent = `<body><div class="post-content"><p>${article}</p></div><aside><p>${"sidebar noise should never become evidence ".repeat(10)}</p></aside><template><p>${"template noise ".repeat(20)}</p></template><svg><text>${"svg noise ".repeat(20)}</text></svg></body>`;
  assert.equal(typed.extractArticleText(postContent), legacyExtract(postContent));
  assert.doesNotMatch(typed.extractArticleText(postContent), /sidebar noise|template noise|svg noise/);
  const fetched = await typed.fetchArticle("https://example.com/story");
  assert.equal(fetched.contentHash.length, 64);
  const delays: number[] = [];
  const samples = [0, 1];
  const retrying = new EvidenceCurationService(publicDns, { fetchPinned: async () => new Response() }, { async sleep(delay) { delays.push(delay); } }, undefined, undefined, undefined, undefined, 3, () => samples.shift() ?? .5);
  let calls = 0;
  assert.equal(await retrying.withRetry(async () => { if (++calls < 3) throw new Error("temporary"); return "ok"; }, { baseDelayMs: 10, jitterRatio: .5 }), "ok");
  assert.deepEqual(delays, [5, 30]);
  assert.deepEqual(typed.groundedFactEvidence({ fact: { claim: "Verified", sourceUrl: "https://example.com/evidence/", sourceTitle:"Official evidence", sourceKind:"official", evidenceText: "Proof" } }, ["https://example.com/evidence"]), { fact: { claim: "Verified", sourceUrl: "https://example.com/evidence", sourceTitle:"Official evidence", sourceKind:"official", evidenceText: "Proof" } });
  const candidates = ["one", "one", "two"].map((publisher, index) => ({ canonicalUrl: `https://${publisher}.example/${index}`, title: `Story ${index}`, publisher }));
  assert.deepEqual(typed.selectCurationSample(candidates, 3), legacySample(candidates, 3));
});

test("typed extraction cancels a chunked response as soon as maxBytes is exceeded", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345678"));
      controller.enqueue(new TextEncoder().encode("abcdefgh"));
    },
    cancel() { cancelled = true; },
  });
  const typed = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response(body, { headers: { "content-type": "text/html" } }) },
    sleep,
  );
  await assert.rejects(typed.fetchArticle("https://example.com/story", { maxBytes: 10 }), /exceeds 10 bytes/);
  assert.equal(cancelled, true);
});

test("typed dedup matches legacy deterministic and fail-closed semantic outcomes", async () => {
  const candidate = { title: prior.title, summary: prior.feed_summary };
  const fingerprint = legacyFingerprint(candidate);
  const stories = [{ ...prior, story_fingerprint: fingerprint }];
  const typed = service();
  const typedDecision = await typed.evaluateStoryDuplicate(candidate, stories);
  const legacyDecision = await legacyDedup({ candidate, publishedStories: stories, aiProvider: null });
  assert.deepEqual(typedDecision.relation, legacyDecision.relation);
  assert.equal(typedDecision.fingerprint, legacyDecision.fingerprint);
  const uncertain = await typed.evaluateStoryDuplicate({ title: "Kimi model test harness report", summary: "A report about attempts to bypass a test harness." }, [prior]);
  assert.equal(uncertain.relation, "uncertain");
  assert.equal(uncertain.decisionSource, "fallback");

  const malformed = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response() },
    sleep,
    { async generateStructured() { return { value: { relation: "distinct", matchedPublishedArticleId: null, confidence: 2, reason: "" } }; } },
  );
  const malformedDecision = await malformed.evaluateStoryDuplicate(
    { title: "Kimi model test harness report", summary: "A report about attempts to bypass a test harness." },
    [prior],
  );
  assert.equal(malformedDecision.relation, "uncertain");
  assert.equal(malformedDecision.decisionSource, "fallback");
});

test("typed dedup can read and persist recent history decisions", async () => {
  const seen: string[] = [];
  const seenSince: Array<string | Date> = [];
  const calls = {
    list: 0 as number,
    record: 0 as number,
  };
  const persistence = {
    async listRecentPublishedStories(input: { channelId: string | null; since: string | Date; limit?: number; }) {
      seen.push(`${input.channelId ?? "null"}:${input.limit ?? 100}`);
      seenSince.push(input.since);
      calls.list += 1;
      return [{ ...prior, story_fingerprint: legacyFingerprint({ title: prior.title, summary: prior.feed_summary }) }];
    },
    async recordStoryDedupDecision(input: { articleId: string; relation: string }) {
      calls.record += 1;
      assert.equal(input.articleId, "article-1");
      return {
        article_id: input.articleId,
        story_fingerprint: input.relation === "distinct" ? "no-dedup" : "dedup",
        relation: input.relation,
        duplicate_of_article_id: null,
        confidence: "1",
        reason: "unit",
        decision_source: "deterministic",
        metadata: { recentCandidates: 1, semanticAttemptLimit: 3 },
        decided_at: "2026-08-22T00:00:00.000Z",
        updated_at: "2026-08-22T00:00:00.000Z",
      };
    },
  };
  const fixedNow = new Date("2026-08-22T08:00:00.000Z");
  const service = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response() },
    sleep,
    undefined,
    undefined,
    persistence as never,
    () => fixedNow,
  );
  const result = await service.evaluateStoryDuplicateFromPersistence(
    { title: prior.title, summary: prior.feed_summary },
    "article-1",
    { channelId: "@channel" },
  );
  assert.equal(result.relation, "duplicate");
  assert.equal(calls.list, 1);
  assert.equal(calls.record, 1);
  assert.equal(seen[0], "@channel:100");
  assert.equal(new Date(seenSince[0]).toISOString(), "2026-08-08T08:00:00.000Z");
});

test("typed semantic dedup is single-attempt and enforces a three-call run budget", async () => {
  const attempts = { calls: 0 };
  const provider = {
    async generateStructured() {
      attempts.calls += 1;
      throw new Error("transient provider error");
    },
  };
  const service = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response() },
    { async sleep() {} },
    provider,
  );
  const decision = await service.evaluateStoryDuplicate(
    { title: prior.title, summary: prior.feed_summary },
    [{ ...prior, story_fingerprint: null }],
  );
  assert.equal(attempts.calls, 1);
  assert.equal(decision.relation, "uncertain");
  assert.equal(decision.decisionSource, "fallback");

  const capped = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response() },
    sleep,
    provider,
    undefined,
    { async listRecentPublishedStories() { return [{ ...prior, story_fingerprint:null }]; }, async recordStoryDedupDecision() { throw new Error("persist disabled"); } } as never,
  );
  attempts.calls = 0;
  const budget = capped.createSemanticAttemptBudget();
  const decisions = [];
  for (let index = 0; index < 4; index += 1) {
    decisions.push(await capped.evaluateStoryDuplicateFromPersistence(
      { title: prior.title, summary: prior.feed_summary },
      `article-capped-${index}`,
      { semanticBudget: budget, persist:false },
    ));
  }
  const exhausted = decisions[3];
  assert.equal(attempts.calls, 3);
  assert.equal(budget.used, 3);
  assert.equal(exhausted.classifierAttempted, false);
  assert.equal(exhausted.relation, "uncertain");

  const noBudget = await capped.evaluateStoryDuplicateFromPersistence(
    { title: prior.title, summary: prior.feed_summary },
    "article-no-budget",
    { persist:false },
  );
  assert.equal(attempts.calls, 3);
  assert.equal(noBudget.classifierAttempted, false);
});

test("typed fact search fallback only returns evidence after provenance check", async () => {
  let searchQuery: string | null = null;
  const typed = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response() },
    sleep,
    undefined,
    { async searchFact(input) {
      searchQuery = input.query;
      return { value:{ fact: { claim: "Verified fact", sourceUrl: "https://example.com/evidence/", sourceTitle:"Evidence", sourceKind:"official", evidenceText: "Verified" } }, sourceUrls:["https://example.com/evidence"], provider:"exa", model:"exa-test", usageEvents:[] };
    } },
  );
  const trusted = await typed.resolveFactEvidence({ fact: { claim: "Verified", sourceUrl: "https://example.com/evidence", sourceTitle:"Evidence", sourceKind:"academic", evidenceText: "direct" } }, ["https://example.com/evidence"]);
  assert.equal(trusted.fact?.claim, "Verified");
  const fallback = await typed.resolveFactEvidence({ fact: {} }, ["https://example.com/evidence"], { query:"probe this", expectedClaim:"Verified fact", languageCode:"en" });
  assert.equal(searchQuery, "probe this");
  assert.equal(fallback.fact?.sourceUrl, "https://example.com/evidence");
  assert.equal(fallback.provider, "exa");
  const hostilePort = new EvidenceCurationService(publicDns, { fetchPinned: async () => new Response() }, sleep, undefined, { async searchFact() { return { value:{ fact:{ claim:"Bad", sourceUrl:"https://attacker.example", sourceTitle:"Bad", sourceKind:"reputable_news", evidenceText:"Bad" } }, sourceUrls:["https://trusted.example"] }; } });
  const rejected = await hostilePort.resolveFactEvidence({ fact: {} }, [], { query:"probe", expectedClaim:"claim" });
  assert.equal(rejected.fact, null);
});

test("EvidenceCurationModule exposes replaceable provider ports without wiring legacy runtime", () => {
  const factSearch = { async searchFact() { return { value:{ fact:null }, sourceUrls:[] }; } };
  const module = EvidenceCurationModule.register({ factSearch, semanticAttemptLimit:9 });
  assert.equal(module.module, EvidenceCurationModule);
  assert.equal(module.exports?.includes(EvidenceCurationService), true);
  assert.equal(module.imports?.length, 1);
  assert.equal(module.providers?.length, 10);
});

test("typed candidate curation rejects unknown IDs and preserves recognized ordering", async () => {
  const candidates = ["one", "two"].map((publisher, index) => ({ canonicalUrl: `https://${publisher}.example/${index}`, title: `Story ${index}`, publisher }));
  const generated = { async generateStructured() { return { value: { rankedCandidateIds: ["candidate-2", "candidate-1"] }, provider: "test", model: "test", usageEvents: [] }; } };
  const typed = new EvidenceCurationService(publicDns, { fetchPinned: async () => new Response() }, sleep, generated);
  assert.deepEqual((await typed.curateNewsCandidates(candidates)).candidates.map((candidate) => candidate.canonicalUrl), ["https://two.example/1", "https://one.example/0"]);
  const usageEvents = [{ provider:"openai", model:"test", operation:"feed_candidate_curation", inputTokens:5 }];
  const invalid = new EvidenceCurationService(publicDns, { fetchPinned: async () => new Response() }, sleep, { async generateStructured() { return { value: { rankedCandidateIds: ["candidate-3"] }, usageEvents }; } });
  await assert.rejects(
    invalid.curateNewsCandidates(candidates),
    (error) => error instanceof InvalidNewsCandidateCurationError
      && error.code === "invalid_candidate_ids"
      && error.usageEvents[0]?.provider === "openai",
  );

  const thirteen = Array.from({ length: 13 }, (_value, index) => ({ canonicalUrl:`https://publisher-${index}.example/story`, title:`Story ${index}`, publisher:`publisher-${index}` }));
  const overLimit = new EvidenceCurationService(publicDns, { fetchPinned: async () => new Response() }, sleep, { async generateStructured() { return { value: { rankedCandidateIds: thirteen.map((_candidate,index)=>`candidate-${index+1}`) }, usageEvents }; } });
  await assert.rejects(
    overLimit.curateNewsCandidates(thirteen),
    (error) => error instanceof InvalidNewsCandidateCurationError
      && error.code === "invalid_candidate_ids"
      && error.usageEvents[0]?.inputTokens === 5,
  );
});
