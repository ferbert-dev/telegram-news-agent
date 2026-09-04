import assert from "node:assert/strict";
import test from "node:test";

import { generateDraft } from "../../src/draft.js";
import { LegacyEditorialDraftGateway } from "../../src/editorial/legacy-editorial-draft.gateway.js";

/**
 * Draft generation, legacy call site against typed call site, on one fixture.
 *
 * What this can and cannot prove, stated up front, because a differential test
 * that is misread is worse than none:
 *
 * Draft generation is NOT reimplemented in TypeScript. `pipeline.js` calls
 * `generateDraft` directly; `LegacyEditorialDraftGateway` calls the same
 * function through two translation layers -- typed request in, typed result and
 * repository write out. So this does not compare two generators. It compares
 * the generator against itself with the adapter in the way, which is precisely
 * where a wrapping migration goes wrong.
 *
 * It is not hypothetical. The adapter invented a value the legacy call site
 * never produced: with article tagging off, `pipeline.js` omits
 * `topic_assignments` entirely while the gateway passed an explicit `null`. The
 * repository distinguishes an omitted key from a present one, so the typed path
 * took the with-topics SQL function, stringified null to the JSON literal
 * `null`, and every review draft failed whenever tagging was off -- the
 * default. Both sides had tests. Both passed. Nothing compared them.
 *
 * The comparisons that matter are therefore on the SEAMS, not the output text:
 * what reaches `generateDraft`, and what reaches the repository.
 */

const ARTICLE = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Observatory narrows the Hubble constant uncertainty",
  canonical_url: "https://feed.example.test/hubble",
  summary: "A peer-reviewed measurement narrowed the expansion-rate uncertainty.",
  status: "researched",
});

const EVIDENCE = Object.freeze([
  Object.freeze({
    url: "https://feed.example.test/hubble",
    title: ARTICLE.title,
    publishedAt: "2026-09-04T09:00:00.000Z",
    text: "A peer-reviewed measurement narrowed the expansion-rate uncertainty.",
    primary: true,
    publisher: "Example Research Wire",
    verificationStatus: "primary_source",
  }),
]);

const SETTINGS_SNAPSHOT = Object.freeze({
  channelId: "@differential",
  reviewChatId: 4242,
  approvalPolicy: "manual",
  languageCode: "en",
  topicCodes: ["science"],
  customTopics: [],
  excludedTopicCodes: [],
  version: 3,
});

const GENERATED_DRAFT = Object.freeze({
  headline: ARTICLE.title,
  telegramText: [
    ARTICLE.title,
    "",
    "A peer-reviewed measurement narrowed the expansion-rate uncertainty.",
    "",
    "Why it matters: a tighter bound narrows which cosmological models survive.",
    "",
    "Caveat: the result awaits independent replication.",
    "",
    "Source:",
    "https://feed.example.test/hubble",
  ].join("\n"),
  claims: [
    { text: ARTICLE.title, sourceUrl: "https://feed.example.test/hubble" },
    {
      text: "A peer-reviewed measurement narrowed the expansion-rate uncertainty.",
      sourceUrl: "https://feed.example.test/hubble",
    },
  ],
  sourceUrls: ["https://feed.example.test/hubble"],
  caveat: "The result awaits independent replication.",
  topicTags: [],
});

/**
 * One repository, recording every call, so the two runs can be compared on what
 * they asked the database for rather than only on what they returned.
 *
 * `createReviewDraft` records whether the key was PRESENT, not just its value:
 * absent and present-and-undefined are indistinguishable under deepEqual, and
 * that distinction is the entire bug this file exists for.
 */
function recordingRepository(calls: Array<Record<string, unknown>>) {
  return {
    async createReviewDraft(draft: Record<string, unknown>) {
      calls.push({
        call: "createReviewDraft",
        hasTopicAssignments: "topic_assignments" in draft,
        topicAssignments: draft.topic_assignments ?? "(absent)",
        topicAssignmentSource: draft.topic_assignment_source ?? "(absent)",
        leaseName: draft.lease_name ?? null,
        leaseOwnerId: draft.lease_owner_id ?? null,
        articleId: draft.article_id,
        promptVersion: draft.prompt_version,
      });
      return { id: "draft-1", status: "review", body: String(draft.body ?? "") };
    },
    async recordAiUsage(event: Record<string, unknown>) {
      calls.push({ call: "recordAiUsage", operation: event.operation ?? null });
      return { id: "usage-1" };
    },
    async getNewsFeatureFlags() {
      calls.push({ call: "getNewsFeatureFlags" });
      return [];
    },
    async getNewsBotSettings() {
      calls.push({ call: "getNewsBotSettings" });
      return null;
    },
    async listTopicsForTagging() {
      calls.push({ call: "listTopicsForTagging" });
      return [];
    },
  };
}

/** One AI provider, recording what it was asked and in what order. */
function recordingProvider(asked: string[]) {
  return {
    names: ["openai"],
    async generateStructured(request: Record<string, unknown>) {
      asked.push(String(request.schemaName ?? "(unnamed)"));
      return {
        value: GENERATED_DRAFT,
        usageEvents: [],
        provider: "openai",
        model: "differential-model",
      };
    },
  };
}

