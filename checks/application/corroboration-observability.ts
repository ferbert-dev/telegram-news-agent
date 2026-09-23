import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { errorCodeOf } from "../../src/editorial/corroboration/error-code.js";
import { EvidenceCorroborationService } from "../../src/editorial/corroboration/evidence-corroboration.service.js";
import { ExaDailyFactSearchCapError } from "../../src/editorial/corroboration/exa-fact-search.adapter.js";
import { FactPlanService } from "../../src/editorial/corroboration/fact-plan.service.js";
import { LegacyEditorialDraftGateway } from "../../src/editorial/legacy-editorial-draft.gateway.js";
import type { GenerateReviewDraftInput } from "../../src/editorial/editorial-application.contracts.js";
import type { ArticleRow } from "../../src/research/research-persistence.contracts.js";

// Three thin posts in one day, and production could not say whether Exa had
// run for any of them: the fact plan answered [] for a timeout and for "nothing
// to check" alike, failed searches were skipped silently, and the gateway's own
// catch left no trace. These checks pin the record that now exists.

const ARTICLE: ArticleRow = {
  id: "article-7",
  source_id: "source-1",
  search_run_id: "run-1",
  canonical_url: "https://www.theguardian.com/environment/story",
  title: "A single-source story",
  author: null,
  published_at: null,
  discovered_at: "2026-09-23T09:00:00.000Z",
  content_hash: "hash",
  status: "extracted",
  metadata: {},
  created_at: "2026-09-23T09:00:00.000Z",
  updated_at: "2026-09-23T09:00:00.000Z",
};

const REQUEST = { query: "who confirmed it", reason: "second newsroom", expectedClaim: "it happened" };

function unverifiedInput(): GenerateReviewDraftInput {
  return {
    article: ARTICLE,
    evidence: [{
      url: ARTICLE.canonical_url,
      text: "Source text",
      primary: false,
      verificationStatus: "unverified_community",
    }],
    languageCode: "en",
    channelId: "@channel",
    allowUnverified: false,
    lease: { name: "daily", ownerId: "owner-1" },
  } as GenerateReviewDraftInput;
}

class TimeoutError extends Error {
  readonly code = "timeout";
}

function providerError(message: string): Error {
  // The shape AiProvidersExhaustedError has: an aggregate whose own code only
  // says "all failed", with the useful codes inside it.
  const error = new AggregateError(
    [new TimeoutError(message), Object.assign(new Error(message), { code: "authentication_failed" })],
    message,
  );
  return Object.assign(error, { code: "ai_providers_exhausted" });
}

const ENRICHED = {
  headline: "A verified headline",
  telegramText: "A verified headline\n\nThe enriched body says something specific and grounded.",
  claims: [],
  sourceUrls: [ARTICLE.canonical_url],
  caveat: "Nothing further is settled.",
};

function gateway(options: {
  factPlan: unknown;
  corroboration?: unknown;
  lines: Array<Record<string, unknown>>;
  enrichCalls?: { count: number };
  reviewerNotes?: string | null;
}) {
  return new LegacyEditorialDraftGateway(
    {
      model: "m",
      aiProvider: {},
      repository: {
        async getNewsFeatureFlags() {
          return [{ feature_key: "editorial_enrichment", state: "enabled" }];
        },
        async listEnabledArticleTags() {
          return [];
        },
        createReviewDraft: async () => ({}),
      } as never,
      factPlan: options.factPlan as never,
      corroboration: (options.corroboration ?? {
        async corroborate() {
          throw new Error("must not be called");
        },
      }) as never,
      factSearch: { async find() { return { sources: [] }; } },
      enrichment: {
        async enrich() {
          if (options.enrichCalls) options.enrichCalls.count += 1;
          return {
            status: "completed" as const,
            draft: ENRICHED,
            readerAngle: "angle",
            evidenceMap: [],
            similarity: { metric: "m", score: 0.1, threshold: 0.68 },
            provider: "fake",
            model: "fake",
            attempts: 1,
          };
        },
      } as never,
      log: { info: (line: unknown) => options.lines.push(JSON.parse(String(line))) },
    },
    (async () => ({
      draft: { telegramText: "baseline" },
      baselineDraft: {
        headline: "Baseline",
        telegramText: "Baseline\n\nBaseline body.",
        claims: [],
        sourceUrls: [],
        caveat: "c",
      },
      enrichedDraft: null,
      editorialEnrichment: { state: "off" },
      saved: {
        article_id: ARTICLE.id,
        body: "Baseline body",
        model: "m",
        prompt_version: "v",
        reviewer_notes: options.reviewerNotes === undefined ? "{}" : options.reviewerNotes,
      },
      provider: "fake",
      model: "fake",
    })) as never,
  );
}

function event(lines: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
  const found = lines.filter((line) => line.event === name);
  assert.equal(found.length, 1, `expected exactly one ${name} line, got ${JSON.stringify(lines)}`);
  return found[0]!;
}

