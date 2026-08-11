import assert from "node:assert/strict";
import test from "node:test";
import { groundedFactEvidence } from "../src/ai-fact-search.js";
import { validateGroundedDraft } from "../src/draft.js";
import {
  enrichEditorialDraft,
  validateEditorialEvidenceMap,
} from "../src/editorial-enrichment.js";

const PRIMARY_URL = "https://example.com/full-article";
const SEARCH_URL = "https://agency.example.gov/decision";
const PRIMARY_TEXT =
  "The team reduced the battery charging time from sixty minutes to fifteen minutes. The authors said the result was measured in a controlled laboratory test.";

function draft({ searched = false } = {}) {
  const claims = [
    {
      text: "The team cut charging time from sixty minutes to fifteen.",
      sourceUrl: PRIMARY_URL,
    },
  ];
  const sourceUrls = [PRIMARY_URL];
  if (searched) {
    claims.push({
      text: "The agency approved the system on 10 August 2026.",
      sourceUrl: SEARCH_URL,
    });
    sourceUrls.push(SEARCH_URL);
  }
  return {
    headline: "A battery result that changes the clock",
    telegramText:
      "A battery result that changes the clock\n\nThe team cut charging time from sixty minutes to fifteen. That could make short charging stops more practical. The result still comes from a controlled laboratory test.",
    claims,
    sourceUrls,
    caveat: "The result was measured in a controlled laboratory test.",
  };
}

function evidenceMap({ searched = false } = {}) {
  const entries = [
    {
      claim: "The team cut charging time from sixty minutes to fifteen.",
      sourceUrl: PRIMARY_URL,
      evidenceExcerpt:
        "reduced the battery charging time from sixty minutes to fifteen minutes",
    },
  ];
  if (searched) {
    entries.push({
      claim: "The agency approved the system on 10 August 2026.",
      sourceUrl: SEARCH_URL,
      evidenceExcerpt: "approved the system on 10 August 2026",
    });
  }
  return entries;
}

const article = {
  id: "article-enrichment",
  title: "Battery research",
  canonical_url: PRIMARY_URL,
  published_at: "2026-08-11T10:00:00Z",
  search_run_id: "search-run-enrichment",
};
const evidence = [
  {
    url: PRIMARY_URL,
    title: "Battery research",
    publisher: "Example Lab",
    primary: true,
    verificationStatus: "primary_source",
    text: PRIMARY_TEXT,
  },
];

test("editorial fact evidence must cite a URL returned by the search tool", () => {
  const fact = {
    fact: {
      claim: "The agency approved the system.",
      sourceUrl: SEARCH_URL,
      sourceTitle: "Agency decision",
      sourceKind: "government",
      evidenceText: "The agency approved the system.",
    },
  };
  assert.deepEqual(groundedFactEvidence(fact, [SEARCH_URL]), fact);
  assert.deepEqual(
    groundedFactEvidence(fact, ["https://other.example/source"]),
    { fact: null },
  );
});

test("editorial evidence map requires exact source excerpts for every claim", () => {
  assert.equal(
    validateEditorialEvidenceMap(draft(), evidenceMap(), evidence).length,
    1,
  );
  assert.throws(
    () =>
      validateEditorialEvidenceMap(
        draft(),
        [
          {
            ...evidenceMap()[0],
            evidenceExcerpt: "A paraphrase that is not in the source.",
          },
        ],
        evidence,
      ),
    /not present in its source/,
  );
});

test("editorial enrichment uses the configured provider and skips search by default", async () => {
  const usage = [];
  let request;
  const result = await enrichEditorialDraft({
    aiProvider: {
      async generateStructured(input) {
        request = input;
        return {
          value: {
            draft: draft(),
            evidenceMap: evidenceMap(),
            factRequest: null,
          },
          provider: "openai",
          model: "configured-editor-model",
          usageEvents: [
            {
              provider: "openai",
              model: "configured-editor-model",
              operation: input.usageOperation,
            },
          ],
        };
      },
    },
    repository: {
      async recordAiUsage(event) {
        usage.push(event);
        return event;
      },
    },
    article,
    baselineDraft: draft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(result.model, "configured-editor-model");
  assert.equal(result.search.status, "not_needed");
  assert.equal(usage[0].operation, "editorial_enrichment");
  assert.equal(request.usageOperation, "editorial_enrichment");
  assert.match(request.systemInstruction, /strong but non-sensational hook/);
  assert.equal(request.input.evidence[0].text, PRIMARY_TEXT);
});

test("editorial enrichment performs at most one narrow search and maps the added fact", async () => {
  const usage = [];
  let generations = 0;
  let searches = 0;
  const aiProvider = {
    async generateStructured(input) {
      generations += 1;
      const searched = input.input.factSearchUsed;
      assert.equal(input.input.evidence.length, searched ? 2 : 1);
      return {
        value: {
          draft: draft({ searched }),
          evidenceMap: evidenceMap({ searched }),
          factRequest: searched
            ? null
            : {
                query: "agency approval battery system 10 August 2026",
                reason: "The approval date is material to the rollout status.",
                expectedClaim:
                  "The agency approved the system on 10 August 2026.",
              },
        },
        provider: "openai",
        model: "configured-editor-model",
        usageEvents: [
          {
            provider: "openai",
            model: "configured-editor-model",
            operation: input.usageOperation,
          },
        ],
      };
    },
    async searchFact(input) {
      searches += 1;
      assert.match(input.query, /agency approval/);
      return {
        fact: {
          claim: "The agency approved the system on 10 August 2026.",
          sourceUrl: SEARCH_URL,
          sourceTitle: "Agency decision",
          sourceKind: "government",
          evidenceText:
            "The agency approved the system on 10 August 2026 after its safety review.",
        },
        provider: "openai",
        model: "configured-editor-model",
        usageEvents: [
          {
            provider: "openai",
            model: "configured-editor-model",
            operation: "editorial_fact_search",
            webSearchCalls: 1,
          },
        ],
      };
    },
  };
  const result = await enrichEditorialDraft({
    aiProvider,
    repository: {
      async recordAiUsage(event) {
        usage.push(event);
        return event;
      },
    },
    article,
    baselineDraft: draft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(generations, 2);
  assert.equal(searches, 1);
  assert.equal(result.search.status, "used");
  assert.equal(result.search.sourceUrl, SEARCH_URL);
  assert.ok(result.evidenceMap.some((entry) => entry.sourceUrl === SEARCH_URL));
  assert.deepEqual(
    usage.map((event) => event.operation),
    [
      "editorial_enrichment",
      "editorial_fact_search",
      "editorial_enrichment",
    ],
  );
});

test("a failed optional fact search keeps the source-grounded enriched draft", async () => {
  let generations = 0;
  const result = await enrichEditorialDraft({
    aiProvider: {
      async generateStructured() {
        generations += 1;
        return {
          value: {
            draft: draft(),
            evidenceMap: evidenceMap(),
            factRequest: {
              query: "one narrow missing fact",
              reason: "Potentially useful but not required by the fallback draft.",
              expectedClaim: "A missing fact.",
            },
          },
          provider: "gemini",
          model: "configured-editor-model",
        };
      },
      async searchFact() {
        throw new Error("search unavailable");
      },
    },
    repository: {},
    article,
    baselineDraft: draft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(generations, 1);
  assert.equal(result.search.status, "failed");
  assert.equal(result.draft.claims.length, 1);
});
