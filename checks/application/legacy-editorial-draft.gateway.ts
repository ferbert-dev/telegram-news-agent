import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { LegacyEditorialDraftGateway } from "../../src/editorial/legacy-editorial-draft.gateway.js";
import type {
  GenerateReviewDraftInput,
} from "../../src/editorial/editorial-application.contracts.js";
import type { ArticleRow } from "../../src/research/research-persistence.contracts.js";

const ARTICLE: ArticleRow = {
  id: "article-1",
  source_id: "source-1",
  search_run_id: "run-1",
  canonical_url: "https://example.test/article",
  title: "Grounded article",
  author: null,
  published_at: null,
  discovered_at: "2026-08-12T09:00:00.000Z",
  content_hash: "hash",
  status: "extracted",
  metadata: {},
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T09:00:00.000Z",
};

const CATALOG = [{ code: "tech", label: "Tech" }];

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function fixtureInput(
  article: ArticleRow = ARTICLE,
  settingsSnapshot?: Record<string, unknown> | null,
  featureFlags?: Record<string, unknown> | unknown[],
): GenerateReviewDraftInput {
  const input: GenerateReviewDraftInput = {
    article,
    evidence: [{
      url: article.canonical_url,
      text: "Source text",
      primary: true,
    }],
    languageCode: "en",
    channelId: "@channel",
    allowUnverified: false,
    lease: { name: "daily", ownerId: "owner-1" },
  };
  if (settingsSnapshot !== undefined) {
    input.settingsSnapshot = settingsSnapshot as never;
  }
  if (featureFlags !== undefined) {
    input.featureFlags = featureFlags as never;
  }
  return input;
}