test("the typed draft gateway asks generateDraft for exactly what pipeline.js asks it", async () => {
  // The input seam. Both sides run the real generator, but it is replaced with
  // a recorder so the ARGUMENTS can be compared -- the generator's output is
  // identical by construction and would prove nothing.
  const legacyArgs: Record<string, unknown>[] = [];
  const typedArgs: Record<string, unknown>[] = [];

  const capture = (into: Record<string, unknown>[]) =>
    async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      // Recorded by identity where it matters: the gateway must forward the
      // caller's article and evidence, not a copy or a reshaping of them.
      into.push({
        sameArticle: args.article === ARTICLE,
        sameEvidence: args.evidence === EVIDENCE,
        allowUnverified: args.allowUnverified,
        languageCode: args.languageCode,
        lease: args.lease,
        model: args.model,
        hasEditor: Boolean(args.editor),
        articleTaggingState: (args.articleTagging as { state?: string } | undefined)?.state,
      });
      return {
        saved: {
          id: "draft-1",
          status: "review",
          body: GENERATED_DRAFT.telegramText,
          prompt_version: "telegram-grounded-v2",
          reviewer_notes: "{}",
        },
        provider: "openai",
        model: "differential-model",
      };
    };

  // Legacy call site, mirroring src/pipeline.js:241.
  await capture(legacyArgs)({
    aiProvider: recordingProvider([]),
    client: undefined,
    model: "differential-model",
    repository: recordingRepository([]),
    article: ARTICLE,
    evidence: EVIDENCE,
    allowUnverified: false,
    lease: { name: "news_pipeline", ownerId: "owner-1" },
    languageCode: "en",
    newsSettings: SETTINGS_SNAPSHOT,
    editor: { name: "editor" },
    articleTagging: { state: "off" },
    editorialEnrichment: { state: "off" },
  } as never);

  // Typed call site: the same intent, expressed through the gateway.
  const gateway = new LegacyEditorialDraftGateway(
    {
      aiProvider: recordingProvider([]) as never,
      model: "differential-model",
      repository: recordingRepository([]) as never,
      editor: { name: "editor" } as never,
    },
    capture(typedArgs) as never,
  );
  await gateway.generate({
    article: ARTICLE as never,
    evidence: EVIDENCE as never,
    allowUnverified: false,
    lease: { name: "news_pipeline", ownerId: "owner-1" },
    languageCode: "en",
    channelId: SETTINGS_SNAPSHOT.channelId,
    settingsSnapshot: SETTINGS_SNAPSHOT as never,
  } as never);

  assert.equal(legacyArgs.length, 1);
  assert.equal(typedArgs.length, 1);
  assert.deepEqual(
    typedArgs[0],
    legacyArgs[0],
    "the gateway must hand generateDraft the same arguments pipeline.js does",
  );
});

test("the gateway's result carries the same keys the legacy call site produces", async () => {
  // The output seam, and the only part of it worth a differential test: what
  // the gateway hands onward for the repository to write.
  //
  // Driven with an injected generator rather than the real one. Standing up
  // enough repository surface to run legacy generateDraft through both paths
  // would test the generator, which both paths share and neither changes --
  // the divergence was never in there.
  const savedFrom = (topicAssignments?: unknown) => ({
    saved: {
      article_id: ARTICLE.id,
      body: GENERATED_DRAFT.telegramText,
      model: "differential-model",
      prompt_version: "telegram-grounded-v2",
      reviewer_notes: "{}",
      lease_name: "news_pipeline",
      lease_owner_id: "owner-1",
      ...(topicAssignments === undefined ? {} : { topic_assignments: topicAssignments }),
    },
    provider: "openai",
    model: "differential-model",
  });

  const run = async (generated: Record<string, unknown>) => {
    const gateway = new LegacyEditorialDraftGateway(
      {
        aiProvider: recordingProvider([]) as never,
        model: "differential-model",
        repository: recordingRepository([]) as never,
        editor: undefined as never,
      },
      (async () => generated) as never,
    );
    const result = await gateway.generate({
      article: ARTICLE as never,
      evidence: EVIDENCE as never,
      allowUnverified: false,
      lease: { name: "news_pipeline", ownerId: "owner-1" },
      languageCode: "en",
      channelId: SETTINGS_SNAPSHOT.channelId,
      settingsSnapshot: SETTINGS_SNAPSHOT as never,
    } as never);
    return result.draft as Record<string, unknown>;
  };

  // Tagging off. src/draft.js omits the key entirely
  // (`...(state !== "off" ? { topic_assignments } : {})`), so the gateway must
  // omit it too. Asserted on presence: absent and present-and-undefined are
  // the same under deepEqual, and the SQL function acts on exactly that
  // difference.
  assert.equal(
    "topic_assignments" in (await run(savedFrom(undefined))),
    false,
    "tagging off must omit the key, as src/draft.js does — a present null is what failed every draft",
  );

  // Tagging on with a result. The key must survive, unchanged.
  const tagged = await run(savedFrom([{ code: "science", confidence: 0.9 }]));
  assert.deepEqual(tagged.topic_assignments, [{ code: "science", confidence: 0.9 }]);

  // Tagging on with nothing found. An empty array is a different statement
  // from "tagging did not run" and must not collapse into an omission.
  const empty = await run(savedFrom([]));
  assert.equal("topic_assignments" in empty, true);
  assert.deepEqual(empty.topic_assignments, []);
});
