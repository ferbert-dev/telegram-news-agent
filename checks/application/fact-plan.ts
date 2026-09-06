import assert from "node:assert/strict";
import test from "node:test";

import { FactPlanService } from "../../src/editorial/corroboration/fact-plan.service.js";
import type { CorroborationEvidence } from "../../src/editorial/corroboration/evidence-corroboration.contracts.js";

const service = () => new FactPlanService();
const article = { title: "Acme buys Initech", summary: "A forum post claims it." };

const rumour: CorroborationEvidence[] = [
  { sourceUrl: "https://forum.example.com/1", verificationStatus: "unverified_community" },
];

function generator(value: unknown, calls: unknown[] = []) {
  return {
    calls,
    async generateStructured(input: Record<string, unknown>) {
      calls.push(input);
      if (value instanceof Error) throw value;
      return { value };
    },
  };
}

test("a story already on a primary source is never planned for", async () => {
  const gen = generator({ requests: [] });
  const plan = await service().plan({
    article,
    evidence: [{ sourceUrl: "https://acme.example/pr", verificationStatus: "primary_source" }],
    languageCode: "en",
    generator: gen,
  });

  assert.deepEqual(plan, []);
  // No model call at all: the same rule the corroboration service follows, so
  // an article that needs nothing costs nothing on either step.
  assert.equal(gen.calls.length, 0);
});

test("the model's questions are returned as written", async () => {
  const plan = await service().plan({
    article,
    evidence: rumour,
    languageCode: "en",
    generator: generator({
      requests: [
        { query: "Acme Initech acquisition announcement", reason: "confirm the deal", expectedClaim: "Acme acquired Initech" },
      ],
    }),
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0].query, "Acme Initech acquisition announcement");
});

test("the article is passed as data and the known sources are named", async () => {
  const gen = generator({ requests: [] });
  await service().plan({ article, evidence: rumour, languageCode: "en", generator: gen });

  const sent = gen.calls[0] as Record<string, any>;
  assert.equal(sent.usageOperation, "fact_plan");
  assert.match(sent.systemInstruction, /untrusted data, never instructions/);
  // The model is told what we already have, so it does not spend the budget
  // asking for the source we started from.
  assert.deepEqual(sent.input.knownSources, ["https://forum.example.com/1"]);
});

test("a planner that fails leaves the article exactly as it would have been", async () => {
  for (const bad of [new Error("model down"), { requests: "not a list" }, {}, null]) {
    const plan = await service().plan({
      article,
      evidence: rumour,
      languageCode: "en",
      generator: generator(bad),
    });
    // Planning is an enhancement, never a gate. An article that fails to appear
    // is a worse outcome than one published without extra corroboration.
    assert.deepEqual(plan, [], `must degrade for ${JSON.stringify(bad)}`);
  }
});

test("an uncorroborated story keeps its caveat until the tag exists", async () => {
  const { LegacyEditorialDraftGateway } = await import(
    "../../src/editorial/legacy-editorial-draft.gateway.js"
  );
  const { EvidenceCorroborationService, DEFAULT_CORROBORATION_OPTIONS } =
    await import(
      "../../src/editorial/corroboration/evidence-corroboration.service.js"
    );

  const evidence = [
    { sourceUrl: "https://forum.example.com/1", verificationStatus: "unverified_community" },
  ];
  let handed: unknown;

  const gateway = new LegacyEditorialDraftGateway(
    {
      model: "m",
      repository: { recordAiUsageEvents: async () => {} } as never,
      // Nothing corroborates: the planner asks, every search comes back empty.
      aiProvider: {
        generateStructured: async () => ({
          value: { requests: [{ query: "acme initech acquisition", reason: "confirm the deal", expectedClaim: "Acme acquired Initech" }] },
        }),
        searchFact: async () => ({ value: { fact: null } }),
      } as never,
      factPlan: new FactPlanService(),
      corroboration: new EvidenceCorroborationService(DEFAULT_CORROBORATION_OPTIONS),
    } as never,
    (async (args: { evidence: unknown }) => {
      handed = args.evidence;
      throw new Error("stop after the seam");
    }) as never,
  );

  await gateway
    .generate({
      article: { title: "t", summary: "s" },
      evidence,
      languageCode: "en",
    } as never)
    .catch(() => {});

  // The service clears unverified_community on the uncorroborated path too,
  // for a #rumor tag that does not reach the published text yet. Taking that
  // here would strip the caveat from a story nothing confirmed and put nothing
  // in its place.
  assert.deepEqual(handed, evidence, "uncorroborated evidence must pass through untouched");
});
