import test from "node:test";
import assert from "node:assert/strict";
import { generateDraft, validateGroundedDraft } from "../src/draft.js";
import { getGeminiConfig } from "../src/gemini-client.js";

const SOURCE_URL = "https://example.com/primary";
const TELEGRAM_TEXT = `AI agents move forward

A primary source announced a new AI agent.

Why it matters: the release may change research workflows.

Caveat: performance claims come from the developer.

Source:
${SOURCE_URL}`;

function structuredDraft(overrides = {}) {
  return {
    headline: "AI agents move forward",
    telegramText: TELEGRAM_TEXT,
    claims: [
      {
        text: "A primary source announced a new AI agent.",
        sourceUrl: SOURCE_URL,
      },
    ],
    sourceUrls: [SOURCE_URL],
    caveat: "Performance claims come from the developer.",
    ...overrides,
  };
}

test("getGeminiConfig requires a key and defaults the model", () => {
  assert.deepEqual(getGeminiConfig({ GEMINI_API_KEY: " key " }), {
    apiKey: "key",
    model: "gemini-2.5-flash",
  });
  assert.throws(() => getGeminiConfig({}), /GEMINI_API_KEY is required/);
});

test("validateGroundedDraft accepts only supplied citations", () => {
  assert.equal(
    validateGroundedDraft(structuredDraft(), [
      { url: SOURCE_URL, primary: true },
    ]).headline,
    "AI agents move forward",
  );
  assert.throws(
    () =>
      validateGroundedDraft(
        structuredDraft({
          claims: [{ text: "Unsupported", sourceUrl: "https://other.test/x" }],
        }),
        [{ url: SOURCE_URL, primary: true }],
      ),
    /unsupported source/,
  );
});

test("validateGroundedDraft deterministically appends validated source URLs", () => {
  const result = validateGroundedDraft(
    structuredDraft({
      telegramText: "AI agents move forward\n\nA grounded summary.",
    }),
    [{ url: SOURCE_URL, primary: true }],
  );

  assert.equal(
    result.telegramText,
    `AI agents move forward\n\nA grounded summary.\n\nSources:\n${SOURCE_URL}`,
  );
});

test("validateGroundedDraft rejects more than five prose sentences", () => {
  assert.throws(
    () =>
      validateGroundedDraft(
        structuredDraft({
          telegramText:
            "One. Two. Three. Four. Five. Six.\n\nSources:\n" + SOURCE_URL,
        }),
        [{ url: SOURCE_URL, primary: true }],
      ),
    /five-sentence limit/,
  );
});

test("generateDraft stores a review draft and advances article state", async () => {
  const writes = [];
  const client = {
    models: {
      async generateContent(request) {
        assert.equal(request.model, "gemini-2.5-flash");
        return { text: JSON.stringify(structuredDraft()) };
      },
    },
  };
  const repository = {
    async createReviewDraft(draft) {
      writes.push(draft);
      assert.equal(draft.status, "review");
      assert.equal(draft.body, TELEGRAM_TEXT);
      return { id: "draft-1", ...draft };
    },
  };
  const result = await generateDraft({
    client,
    model: "gemini-2.5-flash",
    repository,
    article: {
      id: "article-1",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
      published_at: "2026-06-26T00:00:00Z",
    },
    evidence: [
      {
        url: SOURCE_URL,
        primary: true,
        excerpt: "A primary source announced a new AI agent.",
      },
    ],
    lease: {
      name: "daily",
      ownerId: "00000000-0000-4000-8000-000000000001",
    },
  });

  assert.equal(result.saved.id, "draft-1");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].article_id, "article-1");
  assert.equal(writes[0].lease_name, "daily");
});

test("generateDraft fails before API use when evidence is not primary", async () => {
  await assert.rejects(
    generateDraft({
      client: {},
      model: "gemini-2.5-flash",
      repository: {},
      article: { id: "article-1" },
      evidence: [{ url: SOURCE_URL, primary: false }],
    }),
    /requires primary-source evidence/,
  );
});

test("generateDraft labels explicitly allowed community evidence as unverified", async () => {
  const repository = {
    async createReviewDraft(draft) {
      return { id: "draft-rumor", ...draft };
    },
  };
  const client = {
    models: {
      async generateContent() {
        return { text: JSON.stringify(structuredDraft()) };
      },
    },
  };
  const result = await generateDraft({
    client,
    model: "gemini-2.5-flash",
    repository,
    article: {
      id: "article-rumor",
      title: "Community rumor",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: false, text: "Unconfirmed claim" }],
    allowUnverified: true,
  });

  assert.match(result.saved.body, /^UNVERIFIED TREND/);
  assert.equal(result.saved.prompt_version, "telegram-unverified-trend-v2");
});
