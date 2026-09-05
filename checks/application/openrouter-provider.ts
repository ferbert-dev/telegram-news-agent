import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { getAiProviderOrder } from "../../src/ai/ai-provider-composition.js";
import {
  createOpenRouterProvider,
  DEFAULT_OPEN_ROUTER_MODEL,
  getOpenRouterConfig,
  OPEN_ROUTER_BASE_URL,
} from "../../src/ai/providers/openrouter.adapter.js";
import { openrouterProviderDescriptor } from "../../src/ai/providers/openrouter.provider.js";

const Schema = z.object({ verdict: z.string() });

const config = {
  apiKey: "k",
  model: "some/model",
  baseUrl: OPEN_ROUTER_BASE_URL,
};

type Call = { body: Record<string, unknown> };

function fakeClient(response: unknown, calls: Call[] = []) {
  return {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          calls.push({ body });
          if (response instanceof Error) throw response;
          return response as never;
        },
      },
    },
  };
}

const okResponse = (
  content: string | null,
  usage: unknown = { prompt_tokens: 11, completion_tokens: 3 },
) => ({
  id: "gen-1",
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage,
});

test("a key alone is enough, and what it defaults to is free", () => {
  assert.equal(getOpenRouterConfig({}), null);
  assert.equal(getOpenRouterConfig({ OPEN_ROUTER_API_KEY: "  " }), null);

  // Both spellings: the encrypted integration environment uses
  // OPEN_ROUTER_API_KEY, and the conventional one must not be silently ignored.
  for (const key of ["OPEN_ROUTER_API_KEY", "OPENROUTER_API_KEY"]) {
    const resolved = getOpenRouterConfig({ [key]: " k " });
    assert.equal(resolved?.apiKey, "k");
    assert.equal(resolved?.model, DEFAULT_OPEN_ROUTER_MODEL);
  }

  // The default must stay free. A paid default would bill for a model nobody
  // chose, which is why this is an assertion and not a comment.
  assert.match(
    DEFAULT_OPEN_ROUTER_MODEL,
    /:free$/,
    "the default OpenRouter model must be a free one",
  );
});

test("an unconfigured OpenRouter cannot stop the runtime from starting", () => {
  // getAiProviderOrder computes the default order EAGERLY -- configure() runs
  // on every startup even when AI_PROVIDER_ORDER names other providers -- so a
  // configure() that threw would turn a half-configured optional provider into
  // a bot that cannot start.
  assert.doesNotThrow(() =>
    getAiProviderOrder({
      OPEN_ROUTER_API_KEY: "k",
      AI_PROVIDER_ORDER: "openai,gemini",
      OPENAI_API_KEY: "o",
    }),
  );
  assert.equal(
    getAiProviderOrder({ OPENAI_API_KEY: "o" }).includes("openrouter"),
    false,
    "without a key it stays out of the order entirely",
  );
  assert.equal(
    getAiProviderOrder({ OPENAI_API_KEY: "o", OPEN_ROUTER_API_KEY: "k" }).includes(
      "openrouter",
    ),
    true,
    "with a key it joins the default order",
  );
});

test("the descriptor claims only what the adapter implements", () => {
  // Declaring searchNews here would put OpenRouter into the cascade for
  // grounded web search, which it cannot serve -- every such call would reach
  // it and fail.
  assert.deepEqual(openrouterProviderDescriptor.capabilities, [
    "generateStructured",
  ]);
  const adapter = openrouterProviderDescriptor.createAdapter(
    config,
    fakeClient(okResponse('{"verdict":"ok"}')),
  );
  assert.equal(typeof adapter?.generateStructured, "function");
  assert.equal(adapter?.searchNews, undefined);
});

test("structured generation asks for a strict schema and refuses providers that would ignore it", async () => {
  const calls: Call[] = [];
  const provider = createOpenRouterProvider(config, {
    client: fakeClient(okResponse('{"verdict":"ok"}'), calls),
  });

  const result = await provider!.generateStructured!({
    systemInstruction: "classify",
    input: { a: 1 },
    zodSchema: Schema,
    schemaName: "verdict",
    usageOperation: "excluded_topic_classification",
  });

  assert.deepEqual(result.value, { verdict: "ok" });
  assert.equal(result.provider, "openrouter");

  const format = calls[0].body.response_format as {
    type: string;
    json_schema: { name: string; strict: boolean };
  };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.name, "verdict");
  assert.equal(format.json_schema.strict, true);
  // Without this, OpenRouter's documented default lets a provider that does not
  // support response_format take the request and ignore it -- billing for prose
  // that then fails validation.
  assert.deepEqual(calls[0].body.provider, { require_parameters: true });

  const [usage] = result.usageEvents as Array<Record<string, unknown>>;
  assert.equal(usage.provider, "openrouter");
  // Chat-completions field names, not the Responses API's. Reading the wrong
  // pair would record every call as zero tokens.
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 3);
  // usage.cost is denominated in OpenRouter credits and this field is USD, so
  // it is deliberately not mapped across.
  assert.equal(usage.estimatedCostUsd, null);
});

test("anything that is not schema-valid JSON fails closed", async () => {
  const cases: unknown[] = [
    okResponse('{"verdict":42}'),
    okResponse("I cannot answer that."),
    okResponse(""),
    okResponse(null),
    {
      id: "gen-2",
      choices: [
        { message: { refusal: "no", content: null }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    },
  ];

  for (const response of cases) {
    const provider = createOpenRouterProvider(config, {
      client: fakeClient(response),
    });
    await assert.rejects(
      provider!.generateStructured!({
        systemInstruction: "s",
        input: {},
        zodSchema: Schema,
        schemaName: "verdict",
      }),
      "an unusable response must throw rather than return an unvalidated value",
    );
  }
});
