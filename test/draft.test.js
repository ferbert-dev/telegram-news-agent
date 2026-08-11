import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_TELEGRAM_DRAFT_JSON_SCHEMA,
  generateDraft,
  TELEGRAM_DRAFT_JSON_SCHEMA,
  validateGroundedDraft,
} from "../src/draft.js";
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
    topicTags: [],
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

test("TelegramDraft structured output requires bounded topic assignments", () => {
  assert.equal(
    BASE_TELEGRAM_DRAFT_JSON_SCHEMA.required.includes("topicTags"),
    false,
  );
  assert.ok(TELEGRAM_DRAFT_JSON_SCHEMA.required.includes("topicTags"));
  assert.equal(
    TELEGRAM_DRAFT_JSON_SCHEMA.properties.topicTags.maxItems,
    3,
  );
  assert.deepEqual(
    TELEGRAM_DRAFT_JSON_SCHEMA.properties.topicTags.items.required,
    ["code", "confidence"],
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

test("validateGroundedDraft appends localized source headings", () => {
  const result = validateGroundedDraft(
    structuredDraft({
      headline: "Neue Forschung",
      telegramText: "Neue Forschung\n\nEine belegte Zusammenfassung.",
    }),
    [{ url: SOURCE_URL, primary: true }],
    { languageCode: "de" },
  );

  assert.equal(
    result.telegramText,
    `Neue Forschung\n\nEine belegte Zusammenfassung.\n\nQuellen:\n${SOURCE_URL}`,
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
      assert.match(draft.body, /Found and prepared for you by Михаил Онест/);
      assert.match(draft.body, /Source:\nhttps:\/\/example\.com\/primary$/);
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
  assert.deepEqual(JSON.parse(writes[0].reviewer_notes).topic_tags, []);
  assert.equal(
    JSON.parse(writes[0].reviewer_notes).article_tagging_state,
    "off",
  );
  assert.equal(
    JSON.parse(writes[0].reviewer_notes).editorial_enrichment.status,
    "disabled",
  );
});

for (const [state, selectedVersion] of [
  ["collect", "baseline"],
  ["enabled", "enriched"],
]) {
  test(`editorial ${state} preserves both drafts and selects ${selectedVersion}`, async () => {
    let calls = 0;
    let stored;
    const enrichedText = `A result that changes the clock

A primary source announced a new AI agent. The practical question is whether the reported result survives wider testing.

Sources:
${SOURCE_URL}`;
    const aiProvider = {
      async generateStructured(request) {
        calls += 1;
        if (request.usageOperation === "editorial_enrichment") {
          return {
            value: {
              draft: structuredDraft({
                headline: "A result that changes the clock",
                telegramText: enrichedText,
              }),
              evidenceMap: [
                {
                  claim: "A primary source announced a new AI agent.",
                  sourceUrl: SOURCE_URL,
                  evidenceExcerpt:
                    "A primary source announced a new AI agent.",
                },
              ],
              factRequest: null,
            },
            provider: "openai",
            model: "configured-editor-model",
          };
        }
        return {
          value: structuredDraft(),
          provider: "openai",
          model: "configured-baseline-model",
        };
      },
    };

    const result = await generateDraft({
      aiProvider,
      repository: {
        async createReviewDraft(draft) {
          stored = draft;
          return { id: `draft-${state}`, ...draft };
        },
      },
      article: {
        id: `article-${state}`,
        title: "Primary announcement",
        canonical_url: SOURCE_URL,
      },
      evidence: [
        {
          url: SOURCE_URL,
          primary: true,
          text: "A primary source announced a new AI agent.",
        },
      ],
      editorialEnrichment: { state },
    });

    assert.equal(calls, 2);
    const notes = JSON.parse(stored.reviewer_notes).editorial_enrichment;
    assert.equal(notes.status, "completed");
    assert.equal(notes.selected_version, selectedVersion);
    assert.match(notes.baseline_draft.telegramText, /AI agents move forward/);
    assert.match(notes.enriched_draft.telegramText, /changes the clock/);
    assert.equal(notes.evidence_map[0].sourceUrl, SOURCE_URL);
    if (state === "enabled") {
      assert.match(stored.body, /changes the clock/);
      assert.equal(stored.model, "configured-editor-model");
      assert.match(stored.prompt_version, /editorial-enrichment-v1$/);
    } else {
      assert.match(stored.body, /AI agents move forward/);
      assert.equal(stored.model, "configured-baseline-model");
      assert.doesNotMatch(stored.prompt_version, /editorial-enrichment/);
    }
    assert.equal(result.editorialEnrichment.selectedVersion, selectedVersion);
  });
}

test("invalid editorial output falls back to the baseline without blocking review", async () => {
  let stored;
  let calls = 0;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured(request) {
        calls += 1;
        if (request.usageOperation === "editorial_enrichment") {
          return {
            value: {
              draft: structuredDraft({
                claims: [
                  {
                    text: "An invented claim.",
                    sourceUrl: SOURCE_URL,
                  },
                ],
              }),
              evidenceMap: [
                {
                  claim: "An invented claim.",
                  sourceUrl: SOURCE_URL,
                  evidenceExcerpt: "Text absent from the evidence.",
                },
              ],
              factRequest: null,
            },
            provider: "openai",
            model: "configured-editor-model",
          };
        }
        return {
          value: structuredDraft(),
          provider: "openai",
          model: "configured-baseline-model",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-fallback", ...draft };
      },
    },
    article: {
      id: "article-fallback",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [
      {
        url: SOURCE_URL,
        primary: true,
        text: "A primary source announced a new AI agent.",
      },
    ],
    editorialEnrichment: { state: "enabled" },
  });

  assert.equal(calls, 2);
  assert.match(stored.body, /AI agents move forward/);
  assert.equal(result.editorialEnrichment.status, "fallback_to_baseline");
  assert.equal(result.editorialEnrichment.diagnostic, "enrichment_failed");
});

test("tagging off normalizes model assignments without persistence or hashtags", async () => {
  let stored;
  let replaced = false;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured(request) {
        assert.doesNotMatch(request.systemInstruction, /topic tag/i);
        assert.equal(request.input.articleTagging, undefined);
        assert.equal(request.schemaName, "telegram_news_draft");
        assert.equal(request.jsonSchema.required.includes("topicTags"), false);
        return {
          value: structuredDraft({
            topicTags: [{ code: "MODEL INVENTED!", confidence: "certain" }],
          }),
          provider: "openai",
          model: "gpt-test",
        };
      },
    },
    repository: {
      async replaceArticleTopics() {
        replaced = true;
      },
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-off", ...draft };
      },
    },
    article: {
      id: "article-off",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
  });

  assert.equal(replaced, false);
  assert.deepEqual(result.draft.topicTags, []);
  assert.doesNotMatch(stored.body, /#model-invented/i);
  assert.deepEqual(JSON.parse(stored.reviewer_notes).topic_tags, []);
});

test("collect mode stores catalog-only assignments without rendering hashtags", async () => {
  let request;
  let stored;
  const catalog = [
    {
      code: "science",
      label: "Science",
      hashtag: { en: "#Science", de: "#Wissenschaft" },
      description: "Research and discoveries",
    },
    {
      code: "nature",
      label: "Nature",
      hashtag: "#Nature",
    },
  ];
  const result = await generateDraft({
    aiProvider: {
      async generateStructured(value) {
        request = value;
        assert.equal(value.schemaName, "telegram_news_draft_with_tags");
        assert.ok(value.jsonSchema.required.includes("topicTags"));
        return {
          value: structuredDraft({
            topicTags: [
              { code: "science", confidence: 0.94 },
              { code: "nature", confidence: 0.55 },
            ],
          }),
          provider: "openai",
          model: "gpt-tagging",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-collect", ...draft };
      },
    },
    article: {
      id: "article-collect",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
    articleTagging: { state: "collect", catalog },
  });

  assert.match(request.systemInstruction, /one primary topic and up to two secondary/);
  assert.deepEqual(request.input.articleTagging.catalog, [
    {
      code: "science",
      label: "Science",
      description: "Research and discoveries",
    },
    { code: "nature", label: "Nature" },
  ]);
  const assignments = [
    { code: "science", confidence: 0.94 },
    { code: "nature", confidence: 0.55 },
  ];
  assert.deepEqual(stored.topic_assignments, assignments);
  assert.equal(stored.topic_assignment_source, "ai");
  assert.equal(stored.topic_assigned_model, "gpt-tagging");
  assert.deepEqual(result.draft.topicTags, assignments);
  assert.doesNotMatch(stored.body, /#Science|#Nature/);
  const notes = JSON.parse(stored.reviewer_notes);
  assert.equal(notes.article_tagging_state, "collect");
  assert.deepEqual(notes.topic_tags, assignments);
});

test("enabled mode appends deterministic localized catalog hashtags at the end", async () => {
  let stored;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured() {
        return {
          value: structuredDraft({
            topicTags: [
              { code: "nature", confidence: 0.59 },
              { code: "world", confidence: 0.8 },
              { code: "science", confidence: 0.95 },
            ],
          }),
          provider: "openai",
          model: "gpt-tagging",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-enabled", ...draft };
      },
    },
    article: {
      id: "article-enabled",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
    languageCode: "de",
    articleTagging: {
      state: "enabled",
      catalog: [
        {
          code: "science",
          label: "Science",
          hashtag: { en: "#Science", de: "#Wissenschaft" },
        },
        { code: "world", label: "World", hashtag: "#WorldNews" },
        { code: "nature", label: "Nature", hashtag: "#Nature" },
      ],
    },
  });

  assert.match(
    stored.body,
    /Für Sie gefunden und aufbereitet von Михаил Онест\n\nSource:\nhttps:\/\/example\.com\/primary\n\n#Wissenschaft #WorldNews$/,
  );
  assert.doesNotMatch(stored.body, /#Nature/);
  assert.deepEqual(stored.topic_assignments, [
    { code: "nature", confidence: 0.59 },
    { code: "world", confidence: 0.8 },
    { code: "science", confidence: 0.95 },
  ]);
  assert.equal(result.draft.telegramText, stored.body);
});

test("collect mode discards model-created codes without blocking the draft", async () => {
  let stored;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured() {
        return {
          value: structuredDraft({
            topicTags: [{ code: "invented", confidence: 0.9 }],
          }),
          provider: "openai",
          model: "gpt-tagging",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-invalid-tag", ...draft };
      },
    },
    article: {
      id: "article-invalid-tag",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
    articleTagging: {
      state: "collect",
      catalog: [
        { code: "science", label: "Science", hashtag: "#Science" },
      ],
    },
  });

  assert.deepEqual(stored.topic_assignments, []);
  assert.equal(stored.topic_assignment_source, "ai");
  assert.equal(stored.topic_assigned_model, "gpt-tagging");
  assert.deepEqual(result.draft.topicTags, []);
  assert.doesNotMatch(stored.body, /invented/i);
  const notes = JSON.parse(stored.reviewer_notes);
  assert.deepEqual(notes.topic_tags, []);
  assert.equal(notes.article_tagging_state, "collect");
  assert.equal(
    notes.topic_tagging_diagnostic,
    "invalid_assignments_discarded",
  );
});

test("generateDraft records the provider and actual fallback model", async () => {
  let stored;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured() {
        return {
          value: structuredDraft(),
          provider: "gemini",
          model: "gemini-2.5-flash",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-provider", ...draft };
      },
    },
    article: {
      id: "article-provider",
      title: "Primary announcement",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
  });

  assert.equal(result.provider, "gemini");
  assert.equal(stored.model, "gemini-2.5-flash");
  assert.equal(JSON.parse(stored.reviewer_notes).provider, "gemini");
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

test("generateDraft labels extracted web reporting without a rumor prefix", async () => {
  let stored;
  const repository = {
    async createReviewDraft(draft) {
      stored = draft;
      return { id: "draft-web", ...draft };
    },
  };
  const aiProvider = {
    async generateStructured(request) {
      assert.match(request.systemInstruction, /live internet search/);
      return {
        value: structuredDraft(),
        provider: "openai",
        model: "gpt-5.4-2026-03-05",
      };
    },
  };

  const result = await generateDraft({
    aiProvider,
    repository,
    article: {
      id: "article-web",
      title: "Independent report",
      canonical_url: SOURCE_URL,
    },
    evidence: [
      {
        url: SOURCE_URL,
        primary: false,
        verificationStatus: "web_source",
        publisher: "example.com",
        text: "Extracted direct article evidence.",
      },
    ],
    allowUnverified: true,
  });

  assert.doesNotMatch(result.saved.body, /^UNVERIFIED TREND/);
  assert.equal(result.saved.prompt_version, "telegram-web-grounded-v1");
  assert.equal(
    JSON.parse(stored.reviewer_notes).verification_status,
    "web_source",
  );
});

test("generateDraft records blocked-page web search evidence separately", async () => {
  let stored;
  const result = await generateDraft({
    aiProvider: {
      async generateStructured(request) {
        assert.match(request.systemInstruction, /publisher page could not be extracted/);
        return {
          value: structuredDraft(),
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-web-summary", ...draft };
      },
    },
    article: {
      id: "article-web-summary",
      title: "Publisher-blocked report",
      canonical_url: SOURCE_URL,
    },
    evidence: [
      {
        url: SOURCE_URL,
        primary: false,
        verificationStatus: "web_search_summary",
        publisher: "example.com",
        text: "Web-grounded search evidence.",
      },
    ],
    allowUnverified: true,
  });

  assert.doesNotMatch(result.saved.body, /^UNVERIFIED TREND/);
  assert.equal(
    result.saved.prompt_version,
    "telegram-web-search-grounded-v1",
  );
  assert.equal(
    JSON.parse(stored.reviewer_notes).verification_status,
    "web_search_summary",
  );
});

test("generateDraft requests German output without changing grounding rules", async () => {
  let request;
  let stored;
  const germanDraft = structuredDraft({
    headline: "Neue Entdeckung",
    telegramText: `Neue Entdeckung\n\nEine Quelle meldet eine Entdeckung.\n\nQuellen:\n${SOURCE_URL}`,
    claims: [
      {
        text: "Eine Quelle meldet eine Entdeckung.",
        sourceUrl: SOURCE_URL,
      },
    ],
    caveat: "Bisher gibt es nur eine Quelle.",
  });

  await generateDraft({
    aiProvider: {
      async generateStructured(value) {
        request = value;
        return {
          value: germanDraft,
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        stored = draft;
        return { id: "draft-de", ...draft };
      },
    },
    article: {
      id: "article-de",
      title: "Discovery",
      canonical_url: SOURCE_URL,
    },
    evidence: [{ url: SOURCE_URL, primary: true, text: "Evidence" }],
    languageCode: "de",
    newsSettings: {
      languageCode: "de",
      topicCodes: ["science"],
      version: 8,
    },
  });

  assert.match(request.systemInstruction, /in German/);
  assert.doesNotMatch(request.systemInstruction, /AI news channel/);
  const notes = JSON.parse(stored.reviewer_notes);
  assert.equal(notes.language_code, "de");
  assert.equal(notes.news_settings.version, 8);
});

test("unverified warning prefix is localized for Ukrainian output", async () => {
  const result = await generateDraft({
    aiProvider: {
      async generateStructured() {
        return {
          value: structuredDraft({
            headline: "Неперевірена новина",
            telegramText: `Неперевірена новина\n\nСпільнота обговорює можливу подію.\n\nДжерела:\n${SOURCE_URL}`,
            claims: [
              {
                text: "Спільнота обговорює можливу подію.",
                sourceUrl: SOURCE_URL,
              },
            ],
            caveat: "Немає незалежного підтвердження.",
          }),
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
        };
      },
    },
    repository: {
      async createReviewDraft(draft) {
        return { id: "draft-uk", ...draft };
      },
    },
    article: {
      id: "article-uk",
      title: "Rumor",
      canonical_url: SOURCE_URL,
    },
    evidence: [
      {
        url: SOURCE_URL,
        primary: false,
        verificationStatus: "unverified_community",
        text: "Community claim",
      },
    ],
    allowUnverified: true,
    languageCode: "uk",
  });

  assert.match(result.saved.body, /^НЕПЕРЕВІРЕНИЙ ТРЕНД/);
});