test("LegacyEditorialDraftGateway preserves dependency values and identity, uses isolated repository facade, and normalizes Draft generation output", async () => {
  const signal = new AbortController().signal;
  const featureFlags = [{ feature_key: "article_tags", state: "collect" }];
  let legacyCallArgs: any;
  let legacyCallSignal: AbortSignal | undefined;
  let legacyCallCount = 0;
  let outerCreateReviewDraftCalled = false;
  let outerRecordAiUsageCalled = false;
  let getFeatureFlagsCalled = 0;
  let listTagsCalled = 0;
  const delegatedReceiverChecks: { getNewsFeatureFlags: boolean; listTags: boolean } = {
    getNewsFeatureFlags: false,
    listTags: false,
  };

  const originalCreateReviewDraft = async () => {
    outerCreateReviewDraftCalled = true;
    throw new Error("outer createReviewDraft should not be called");
  };
  const originalRecordAiUsage = async () => {
    outerRecordAiUsageCalled = true;
    throw new Error("outer recordAiUsage should not be called");
  };

  const repository = {
    async getNewsFeatureFlags() {
      delegatedReceiverChecks.getNewsFeatureFlags = this === repository;
      getFeatureFlagsCalled += 1;
      return [{ feature_key: "article_tags", state: "collect" }] as {
        feature_key?: string;
        state?: string;
      }[];
    },
    async listEnabledArticleTags(languageCode: string) {
      delegatedReceiverChecks.listTags = this === repository;
      listTagsCalled += 1;
      assert.equal(languageCode, "en");
      return CATALOG;
    },
    createReviewDraft: originalCreateReviewDraft,
    recordAiUsage: originalRecordAiUsage,
  };

  const aiProvider = {};
  const editor = { id: "editor-1" };
  const input = fixtureInput(
    ARTICLE,
    { channelId: "@channel", languageCode: "en" },
    featureFlags,
  );

  const result = await new LegacyEditorialDraftGateway(
    {
      aiProvider,
      model: "provider-model",
      repository,
      editor,
    },
    async (args, signalFromGenerate) => {
      legacyCallCount += 1;
      legacyCallArgs = args;
      legacyCallSignal = signalFromGenerate;

      const flags = await args.repository.getNewsFeatureFlags?.("@channel");
      assert.deepEqual(flags, [{ feature_key: "article_tags", state: "collect" }]);
      const tags = await args.repository.listEnabledArticleTags?.("en");
      assert.deepEqual(tags, CATALOG);
      assert.equal(args.repository.createReviewDraft !== repository.createReviewDraft, true);
      assert.equal(args.repository.recordAiUsage !== repository.recordAiUsage, true);
      await args.repository.recordAiUsage?.({
        provider: "openai",
        providerResponseId: "resp-1",
        model: "provider-model",
        operation: "editorial",
      });
      const saved = await args.repository.createReviewDraft({
        article_id: args.article.id,
        body: "Generated body",
        model: "provider-model",
        prompt_version: "telegram-grounded-v2",
        reviewer_notes: "{}",
      }) as {
        article_id: string;
        body: string;
      };

      return {
        draft: { telegramText: "Generated body" },
        baselineDraft: { tag: "baseline" },
        enrichedDraft: null,
        editorialEnrichment: { state: "enabled" },
        saved: {
          article_id: saved.article_id,
          body: saved.body,
          model: "provider-model",
          prompt_version: "telegram-grounded-v2",
          reviewer_notes: "{}",
          lease_name: "daily",
          lease_owner_id: "owner-1",
          topic_assignments: undefined,
          topic_assignment_source: null,
          topic_assigned_model: null,
        },
        provider: "openai",
        model: "provider-model",
      };
    },
  ).generate(input, signal);

  assert.equal(legacyCallCount, 1);
  assert.equal(legacyCallArgs.aiProvider, aiProvider);
  assert.equal(legacyCallArgs.client, undefined);
  assert.equal(legacyCallArgs.model, "provider-model");
  assert.equal(legacyCallArgs.article, input.article);
  assert.equal(legacyCallArgs.evidence, input.evidence);
  assert.equal(legacyCallArgs.allowUnverified, false);
  assert.deepEqual(legacyCallArgs.lease, input.lease);
  assert.equal(legacyCallArgs.languageCode, input.languageCode);
  assert.equal(legacyCallArgs.newsSettings, input.settingsSnapshot);
  assert.equal(legacyCallArgs.editor, editor);
  assert.deepEqual(legacyCallArgs.articleTagging, { state: "collect", catalog: CATALOG });
  assert.deepEqual(legacyCallArgs.editorialEnrichment, { state: "off" });
  assert.equal(legacyCallSignal, signal);

  assert.equal(delegatedReceiverChecks.getNewsFeatureFlags, true);
  assert.equal(delegatedReceiverChecks.listTags, true);
  assert.equal(getFeatureFlagsCalled, 1);
  assert.equal(listTagsCalled, 2);

  assert.deepEqual(result, {
    draft: {
      article_id: ARTICLE.id,
      body: "Generated body",
      model: "provider-model",
      prompt_version: "telegram-grounded-v2",
      reviewer_notes: "{}",
      lease_name: "daily",
      lease_owner_id: "owner-1",
      topic_assignments: [],
      topic_assignment_source: null,
      topic_assigned_model: "provider-model",
    },
    usageEvents: [
      {
        provider: "openai",
        providerResponseId: "resp-1",
        model: "provider-model",
        operation: "editorial",
      },
    ],
    output: {
      baselineDraft: { tag: "baseline" },
      enrichedDraft: null,
      editorialEnrichment: { state: "enabled" },
      selectedModel: "provider-model",
      selectedProvider: "openai",
    },
  });

  assert.equal(outerCreateReviewDraftCalled, false);
  assert.equal(outerRecordAiUsageCalled, false);
  assert.equal(repository.createReviewDraft, originalCreateReviewDraft);
  assert.equal(repository.recordAiUsage, originalRecordAiUsage);
});

