import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { getAiProviderOrder } from "../../src/ai/ai-provider-composition.js";
import {
  createOpenRouterProvider,
  DEFAULT_MIN_CONTEXT_TOKENS,
  DEFAULT_OPEN_ROUTER_MODEL,
  discoverOpenRouterModels,
  getOpenRouterConfig,
  OPEN_ROUTER_BASE_URL,
} from "../../src/ai/providers/openrouter.adapter.js";
import { openrouterProviderDescriptor } from "../../src/ai/providers/openrouter.provider.js";

const Schema = z.object({ verdict: z.string() });

const config = {
  apiKey: "k",
  preferredModels: ["some/model"] as readonly string[],
  baseUrl: OPEN_ROUTER_BASE_URL,
  minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
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

test("a key alone is enough; models come from the catalogue unless preferred ones are named", () => {
  assert.equal(getOpenRouterConfig({}), null);
  assert.equal(getOpenRouterConfig({ OPEN_ROUTER_API_KEY: "  " }), null);

  // Both spellings: the encrypted integration environment uses
  // OPEN_ROUTER_API_KEY, and the conventional one must not be silently ignored.
  for (const key of ["OPEN_ROUTER_API_KEY", "OPENROUTER_API_KEY"]) {
    const resolved = getOpenRouterConfig({ [key]: " k " });
    assert.equal(resolved?.apiKey, "k");
    assert.deepEqual(
      resolved?.preferredModels,
      [],
      "no preference means the whole catalogue, discovered at first use",
    );
    assert.equal(resolved?.minContextTokens, DEFAULT_MIN_CONTEXT_TOKENS);
    assert.equal(
      DEFAULT_MIN_CONTEXT_TOKENS,
      0,
      "every free model with structured outputs is a candidate by default",
    );
  }

  assert.equal(
    getOpenRouterConfig({ OPEN_ROUTER_API_KEY: "k", OPEN_ROUTER_MODEL: " a/b " })
      ?.preferredModels[0],
    "a/b",
    "an explicit model leads the walk",
  );

  // The pinned fallback must stay free: it is what discovery falls back to, and
  // a paid fallback would bill for a model nobody chose.
  assert.match(
    DEFAULT_OPEN_ROUTER_MODEL,
    /:free$/,
    "the fallback OpenRouter model must be a free one",
  );
});

test("discovery takes the largest free model that can do structured output", async () => {
  const catalogue = {
    data: [
      // Biggest window, but no structured outputs: unusable here, because
      // every call this adapter serves is generateStructured.
      { id: "huge/no-schema:free", context_length: 1_048_576, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      // Supports schemas and is huge, but is not free.
      { id: "paid/big:paid", context_length: 900_000, pricing: { prompt: "0.5", completion: "1" }, supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      // Small, but free and schema-capable: a candidate too, last in the
      // order. It is only ever reached if everything above it failed, which
      // beats falling through to a paid provider.
      { id: "small/ok:free", context_length: 65_536, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "good/mid:free", context_length: 262_144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "best/large:free", context_length: 512_000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      // A free music generator with a huge window. structured_outputs alone
      // would not have kept it out on its own, and nothing here would know
      // what to do with an audio response.
      { id: "music/maker:free", context_length: 1_048_576, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text"], output_modalities: ["audio"] } },
    ],
  };

  const chosen = await discoverOpenRouterModels({
    baseUrl: OPEN_ROUTER_BASE_URL,
    minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
    fetchImpl: (async () => ({ ok: true, json: async () => catalogue })) as never,
  });
  // The whole ranked list, largest context first -- not just the winner.
  // Calling the next free model costs nothing, so a model that will not answer
  // must not end the attempt.
  // best/large takes an image as INPUT and answers in text, so it stays: we
  // only ever send text, and what a model will read costs us nothing.
  // music/maker answers in audio and is excluded despite being free, huge, and
  // nominally schema-capable.
  assert.deepEqual(chosen, [
    "best/large:free",
    "good/mid:free",
    "small/ok:free",
  ]);
});

test("a catalogue that cannot be read falls back rather than breaking the provider", async () => {
  const cases: Array<typeof fetch> = [
    (async () => {
      throw new Error("network down");
    }) as never,
    (async () => ({ ok: false, json: async () => ({}) })) as never,
    (async () => ({ ok: true, json: async () => ({ data: [] }) })) as never,
    // Everything filtered out: free, but none schema-capable.
    (async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "x:free", context_length: 900_000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
        ],
      }),
    })) as never,
  ];

  for (const fetchImpl of cases) {
    assert.deepEqual(
      await discoverOpenRouterModels({
        baseUrl: OPEN_ROUTER_BASE_URL,
        minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
        fetchImpl,
      }),
      [DEFAULT_OPEN_ROUTER_MODEL],
      "discovery must never leave the provider without a model",
    );
  }
});

