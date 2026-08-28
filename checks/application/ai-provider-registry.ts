import assert from "node:assert/strict";
import test from "node:test";

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

test("built-in descriptors are valid and uniquely identified", () => {
  assertValidDescriptors(BUILTIN_PROVIDER_DESCRIPTORS);
  assert.deepEqual(listProviderIds().sort(), ["exa", "gemini", "openai"]);
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

test("typed getAiProviderOrder matches the legacy runtime for every built-in id", () => {
  assert.deepEqual(getAiProviderOrder({}), getLegacyAiProviderOrder({}));
  const allIds = listProviderIds().join(",");
  assert.deepEqual(
    getAiProviderOrder({ AI_PROVIDER_ORDER: allIds }),
    getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: allIds }),
  );
});

// Drift guard: if a provider is ever added to the typed registry without a
// matching update to the legacy production runtime (src/ai-provider.js),
// this pair of tests fails — catching the divergence in CI instead of in
// production, where the two runtimes would otherwise silently disagree
// about which provider names are valid.
test("drift guard: every registry id is a name the legacy runtime still accepts", () => {
  const allIds = listProviderIds().join(",");
  assert.doesNotThrow(() => getLegacyAiProviderOrder({ AI_PROVIDER_ORDER: allIds }));
});

test("drift guard: legacy rejects an id the registry does not declare", () => {
  const allIds = listProviderIds().join(",");
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
