import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";

import { BUILTIN_PROVIDER_DESCRIPTORS } from "../../src/ai/providers/index.js";
import {
  assertValidDescriptors,
  findDescriptor,
  getDefaultProviderOrder,
  listProviderIds,
} from "../../src/ai/providers/provider-registry.js";
import type { AiProviderDescriptor } from "../../src/ai/providers/provider-descriptor.contracts.js";
import {
  AiProvidersExhaustedError,
  createFallbackAiProvider,
  getAiProviderOrder,
} from "../../src/ai/ai-provider-composition.js";
import { getAiProviderOrder as getLegacyAiProviderOrder } from "../../src/ai-provider.js";
import { AiProvidersModule } from "../../src/ai/ai-providers.module.js";
import { AI_PROVIDER } from "../../src/ai/ai-provider.tokens.js";

test("built-in descriptors are valid and uniquely identified", () => {
  assertValidDescriptors(BUILTIN_PROVIDER_DESCRIPTORS);
  assert.deepEqual(listProviderIds().sort(), ["exa", "gemini", "openai", "openrouter"]);
});

test("registering a duplicate provider id is rejected", () => {
  const duplicate: AiProviderDescriptor = { ...findDescriptor("openai")! };
  assert.throws(
    () => assertValidDescriptors([...BUILTIN_PROVIDER_DESCRIPTORS, duplicate]),
    /Duplicate AI provider descriptor id: openai/,
  );
});

test("a descriptor with no declared capabilities is rejected", () => {
  const broken: AiProviderDescriptor = { ...findDescriptor("openai")!, id: "broken", capabilities: [] };
  assert.throws(
    () => assertValidDescriptors([...BUILTIN_PROVIDER_DESCRIPTORS, broken]),
    /declares no capabilities/,
  );
});

test("an unconfigured provider resolves to null rather than throwing", () => {
  const descriptor = findDescriptor("exa")!;
  assert.equal(descriptor.configure({}), null);
});

test("default order includes exa only when configured, openai/gemini unconditionally", () => {
  assert.deepEqual(getDefaultProviderOrder({}), ["openai", "gemini"]);
  assert.deepEqual(
    getDefaultProviderOrder({ EXA_ENABLED: "true", EXA_API_KEY: "key" }),
    ["exa", "openai", "gemini"],
  );
});

const sharedProviderIds = () =>
  BUILTIN_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => !descriptor.traits.typedRuntimeOnly,
  ).map((descriptor) => descriptor.id);

test("typed getAiProviderOrder matches the legacy runtime for every shared id", () => {
  assert.deepEqual(getAiProviderOrder({}), getLegacyAiProviderOrder({}));
  const sharedIds = sharedProviderIds().join(",");
  assert.deepEqual(
    getAiProviderOrder({ AI_PROVIDER_ORDER: sharedIds }),
    getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: sharedIds }),
  );
});

// Drift guard: if a provider is ever added to the typed registry without a
// matching update to the legacy production runtime (src/ai-provider.js),
// this pair of tests fails — catching the divergence in CI instead of in
// production, where the two runtimes would otherwise silently disagree
// about which provider names are valid.
test("drift guard: every shared registry id is a name the legacy runtime still accepts", () => {
  const sharedIds = sharedProviderIds().join(",");
  assert.doesNotThrow(() => getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: sharedIds }));
});

test("drift guard: a typed-only provider is genuinely rejected by the legacy runtime", () => {
  const typedOnly = BUILTIN_PROVIDER_DESCRIPTORS.filter(
    (descriptor) => descriptor.traits.typedRuntimeOnly,
  );
  assert.ok(typedOnly.length > 0, "openrouter is expected to be typed-only");

  // Without this, typedRuntimeOnly would be a way to opt out of the drift
  // guard by assertion rather than by fact: a provider could carry the flag,
  // quietly exist in both runtimes, and diverge exactly as the guard was
  // written to prevent.
  for (const descriptor of typedOnly) {
    assert.throws(
      () => getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: descriptor.id }),
      /Unsupported AI provider/,
      `${descriptor.id} claims to be typed-only, so the legacy runtime must not accept it`,
    );
  }
});

test("drift guard: legacy rejects an id the registry does not declare", () => {
  const allIds = sharedProviderIds().join(",");
  assert.throws(
    () => getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: `${allIds},not-a-real-provider` }),
    /Unsupported AI provider/,
  );
});

