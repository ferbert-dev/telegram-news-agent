import assert from "node:assert/strict";
import test from "node:test";
import { groundedFactEvidence } from "../src/ai-fact-search.js";
import { validateGroundedDraft } from "../src/draft.js";
import {
  EDITORIAL_SIMILARITY_THRESHOLD,
  enrichEditorialDraft,
  measureEditorialSimilarity,
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
      "A battery result that changes the clock\n\nA quarter-hour result puts the long charging stop under pressure. In a controlled laboratory test, the team cut battery charging time from sixty minutes to fifteen, turning a full hour into a short pause. If that speed survives outside the lab, drivers could spend less time waiting and more charging stops could fit into ordinary trips. The measurement therefore points to a practical change in how quickly a battery might return to use. For now, however, the authors have reported only controlled laboratory conditions, so real-world performance remains unknown." +
      (searched
        ? " The agency approved the system on 10 August 2026."
        : ""),
    claims,
    sourceUrls,
    caveat: "The result was measured in a controlled laboratory test.",
  };
}

function editorialFields(targetDraft, readerAngle) {
  const retry = targetDraft.headline.startsWith("Fifteen minutes");
  return {
    readerAngle,
    hook: retry
      ? "A one-hour charging wait collapsed to fifteen minutes in the laboratory."
      : "A quarter-hour result puts the long charging stop under pressure.",
    hookEvidence: {
      sourceUrl: PRIMARY_URL,
      evidenceExcerpt:
        "reduced the battery charging time from sixty minutes to fifteen minutes",
    },
    causalArc: retry
      ? {
          change:
            "The team reduced battery charging time from sixty minutes to fifteen under controlled conditions.",
          causeOrEnabler: "under controlled conditions",
          consequence:
            "The result makes a short charging pause easier to imagine",
          readerSignificance:
            "a driver could spend less time waiting during an ordinary trip",
        }
      : {
          change:
            "the team cut battery charging time from sixty minutes to fifteen",
          causeOrEnabler: "In a controlled laboratory test",
          consequence:
            "The measurement therefore points to a practical change in how quickly a battery might return to use.",
          readerSignificance: "drivers could spend less time waiting",
        },
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

function baselineDraft() {
  return {
    ...draft(),
    headline: "Battery charging test",
    telegramText:
      "Battery charging test\n\nResearchers reported a controlled laboratory charging test. The measured charging time fell from sixty minutes to fifteen minutes. Results outside the laboratory are not yet available.",
  };
}

function similarBaselineDraft() {
  return {
    ...draft(),
    headline: "A charging test changes the clock",
    telegramText: draft().telegramText
      .replace(
        "A battery result that changes the clock",
        "A charging test changes the clock",
      )
      .replace(
        "A quarter-hour result puts the long charging stop under pressure.",
        "One battery test turns a sixty-minute wait into fifteen.",
      ),
  };
}

function retryDraft() {
  return {
    ...draft(),
    headline: "Fifteen minutes could redraw the charging stop",
    telegramText:
      "Fifteen minutes could redraw the charging stop\n\nA one-hour charging wait collapsed to fifteen minutes in the laboratory. The team reduced battery charging time from sixty minutes to fifteen under controlled conditions. The result makes a short charging pause easier to imagine: if the same speed holds outside the lab, a driver could spend less time waiting during an ordinary trip. That could change when and where people choose to recharge, especially on journeys where every stop adds friction. The experiment has not yet shown that the result will survive real roads, different batteries, or repeated daily use.",
  };
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

test("editorial similarity detects a polished copy but accepts a rebuilt narrative", () => {
  const identical = measureEditorialSimilarity(draft(), draft());
  const rebuilt = measureEditorialSimilarity(draft(), retryDraft());

  assert.equal(identical.score, 1);
  assert.equal(identical.tooSimilar, true);
  assert.equal(identical.threshold, EDITORIAL_SIMILARITY_THRESHOLD);
  assert.equal(rebuilt.tooSimilar, false);
  assert.ok(rebuilt.score < identical.score);
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
            ...editorialFields(
              draft(),
              "A much shorter stop could change charging habits.",
            ),
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
    baselineDraft: baselineDraft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(result.model, "configured-editor-model");
  assert.equal(result.search.status, "not_needed");
  assert.equal(usage[0].operation, "editorial_enrichment");
  assert.equal(request.usageOperation, "editorial_enrichment");
  assert.match(request.systemInstruction, /specific reader angle/);
  assert.match(request.systemInstruction, /Target 90-140 words/);
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
          ...editorialFields(
            draft({ searched }),
            searched
              ? "Approval turns a lab result into a rollout question."
              : "A shorter charging stop could matter beyond the laboratory.",
          ),
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
    baselineDraft: baselineDraft(),
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
            ...editorialFields(
              draft(),
              "A shorter charging stop could change daily use.",
            ),
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
    baselineDraft: baselineDraft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(generations, 1);
  assert.equal(result.search.status, "failed");
  assert.equal(result.draft.claims.length, 1);
});

test("editorial enrichment retries once when the first attempt is too similar", async () => {
  const usage = [];
  const requests = [];
  const result = await enrichEditorialDraft({
    aiProvider: {
      async generateStructured(input) {
        requests.push(input);
        const retry = input.usageOperation === "editorial_enrichment_retry";
        return {
          value: {
            ...editorialFields(
              retry ? retryDraft() : draft(),
              retry
                ? "A quarter-hour stop is the practical stake."
                : "The charging result could make stops shorter.",
            ),
            draft: retry ? retryDraft() : draft(),
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
    baselineDraft: similarBaselineDraft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].usageOperation, "editorial_enrichment_retry");
  assert.equal(
    requests[1].input.retryFeedback.firstAttempt.draft.headline,
    draft().headline,
  );
  assert.deepEqual(
    usage.map((event) => event.operation),
    ["editorial_enrichment", "editorial_enrichment_retry"],
  );
  assert.equal(result.quality.retryAttempted, true);
  assert.equal(result.quality.retryStatus, "selected");
  assert.equal(result.quality.selectedAttempt, "retry");
  assert.equal(result.quality.tooSimilar, false);
  assert.equal(result.draft.headline, retryDraft().headline);
});

test("an invalid similarity retry keeps the first valid grounded article", async () => {
  let generations = 0;
  const result = await enrichEditorialDraft({
    aiProvider: {
      async generateStructured(input) {
        generations += 1;
        const retry = input.usageOperation === "editorial_enrichment_retry";
        return {
          value: {
            ...editorialFields(
              retry ? retryDraft() : draft(),
              "The shorter charging time is the practical stake.",
            ),
            draft: retry
              ? {
                  ...retryDraft(),
                  claims: [{ text: "Invented approval.", sourceUrl: SEARCH_URL }],
                  sourceUrls: [SEARCH_URL],
                }
              : draft(),
            evidenceMap: retry
              ? [
                  {
                    claim: "Invented approval.",
                    sourceUrl: SEARCH_URL,
                    evidenceExcerpt: "not present",
                  },
                ]
              : evidenceMap(),
            factRequest: null,
          },
          provider: "openai",
          model: "configured-editor-model",
        };
      },
    },
    repository: {},
    article,
    baselineDraft: similarBaselineDraft(),
    evidence,
    validateDraft: validateGroundedDraft,
  });

  assert.equal(generations, 2);
  assert.equal(result.quality.retryStatus, "invalid");
  assert.equal(result.quality.selectedAttempt, "initial");
  assert.equal(result.draft.headline, draft().headline);
});

test("editorial enrichment rejects a short article below the quality floor", async () => {
  const shortDraft = {
    ...draft(),
    telegramText:
      "A battery result that changes the clock\n\nA quarter-hour result puts the long charging stop under pressure. The team cut battery charging time from sixty minutes to fifteen. Drivers could spend less time waiting. The test remains limited to a laboratory.",
  };
  await assert.rejects(
    enrichEditorialDraft({
      aiProvider: {
        async generateStructured() {
          return {
            value: {
              readerAngle: "Short charging stops could matter to drivers.",
              hook:
                "A quarter-hour result puts the long charging stop under pressure.",
              hookEvidence: {
                sourceUrl: PRIMARY_URL,
                evidenceExcerpt:
                  "reduced the battery charging time from sixty minutes to fifteen minutes",
              },
              causalArc: {
                change:
                  "The team cut battery charging time from sixty minutes to fifteen.",
                causeOrEnabler: null,
                consequence: "Drivers could spend less time waiting.",
                readerSignificance: "Drivers could spend less time waiting.",
              },
              draft: shortDraft,
              evidenceMap: evidenceMap(),
              factRequest: null,
            },
            provider: "openai",
            model: "configured-editor-model",
          };
        },
      },
      repository: {},
      article,
      baselineDraft: baselineDraft(),
      evidence,
      validateDraft: validateGroundedDraft,
    }),
    /90-word editorial minimum/,
  );
});

test("editorial enrichment rejects invalid hook and causal contracts", async () => {
  for (const invalid of [
    "repeated_hook",
    "paraphrased_hook",
    "not_first_hook",
    "unsupported_hook",
    "absent_span",
  ]) {
    await assert.rejects(
      enrichEditorialDraft({
        aiProvider: {
          async generateStructured() {
            const fields = editorialFields(
              draft(),
              "A shorter stop could change charging habits.",
            );
            return {
              value: {
                ...fields,
                ...(invalid === "not_first_hook"
                  ? { hook: "Drivers could spend less time waiting." }
                  : invalid === "unsupported_hook"
                    ? {
                        hookEvidence: {
                          sourceUrl: PRIMARY_URL,
                          evidenceExcerpt: "Text absent from the evidence.",
                        },
                      }
                    : invalid !== "absent_span"
                  ? {}
                  : {
                      causalArc: {
                        ...fields.causalArc,
                        readerSignificance: "Text that is absent from the article.",
                      },
                    }),
                draft: draft(),
                evidenceMap: evidenceMap(),
                factRequest: null,
              },
              provider: "openai",
              model: "configured-editor-model",
            };
          },
        },
        repository: {},
        article,
        baselineDraft: invalid === "repeated_hook"
          ? draft()
          : invalid === "paraphrased_hook"
            ? {
                ...draft(),
                telegramText: draft().telegramText.replace(
                  "A quarter-hour result puts the long charging stop under pressure.",
                  "A quarter-hour result puts the long charging stop under new pressure.",
                ),
              }
            : baselineDraft(),
        evidence,
        validateDraft: validateGroundedDraft,
      }),
      invalid === "repeated_hook" || invalid === "paraphrased_hook"
        ? /hook must not repeat the baseline lead/
        : invalid === "not_first_hook"
          ? /hook must be the first prose sentence/
          : invalid === "unsupported_hook"
            ? /hook evidence is not present in its source/
            : /causal arc must use exact article text/,
    );
  }
});