test("LegacyEditorialDraftGateway loads feature flags from repository when input snapshot is missing", async () => {
  const repositoryFlags = [{ feature_key: "article_tags", state: "collect" }] as {
    feature_key?: string;
    state?: string;
  }[];
  let featureFlagReloadCount = 0;

  const repository = {
    async getNewsFeatureFlags() {
      featureFlagReloadCount += 1;
      return repositoryFlags;
    },
    async listEnabledArticleTags() {
      return CATALOG;
    },
    createReviewDraft: async () => ({
      id: "ignored",
      article_id: ARTICLE.id,
      body: "Generated body",
      status: "review",
      model: null,
      prompt_version: null,
      reviewer_notes: null,
    }),
    recordAiUsage: async () => ({ id: "ignored" }),
  };

  const result = await new LegacyEditorialDraftGateway(
    {
      model: "provider-model",
      repository,
    },
    async (args) => ({
      draft: { telegramText: "Generated body" },
      baselineDraft: { tag: "baseline" },
      enrichedDraft: null,
      editorialEnrichment: { state: "off" },
      saved: {
        article_id: args.article.id,
        body: "Generated body",
        model: null,
        prompt_version: "telegram-grounded-v2",
        reviewer_notes: null,
      },
      provider: "openai",
      model: "gpt-test",
    }),
  ).generate(fixtureInput(ARTICLE, { channelId: "@channel", languageCode: "en" }));

  assert.equal(featureFlagReloadCount, 1);
  assert.equal(result.draft.article_id, ARTICLE.id);
  assert.deepEqual(result.draft.topic_assignments, []);
});

test("LegacyEditorialDraftGateway builds effective news settings from input when snapshot is missing", async () => {
  const repositoryFlags = [
    { feature_key: "article_tags", state: "enabled" },
    { feature_key: "editorial_enrichment", state: "enabled" },
  ] as {
    feature_key?: string;
    state?: string;
  }[];
  const snapshotReloadArgs: {
    featureFlagsChannelId?: string;
    articleTagLanguageCode?: string;
  } = {};
  let featureFlagReloadCount = 0;
  let listEnabledArticleTagsCount = 0;

  const repository = {
    async getNewsFeatureFlags(channelId: string) {
      featureFlagReloadCount += 1;
      snapshotReloadArgs.featureFlagsChannelId = channelId;
      return repositoryFlags;
    },
    async listEnabledArticleTags(languageCode: string) {
      listEnabledArticleTagsCount += 1;
      snapshotReloadArgs.articleTagLanguageCode = languageCode;
      return CATALOG;
    },
    createReviewDraft: async () => ({
      id: "ignored",
      article_id: ARTICLE.id,
      body: "Generated body",
      status: "review",
      model: "provider-model",
      prompt_version: "telegram-grounded-v2",
      reviewer_notes: "{}",
    }),
    recordAiUsage: async () => ({ id: "ignored" }),
  };

  const result = await new LegacyEditorialDraftGateway(
    {
      model: "provider-model",
      repository,
    },
    async (args) => {
      assert.deepEqual(args.newsSettings, {
        channelId: "@channel",
        languageCode: "en",
      });
      assert.deepEqual(args.articleTagging, {
        state: "enabled",
        catalog: CATALOG,
      });
      assert.deepEqual(args.editorialEnrichment, { state: "enabled" });
      return {
        draft: { telegramText: "Generated body" },
        baselineDraft: { tag: "baseline" },
        enrichedDraft: null,
        editorialEnrichment: { state: "enabled" },
        saved: {
          article_id: args.article.id,
          body: "Generated body",
          model: "provider-model",
          prompt_version: "telegram-grounded-v2",
          reviewer_notes: "{}",
        },
        provider: "openai",
        model: "provider-model",
      };
    },
  ).generate(fixtureInput(ARTICLE));

  assert.equal(featureFlagReloadCount, 1);
  assert.equal(listEnabledArticleTagsCount, 1);
  assert.equal(snapshotReloadArgs.featureFlagsChannelId, "@channel");
  assert.equal(snapshotReloadArgs.articleTagLanguageCode, "en");
  assert.equal(
    (result.output as { editorialEnrichment?: { state: string } })
      .editorialEnrichment?.state,
    "enabled",
  );
  assert.deepEqual(result.draft.topic_assignment_source, null);
  assert.deepEqual(result.draft.topic_assignments, []);
});