test("a synthetic metered provider's quota-halt trait stops the cascade without a name check", async () => {
  const calls: string[] = [];
  const meteredDescriptor: AiProviderDescriptor = {
    id: "synthetic-metered",
    displayName: "Synthetic Metered",
    capabilities: ["searchNews"],
    defaultOrderRank: 5,
    traits: { haltsCascadeOnQuotaExhaustion: true },
    configure: () => ({}),
    createClient: () => ({}),
    createAdapter: () => null,
  };
  const descriptors = [...BUILTIN_PROVIDER_DESCRIPTORS, meteredDescriptor];
  assertValidDescriptors(descriptors);

  const provider = createFallbackAiProvider(
    [
      {
        name: "synthetic-metered",
        async searchNews() {
          calls.push("synthetic-metered");
          throw Object.assign(new Error("cap"), { code: "exa_daily_search_cap", status: 429 });
        },
      },
      { name: "openai", async searchNews() { calls.push("openai"); return { provider: "openai" }; } },
    ],
    { log: { warn() {} }, sleep: async () => {}, descriptors },
  );

  await assert.rejects(provider.searchNews({}), AiProvidersExhaustedError);
  assert.deepEqual(calls, ["synthetic-metered"]);
});

test("a provider without the halt trait falls through to the next provider on the same error code", async () => {
  const calls: string[] = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async searchNews() {
          calls.push("openai");
          throw Object.assign(new Error("cap"), { code: "exa_daily_search_cap", status: 429 });
        },
      },
      { name: "gemini", async searchNews() { calls.push("gemini"); return { provider: "gemini" }; } },
    ],
    { log: { warn() {} }, sleep: async () => {} },
  );
  assert.equal((await provider.searchNews({})).provider, "gemini");
  assert.deepEqual(calls, ["openai", "gemini"]);
});

test("AiProvidersModule rejects a duplicate descriptor id before registering any provider", () => {
  const duplicate: AiProviderDescriptor = { ...findDescriptor("openai")! };
  assert.throws(
    () => AiProvidersModule.register({ descriptors: [...BUILTIN_PROVIDER_DESCRIPTORS, duplicate] }),
    /Duplicate AI provider descriptor id: openai/,
  );
});

test("AiProvidersModule threads custom descriptors through to the composed AI_PROVIDER, not just direct callers", async () => {
  // Regression test: an earlier version of ai-providers.module.ts called
  // getAiProviderOrder(settings, descriptors) but omitted `descriptors` from
  // createFallbackAiProvider's options, so trait lookups silently fell back
  // to BUILTIN_PROVIDER_DESCRIPTORS and a custom descriptor's traits were
  // never honored once wired through the real Nest module. Both providers
  // here are synthetic (no OPENAI_API_KEY/GEMINI_API_KEY/EXA_* set, so none
  // of the built-ins configure) — a real provider adapter would make a live
  // network call on fallthrough instead of failing this test outright.
  const calls: string[] = [];
  const meteredDescriptor: AiProviderDescriptor = {
    id: "synthetic-metered",
    displayName: "Synthetic Metered",
    capabilities: ["searchNews"],
    defaultOrderRank: 5,
    traits: { haltsCascadeOnQuotaExhaustion: true },
    configure: () => ({}),
    createClient: () => ({}),
    createAdapter: () => ({
      name: "synthetic-metered",
      async searchNews() {
        calls.push("synthetic-metered");
        throw Object.assign(new Error("cap"), { code: "exa_daily_search_cap", status: 429 });
      },
    }),
  };
  const fallbackDescriptor: AiProviderDescriptor = {
    id: "synthetic-fallback",
    displayName: "Synthetic Fallback",
    capabilities: ["searchNews"],
    defaultOrderRank: 6,
    traits: {},
    configure: () => ({}),
    createClient: () => ({}),
    createAdapter: () => ({
      name: "synthetic-fallback",
      async searchNews() {
        calls.push("synthetic-fallback");
        return { provider: "synthetic-fallback" };
      },
    }),
  };

  const module = await Test.createTestingModule({
    imports: [
      AiProvidersModule.register({
        env: { AI_PROVIDER_ORDER: "synthetic-metered,synthetic-fallback" },
        descriptors: [...BUILTIN_PROVIDER_DESCRIPTORS, meteredDescriptor, fallbackDescriptor],
      }),
    ],
  }).compile();
  try {
    const provider = module.get(AI_PROVIDER);
    await assert.rejects(provider.searchNews({}), AiProvidersExhaustedError);
    // If the trait weren't honored, the cascade would fall through and
    // calls would be ["synthetic-metered", "synthetic-fallback"] instead.
    assert.deepEqual(calls, ["synthetic-metered"]);
  } finally {
    await module.close();
  }
});

test("testConnection is generic; testExaConnection is a thin alias over it", async () => {
  const calls: string[] = [];
  const provider = createFallbackAiProvider(
    [{ name: "exa", async testConnection() { calls.push("exa"); return { ok: true }; } }],
    { log: { warn() {} } },
  );
  assert.deepEqual(await provider.testConnection("exa"), { ok: true });
  assert.deepEqual(await provider.testExaConnection(), { ok: true });
  assert.deepEqual(calls, ["exa", "exa"]);
  await assert.rejects(provider.testConnection("openai"), AiProvidersExhaustedError);
});