// --- errorCodeOf -------------------------------------------------------------

test("errorCodeOf keeps codes, names the inner failures of an aggregate, and never the message", () => {
  assert.equal(errorCodeOf(new TimeoutError("Bearer sk-live-123 at https://api.example/v1")), "timeout");
  assert.equal(errorCodeOf(providerError("secret detail")), "ai_providers_exhausted:timeout,authentication_failed");
  assert.equal(errorCodeOf(new Error("plain message")), "error");
  assert.equal(errorCodeOf(Object.assign(new Error("x"), { code: "has spaces and https://url" })), "error");
  assert.equal(errorCodeOf("a string"), "error");
});

// --- FactPlanService.planWithOutcome ----------------------------------------

function planInput(generateStructured: () => Promise<{ value?: unknown }>) {
  return {
    article: { title: "t", summary: "s" },
    evidence: [],
    languageCode: "en",
    generator: { generateStructured },
  };
}

test("a fact plan that failed is told apart from one that found nothing", async () => {
  const service = new FactPlanService();

  const failed = await service.planWithOutcome(planInput(async () => {
    throw providerError("OpenAI said something long");
  }));
  assert.deepEqual(failed, {
    requests: [],
    outcome: "failed",
    errorCode: "ai_providers_exhausted:timeout,authentication_failed",
  });

  const empty = await service.planWithOutcome(planInput(async () => ({ value: { requests: [] } })));
  assert.deepEqual(empty, { requests: [], outcome: "empty", errorCode: null });

  const invalid = await service.planWithOutcome(planInput(async () => ({ value: { nope: true } })));
  assert.deepEqual(invalid, { requests: [], outcome: "invalid", errorCode: null });

  const asked = await service.planWithOutcome(planInput(async () => ({ value: { requests: [REQUEST] } })));
  assert.equal(asked.outcome, "requests");
  assert.equal(asked.requests.length, 1);

  // plan() is unchanged for existing callers: still [] on failure, never a throw.
  assert.deepEqual(await service.plan(planInput(async () => { throw new TimeoutError("x"); })), []);
});

// --- EvidenceCorroborationService -------------------------------------------

test("failed searches are counted, with their codes, instead of vanishing", async () => {
  const service = new EvidenceCorroborationService({ requiredPublishers: 2, maxSearches: 3, maxSourceAgeHours: 72 });
  const outcome = await service.corroborate({
    evidence: [{ url: ARTICLE.canonical_url, text: "t", primary: false, verificationStatus: "unverified_community" }],
    requests: [REQUEST, REQUEST, REQUEST],
    languageCode: "en",
    search: {
      async find() {
        throw new ExaDailyFactSearchCapError(3);
      },
    },
  });
  assert.equal(outcome.status, "uncorroborated");
  assert.equal(outcome.searches, 3);
  assert.equal(outcome.failedSearches, 3);
  assert.deepEqual(outcome.searchErrors, ["exa_daily_fact_search_cap"]);
});

test("a round with nothing to ask reports zero failures", async () => {
  const service = new EvidenceCorroborationService({ requiredPublishers: 2, maxSearches: 3, maxSourceAgeHours: 72 });
  const outcome = await service.corroborate({
    evidence: [],
    requests: [],
    languageCode: "en",
    search: { async find() { return { sources: [] }; } },
  });
  assert.equal(outcome.status, "not_needed");
  assert.equal(outcome.failedSearches, 0);
  assert.deepEqual(outcome.searchErrors, []);
});

// --- LegacyEditorialDraftGateway --------------------------------------------

test("a failed fact plan is logged and stored, and no search is attempted", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const result = await gateway({
    lines,
    factPlan: new FactPlanService(),
  }).generate(unverifiedInput());
  // FactPlanService calls aiProvider.generateStructured, which the fake
  // provider does not have: that TypeError is the "no answer at all" case.

  const line = event(lines, "evidence_corroboration");
  assert.equal(line.article_id, ARTICLE.id);
  assert.equal(line.fact_plan, "failed");
  assert.equal(line.fact_plan_error, "TypeError");
  assert.equal(line.requests, 0);
  assert.equal(line.status, "not_run");
  assert.equal(line.search_port, null);

  const notes = JSON.parse(String(result.draft.reviewer_notes));
  assert.equal(notes.evidence_corroboration.fact_plan, "failed");
  assert.equal(notes.evidence_corroboration.status, "not_run");
});

test("the corroboration line never carries a provider message", async () => {
  const lines: Array<Record<string, unknown>> = [];
  await gateway({
    lines,
    factPlan: new FactPlanService(),
  }).generate({
    ...unverifiedInput(),
  });
  await gateway({
    lines,
    factPlan: {
      async planWithOutcome() {
        return { requests: [REQUEST], outcome: "requests", errorCode: null };
      },
    },
    corroboration: {
      async corroborate() {
        throw new TimeoutError("Bearer sk-live-SECRET https://api.example/v1?key=abc");
      },
    },
  }).generate(unverifiedInput());

  const serialized = JSON.stringify(lines);
  assert.doesNotMatch(serialized, /SECRET|sk-live|api\.example|key=abc/u);
  const errorLine = lines.filter((line) => line.event === "evidence_corroboration")[1]!;
  assert.equal(errorLine.status, "error");
  assert.equal(errorLine.error, "timeout");
  assert.equal(errorLine.search_port, "exa");
});

