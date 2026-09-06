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