test("discovery runs once per process, not once per call", async () => {
  let lookups = 0;
  const provider = createOpenRouterProvider(
    { ...config, preferredModels: [] },
    {
      client: fakeClient(okResponse('{"verdict":"ok"}')),
      discover: async () => {
        lookups += 1;
        return ["discovered/model:free"];
      },
    },
  );

  const call = () =>
    provider!.generateStructured!({
      systemInstruction: "s",
      input: {},
      zodSchema: Schema,
      schemaName: "verdict",
    });

  // Concurrent first calls must share one lookup, not race into several.
  const [first] = await Promise.all([call(), call(), call()]);
  await call();

  assert.equal(lookups, 1, "the catalogue is read once, not per request");
  assert.equal(first.model, "discovered/model:free");
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
    fakeClient(okResponse('{"verdict":"ok"}')) as never,
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

test("a free model that will not answer is replaced by the next one, not by a paid provider", async () => {
  const tried: string[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          const model = body.model as string;
          tried.push(model);
          // The first free model is queued and never answers -- the exact
          // failure seen on the integration stage.
          if (model === "dead/queued:free") throw new Error("timed out");
          return okResponse('{"verdict":"ok"}') as never;
        },
      },
    },
  };

  const provider = createOpenRouterProvider(
    { ...config, preferredModels: [] },
    {
      client,
      discover: async () => ["dead/queued:free", "alive/fast:free"],
      perModelTimeoutMs: 50,
    },
  );

  const call = () =>
    provider!.generateStructured!({
      systemInstruction: "s",
      input: {},
      zodSchema: Schema,
      schemaName: "verdict",
    });

  const first = await call();
  assert.deepEqual(tried, ["dead/queued:free", "alive/fast:free"]);
  assert.equal(first.model, "alive/fast:free");

  // The model that answered goes to the front, so the next call does not
  // re-pay the dead one's timeout.
  await call();
  assert.deepEqual(tried, [
    "dead/queued:free",
    "alive/fast:free",
    "alive/fast:free",
  ]);
});

test("the provider is given longer than the cascade's paid-API deadline", () => {
  // 30s is tuned for a paid API answering in seconds. Free endpoints are
  // queued, and at 30s this provider timed out four times in a row on the
  // integration stage without ever getting to answer.
  const { deadlineMs } = openrouterProviderDescriptor.traits;
  assert.ok(
    typeof deadlineMs === "number" && deadlineMs > 30_000,
    "a free, queued provider needs more than the paid-API deadline",
  );
});

test("preferences lead the walk but never replace the catalogue", async () => {
  const tried: string[] = [];
  const provider = createOpenRouterProvider(
    {
      ...config,
      preferredModels: ["favourite/one:free", "favourite/two:free"],
    },
    {
      client: {
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              const model = body.model as string;
              tried.push(model);
              // Both favourites are rate limited, which is exactly what
              // happened on the integration stage: a preferred model answers
              // twice and is then throttled.
              if (model.startsWith("favourite/")) throw new Error("429");
              return okResponse('{"verdict":"ok"}') as never;
            },
          },
        },
      },
      discover: async () => ["catalogue/one:free"],
      perModelTimeoutMs: 50,
    },
  );

  const result = await provider!.generateStructured!({
    systemInstruction: "s",
    input: {},
    zodSchema: Schema,
    schemaName: "verdict",
  });

  // The point of the change: a throttled favourite must have somewhere FREE to
  // go. Replacing the catalogue with the preference list left a paid provider
  // as its only fallback, which is what this provider exists to avoid.
  assert.deepEqual(tried, [
    "favourite/one:free",
    "favourite/two:free",
    "catalogue/one:free",
  ]);
  assert.equal(result.model, "catalogue/one:free");
});

test("a model that stops working stops being preferred", async () => {
  let firstModelWorks = true;
  const tried: string[] = [];
  const provider = createOpenRouterProvider(
    { ...config, preferredModels: [] },
    {
      client: {
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              const model = body.model as string;
              tried.push(model);
              if (model === "first/one:free" && !firstModelWorks) {
                throw new Error("429");
              }
              return okResponse('{"verdict":"ok"}') as never;
            },
          },
        },
      },
      discover: async () => ["first/one:free", "second/one:free"],
      perModelTimeoutMs: 50,
    },
  );

  const call = () =>
    provider!.generateStructured!({
      systemInstruction: "s",
      input: {},
      zodSchema: Schema,
      schemaName: "verdict",
    });

  await call();
  firstModelWorks = false;
  await call();
  tried.length = 0;
  await call();

  // Without clearing the preference, the now-dead model would be retried first
  // on every later call, re-paying its rate limit before the walk could reach
  // anything that works.
  assert.deepEqual(tried, ["second/one:free"]);
});