test("LegacyEditorialDraftGateway does not reload feature flags when snapshot includes explicit empty featureFlags array", async () => {
  let featureFlagReloadCount = 0;

  const repository = {
    async getNewsFeatureFlags() {
      featureFlagReloadCount += 1;
      throw new Error("repository feature flag reload should not run");
    },
    listEnabledArticleTags: async () => {
      throw new Error("article tags should not be loaded from repository");
    },
    createReviewDraft: async () => ({
      id: "ignored",
      article_id: ARTICLE.id,
      body: "Generated body",
      status: "review",
      model: null,
      prompt_version: null,
      reviewer_notes: null,
    }),
    recordAiUsage: async () => ({ id: "ignored" }),
  };

  const result = await new LegacyEditorialDraftGateway(
    {
      model: "provider-model",
      repository,
    },
    async (args) => {
      assert.equal(args.articleTagging.state, "off");

      const saved = await args.repository.createReviewDraft({
        article_id: args.article.id,
        body: "Generated body",
        model: null,
        prompt_version: "telegram-grounded-v2",
        reviewer_notes: null,
      }) as { article_id: string; body: string };

      return {
        draft: { telegramText: "Generated body" },
        baselineDraft: { tag: "baseline" },
        enrichedDraft: null,
        editorialEnrichment: { state: "off" },
        saved: {
          article_id: saved.article_id,
          body: saved.body,
          model: "provider-model",
          prompt_version: "telegram-grounded-v2",
          reviewer_notes: "{}",
        },
        provider: "openai",
        model: "provider-model",
      };
    },
  ).generate(fixtureInput(ARTICLE, {}, { featureFlags: [] }));

  assert.equal(featureFlagReloadCount, 0);
  // Absent, not null. This assertion previously pinned `null`, which was the
  // migration bug rather than the intended behaviour: src/draft.js omits the
  // key entirely when tagging is off, and the repository distinguishes an
  // omitted key (use create_review_draft) from a present one (use
  // create_review_draft_with_topics, and stringify the value). A present null
  // was stringified to the JSON literal `null` and refused, so every review
  // draft failed whenever tagging was off.
  //
  // Asserted with `in` rather than a value comparison, because absent and
  // present-and-undefined are the same under deepEqual and are exactly what
  // this needs to tell apart.
  assert.equal(
    "topic_assignments" in (result.draft as object),
    false,
    "tagging off must omit the key, matching src/draft.js",
  );
});

test("LegacyEditorialDraftGateway preserves generator failure identity and keeps original repository methods unchanged", async () => {
  const failure = new Error("legacy failure");
  let outerCreateCalled = false;
  let outerRecordCalled = false;

  const originalCreateReviewDraft = async () => {
    outerCreateCalled = true;
    return { id: "unexpected" } as never;
  };
  const originalRecordAiUsage = async () => {
    outerRecordCalled = true;
    return { id: "unexpected" } as never;
  };
  const repository = {
    async getNewsFeatureFlags() {
      return [{ feature_key: "article_tags", state: "off" }] as {
        feature_key?: string;
        state?: string;
      }[];
    },
    createReviewDraft: originalCreateReviewDraft,
    recordAiUsage: originalRecordAiUsage,
  };

  const gateway = new LegacyEditorialDraftGateway(
    {
      model: "provider-model",
      repository,
      editor: undefined,
    },
    async () => {
      throw failure;
    },
  );

  await assert.rejects(
    gateway.generate(fixtureInput(), undefined),
    (error) => error === failure,
  );

  assert.equal(repository.createReviewDraft, originalCreateReviewDraft);
  assert.equal(repository.recordAiUsage, originalRecordAiUsage);
  assert.equal(outerCreateCalled, false);
  assert.equal(outerRecordCalled, false);
});