test("a story Exa corroborated reaches the editorial pass", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const enrichCalls = { count: 0 };
  const result = await gateway({
    lines,
    enrichCalls,
    factPlan: {
      async planWithOutcome() {
        return { requests: [REQUEST, REQUEST], outcome: "requests", errorCode: null };
      },
    },
    corroboration: {
      async corroborate() {
        return {
          status: "corroborated",
          // Cleared by the service because two strong publishers agreed.
          evidence: [
            { url: ARTICLE.canonical_url, text: "Source text", primary: false, verificationStatus: "web_source" },
            { url: "https://www.reuters.com/x", text: "r", primary: false, verificationStatus: "web_source" },
            { url: "https://apnews.com/y", text: "a", primary: false, verificationStatus: "web_source" },
          ],
          searches: 2,
          publishers: ["reuters.com", "apnews.com"],
          strongPublishers: ["reuters.com", "apnews.com"],
          failedSearches: 0,
          searchErrors: [],
          usageEvents: [],
        };
      },
    },
  }).generate(unverifiedInput());

  // Before the fix the pass read the ORIGINAL evidence, still unverified, and
  // fell back to the baseline with `unverified_story`.
  assert.equal(enrichCalls.count, 1);
  const pass = event(lines, "editorial_pass");
  assert.equal(pass.status, "completed");
  assert.equal(pass.selected_version, "enriched");
  assert.equal(pass.diagnostic, null);
  assert.equal(pass.corroboration_status, "corroborated");
  assert.match(String(result.draft.body), /enriched body/u);

  const line = event(lines, "evidence_corroboration");
  assert.equal(line.fact_plan, "requests");
  assert.equal(line.requests, 2);
  assert.equal(line.search_port, "exa");
  assert.equal(line.searches, 2);
  assert.equal(line.publishers, 2);
  assert.deepEqual(line.strong_publishers, ["reuters.com", "apnews.com"]);
  assert.equal(line.evidence_added, true);
});

test("a story Exa could not corroborate still falls back, and says why", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const enrichCalls = { count: 0 };
  const result = await gateway({
    lines,
    enrichCalls,
    factPlan: {
      async planWithOutcome() {
        return { requests: [REQUEST, REQUEST, REQUEST], outcome: "requests", errorCode: null };
      },
    },
    corroboration: {
      async corroborate() {
        return {
          status: "uncorroborated",
          evidence: [
            { url: ARTICLE.canonical_url, text: "Source text", primary: false, verificationStatus: "unverified_community" },
          ],
          searches: 3,
          publishers: [],
          strongPublishers: [],
          failedSearches: 3,
          searchErrors: ["exa_daily_fact_search_cap"],
          usageEvents: [],
          tag: "#rumor",
          reason: "Found 0 strong and 0 other publisher(s); 2 strong required",
        };
      },
    },
  }).generate(unverifiedInput());

  assert.equal(enrichCalls.count, 0);
  const pass = event(lines, "editorial_pass");
  assert.equal(pass.status, "fallback_to_baseline");
  assert.equal(pass.selected_version, "baseline");
  assert.equal(pass.diagnostic, "unverified_story");

  const line = event(lines, "evidence_corroboration");
  assert.equal(line.status, "uncorroborated");
  assert.equal(line.failed_searches, 3);
  assert.deepEqual(line.search_errors, ["exa_daily_fact_search_cap"]);

  const notes = JSON.parse(String(result.draft.reviewer_notes));
  assert.equal(notes.evidence_corroboration.failed_searches, 3);
  assert.equal(notes.editorial_enrichment.diagnostic, "unverified_story");
});

test("notes that are not JSON are left exactly as legacy wrote them", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const plain = await gateway({
    lines,
    reviewerNotes: "not json",
    factPlan: { async planWithOutcome() { return { requests: [], outcome: "empty", errorCode: null }; } },
  }).generate(unverifiedInput());
  assert.equal(plain.draft.reviewer_notes, "not json");

  const none = await gateway({
    lines,
    reviewerNotes: null,
    factPlan: { async planWithOutcome() { return { requests: [], outcome: "empty", errorCode: null }; } },
  }).generate(unverifiedInput());
  assert.equal(none.draft.reviewer_notes, null);
});

test("a planner that only implements plan() still works", async () => {
  const lines: Array<Record<string, unknown>> = [];
  await gateway({
    lines,
    factPlan: { async plan() { return []; } },
  }).generate(unverifiedInput());
  assert.equal(event(lines, "evidence_corroboration").fact_plan, "empty");
});