test("LegacyEditorialDraftGateway isolates concurrent calls so usage/drafts don't cross-capture", async () => {
  const readyBoth = deferred<void>();
  const gate1 = deferred<void>();
  const gate2 = deferred<void>();
  const entered: string[] = [];

  const captured = new Map<string, { usage: string[]; created: string[] }>();
  const article1: ArticleRow = {
    ...ARTICLE,
    id: "article-1",
  };
  const article2: ArticleRow = {
    ...ARTICLE,
    id: "article-2",
  };

  const repository = {
    async getNewsFeatureFlags() {
      return [] as { feature_key?: string; state?: string }[];
    },
    async listEnabledArticleTags() {
      return [];
    },
    createReviewDraft: async () => {
      throw new Error("outer createReviewDraft should never be called");
    },
    recordAiUsage: async () => {
      throw new Error("outer recordAiUsage should never be called");
    },
  };

  const gateway = new LegacyEditorialDraftGateway(
    {
      model: "provider-model",
      repository,
    },
    async (args) => {
      entered.push(args.article.id);
      if (entered.length === 2) {
        readyBoth.resolve();
      } else {
        await readyBoth.promise;
      }

      if (args.article.id === "article-1") {
        await gate1.promise;
      } else {
        await gate2.promise;
      }

      await args.repository.recordAiUsage?.({
        provider: "openai",
        model: "provider-model",
        operation: `${args.article.id}`,
      });
      const saved = await args.repository.createReviewDraft({
        article_id: args.article.id,
        body: `Generated body ${args.article.id}`,
        model: "provider-model",
        prompt_version: "telegram-grounded-v2",
        reviewer_notes: "{}",
      }) as { article_id: string; body: string };

      const entry = captured.get(args.article.id);
      assert.ok(entry !== undefined);
      captured.set(args.article.id, {
        usage: entry.usage,
        created: [...entry.created, saved.body],
      });

      return {
        draft: { telegramText: `Generated body ${args.article.id}` },
        baselineDraft: { tag: "baseline", marker: args.article.id },
        enrichedDraft: null,
        editorialEnrichment: { state: "off" },
        saved: {
          article_id: saved.article_id,
          body: saved.body,
          model: "provider-model",
          prompt_version: "telegram-grounded-v2",
          reviewer_notes: "{}",
          lease_name: "daily",
          lease_owner_id: "owner-1",
          topic_assignments: [],
          topic_assignment_source: null,
          topic_assigned_model: "provider-model",
        },
        provider: "openai",
        model: "provider-model",
      };
    },
  );

  captured.set("article-1", { usage: [], created: [] });
  captured.set("article-2", { usage: [], created: [] });

  const [leftResultPromise, rightResultPromise] = [
    gateway.generate(fixtureInput(article1, {}, []), new AbortController().signal),
    gateway.generate(fixtureInput(article2, {}, []), new AbortController().signal),
  ];

  // both calls started, release in order to produce overlap
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate2.resolve();
  gate1.resolve();

  const [leftResult, rightResult] = await Promise.all([
    leftResultPromise,
    rightResultPromise,
  ]);

  const leftUsage = leftResult.usageEvents.map((event) => event.operation);
  const rightUsage = rightResult.usageEvents.map((event) => event.operation);

  assert.deepEqual(leftUsage, ["article-1"]);
  assert.deepEqual(rightUsage, ["article-2"]);
  assert.deepEqual(captured.get("article-1")?.created, ["Generated body article-1"]);
  assert.deepEqual(captured.get("article-2")?.created, ["Generated body article-2"]);
});
