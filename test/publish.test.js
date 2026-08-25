import test from "node:test";
import assert from "node:assert/strict";
import { publishApprovedDraft } from "../src/publish.js";
import { TelegramError } from "../src/telegram.js";

const POLICY_DRAFT = {
  id: "draft-policy",
  article_id: "article-policy",
  body: "Exact approved outbound article",
  status: "approved",
  model: "configured-editor-model",
  prompt_version: "telegram-grounded-v2",
  reviewer_notes: null,
  articles: {
    id: "article-policy",
    title: "Missile attack kills people in conflict zone",
    search_run_id: "run-policy",
  },
};

function withPolicyBypass(repository) {
  return {
    async findPublicationPolicyBlockByDraft() { return null; },
    async getDraft(id) {
      return repository.policyDraft ?? {
        id,
        article_id: "article-legacy",
        body: "Approved article",
        status: "approved",
        reviewer_notes: null,
        articles: { id: "article-legacy", title: "Legacy article" },
      };
    },
    async getNewsSettings() {
      return { version: 1, excluded_topic_codes: [] };
    },
    async claimDraftForPublicationWithPolicy({ draftId, channelId }) {
      const draft = await repository.claimDraftForPublication(
        draftId,
        channelId,
      );
      return {
        outcome: draft ? "claimed" : "not_publishable",
        draft: draft ?? null,
      };
    },
    ...repository,
  };
}

test("publishApprovedDraft classifies and meters exact outbound content before the settings-CAS claim", async () => {
  const calls = [];
  const repository = withPolicyBypass({
    async findPublicationByDraft() {
      calls.push("publication");
      return null;
    },
    async findPublicationPolicyBlockByDraft() {
      calls.push("block");
      return null;
    },
    async getDraft() {
      calls.push("draft");
      return POLICY_DRAFT;
    },
    async getNewsSettings() {
      calls.push("settings");
      return { version: 7, excluded_topic_codes: ["war_conflict"] };
    },
    async recordAiUsage(event) {
      calls.push("usage");
      assert.equal(event.articleId, POLICY_DRAFT.article_id);
      assert.equal(event.telegramChannelId, "@channel");
      return event;
    },
    async claimDraftForPublicationWithPolicy(input) {
      calls.push("claim");
      assert.equal(input.settingsVersion, 7);
      assert.match(input.outboundTextSha256, /^[a-f0-9]{64}$/);
      return { outcome: "claimed", draft: POLICY_DRAFT };
    },
    async finalizeDraftPublication() {
      calls.push("finalize");
      return { telegram_message_id: 42 };
    },
  });
  const aiProvider = {
    async generateStructured(request) {
      calls.push("policy");
      assert.equal(request.input.article.text, POLICY_DRAFT.body);
      assert.equal(Object.hasOwn(request.input.article, "title"), false);
      return {
        value: {
          assessments: [
            { topicCode: "war_conflict", relation: "unrelated" },
          ],
        },
        provider: "configured-provider",
        model: "configured-policy-model",
        usageEvents: [
          {
            provider: "configured-provider",
            providerResponseId: "policy-response-1",
            model: "configured-policy-model",
            operation: "excluded_topic_classification",
          },
        ],
      };
    },
  };

  const result = await publishApprovedDraft({
    repository,
    aiProvider,
    token: "token",
    channelId: "@channel",
    draftId: POLICY_DRAFT.id,
    publicationPath: "manual_review",
    sendMessage: async ({ text, entities }) => {
      calls.push("send");
      assert.equal(text, POLICY_DRAFT.body);
      assert.deepEqual(entities, [
        {
          type: "bold",
          offset: 0,
          length: POLICY_DRAFT.body.split("\n", 1)[0].length,
        },
      ]);
      return { message_id: 42, date: 123 };
    },
  });

  assert.equal(result.status, "published");
  assert.deepEqual(calls, [
    "publication",
    "block",
    "draft",
    "settings",
    "policy",
    "usage",
    "claim",
    "send",
    "finalize",
  ]);
});

test("publishApprovedDraft durably blocks an uncertain final policy result without claiming or sending", async () => {
  let claimed = false;
  let sent = false;
  let blockInput;
  const result = await publishApprovedDraft({
    repository: {
      async findPublicationByDraft() { return null; },
      async findPublicationPolicyBlockByDraft() { return null; },
      async getDraft() { return POLICY_DRAFT; },
      async getNewsSettings() {
        return { version: 3, excluded_topic_codes: ["war_conflict"] };
      },
      async recordAiUsage(event) { return event; },
      async claimDraftForPublicationWithPolicy() {
        claimed = true;
      },
      async blockDraftPublication(input) {
        blockInput = input;
        return {
          outcome: "blocked",
          block: { id: "block-1", reason_code: input.reasonCode },
          draft: { ...POLICY_DRAFT, status: "rejected" },
        };
      },
    },
    aiProvider: {
      async generateStructured() {
        return {
          value: {
            assessments: [
              { topicCode: "war_conflict", relation: "uncertain" },
            ],
          },
          provider: "configured-provider",
          model: "configured-policy-model",
          usageEvents: [],
        };
      },
    },
    token: "token",
    channelId: "@channel",
    draftId: POLICY_DRAFT.id,
    publicationPath: "scheduler",
    sendMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "excluded_topic_uncertain");
  assert.equal(blockInput.classification, "uncertain");
  assert.equal(blockInput.topicCode, "war_conflict");
  assert.match(blockInput.outboundTextSha256, /^[a-f0-9]{64}$/);
  assert.equal(claimed, false);
  assert.equal(sent, false);
});

test("publishApprovedDraft preserves exact empty-exclusions bypass and does not call the classifier", async () => {
  let classified = false;
  let audited = false;
  let sent = false;
  let providerCreated = false;
  const result = await publishApprovedDraft({
    repository: {
      async findPublicationByDraft() { return null; },
      async findPublicationPolicyBlockByDraft() { return null; },
      async getDraft() { return POLICY_DRAFT; },
      async getNewsSettings() {
        return { version: 11, excluded_topic_codes: [] };
      },
      async recordAiUsage() { audited = true; },
      async blockDraftPublication() { audited = true; },
      async claimDraftForPublicationWithPolicy(input) {
        assert.equal(input.settingsVersion, 11);
        return { outcome: "claimed", draft: POLICY_DRAFT };
      },
      async finalizeDraftPublication() {
        return { telegram_message_id: 43 };
      },
    },
    createAiProvider() {
      providerCreated = true;
      return {
        async generateStructured() {
          classified = true;
        },
      };
    },
    token: "token",
    channelId: "@channel",
    draftId: POLICY_DRAFT.id,
    sendMessage: async () => {
      sent = true;
      return { message_id: 43 };
    },
  });

  assert.equal(result.status, "published");
  assert.equal(classified, false);
  assert.equal(providerCreated, false);
  assert.equal(audited, false);
  assert.equal(sent, true);
});

test("publishApprovedDraft lazily creates one configured provider for nonempty exclusions and reuses it across a stale retry", async () => {
  let providerCreated = 0;
  let classified = 0;
  let settingsRead = 0;
  let claimed = 0;
  let sent = 0;
  const result = await publishApprovedDraft({
    repository: {
      async findPublicationByDraft() { return null; },
      async findPublicationPolicyBlockByDraft() { return null; },
      async getDraft() { return POLICY_DRAFT; },
      async getNewsSettings() {
        settingsRead += 1;
        return {
          version: settingsRead,
          excluded_topic_codes: ["war_conflict"],
        };
      },
      async recordAiUsage(event) { return event; },
      async claimDraftForPublicationWithPolicy() {
        claimed += 1;
        return claimed === 1
          ? { outcome: "stale_settings", draft: POLICY_DRAFT }
          : { outcome: "claimed", draft: POLICY_DRAFT };
      },
      async finalizeDraftPublication() {
        return { telegram_message_id: 81 };
      },
    },
    createAiProvider() {
      providerCreated += 1;
      return {
        async generateStructured() {
          classified += 1;
          return {
            value: {
              assessments: [
                { topicCode: "war_conflict", relation: "unrelated" },
              ],
            },
            provider: "configured-provider",
            model: "configured-policy-model",
            usageEvents: [],
          };
        },
      };
    },
    token: "token",
    channelId: "@channel",
    draftId: POLICY_DRAFT.id,
    sendMessage: async () => {
      sent += 1;
      return { message_id: 81 };
    },
  });

  assert.equal(result.status, "published");
  assert.equal(providerCreated, 1);
  assert.equal(classified, 2);
  assert.equal(sent, 1);
});

test("publishApprovedDraft records a claimed draft after Telegram accepts it", async () => {
  const calls = [];
  const repository = withPolicyBypass({
    async findPublicationByDraft() {
      return null;
    },
    async claimDraftForPublication(id, channelId) {
      calls.push(["claim", id, channelId]);
      return {
        id,
        body: "Approved article",
        reviewer_notes: JSON.stringify({
          editor: { key: "mikhail-onest", name: "Михаил Онест" },
        }),
      };
    },
    async finalizeDraftPublication(details) {
      calls.push(["finalize", details.messageId, details.metadata.editor]);
      return { telegram_message_id: details.messageId };
    },
  });
  const result = await publishApprovedDraft({
    repository,
    token: "token",
    channelId: "@channel",
    draftId: "draft-1",
    sendMessage: async () => ({ message_id: 42, date: 123 }),
  });

  assert.equal(result.publication.telegram_message_id, 42);
  assert.deepEqual(calls, [
    ["claim", "draft-1", "@channel"],
    [
      "finalize",
      42,
      { key: "mikhail-onest", name: "Михаил Онест" },
    ],
  ]);
});

test("publishApprovedDraft returns an existing publication without sending", async () => {
  let sent = false;
  const publication = { telegram_message_id: 7 };
  const result = await publishApprovedDraft({
    repository: {
      async findPublicationByDraft() {
        return publication;
      },
    },
    token: "token",
    channelId: "@channel",
    draftId: "draft-1",
    sendMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result.alreadyPublished, true);
  assert.equal(sent, false);
});

test("publishApprovedDraft leaves an ambiguous failure unresolved", async () => {
  let finalized = false;
  await assert.rejects(
    publishApprovedDraft({
      repository: withPolicyBypass({
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication(id) {
          return { id, body: "Approved article" };
        },
        async finalizeDraftPublication() {
          finalized = true;
        },
      }),
      token: "token",
      channelId: "@channel",
      draftId: "draft-1",
      sendMessage: async () => {
        throw new Error("connection reset");
      },
    }),
    /remains in publishing state/,
  );
  assert.equal(finalized, false);
});

test("a database failure after Telegram accepts the message stays unresolved", async () => {
  await assert.rejects(
    publishApprovedDraft({
      repository: withPolicyBypass({
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication(id) {
          return { id, body: "Approved article" };
        },
        async finalizeDraftPublication() {
          throw new Error("database unavailable");
        },
      }),
      token: "token",
      channelId: "@channel",
      draftId: "draft-1",
      sendMessage: async () => ({ message_id: 42, date: 123 }),
    }),
    /unresolved after the message was accepted/,
  );
});

test("publishApprovedDraft releases a definitive Telegram rejection for retry", async () => {
  let released = false;
  await assert.rejects(
    publishApprovedDraft({
      repository: withPolicyBypass({
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication(id) {
          return { id, body: "Approved article" };
        },
        async releaseRejectedDraftPublication(id) {
          assert.equal(id, "draft-1");
          released = true;
        },
      }),
      token: "token",
      channelId: "@channel",
      draftId: "draft-1",
      sendMessage: async () => {
        throw new TelegramError("sendMessage", 400, 400, "message rejected");
      },
    }),
    /released for retry/,
  );
  assert.equal(released, true);
});

test("publishApprovedDraft never resends a draft already in publishing", async () => {
  let sent = false;
  await assert.rejects(
    publishApprovedDraft({
      repository: withPolicyBypass({
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication() {
          throw new Error("Draft is not approved or is already being published");
        },
      }),
      token: "token",
      channelId: "@channel",
      draftId: "draft-1",
      sendMessage: async () => {
        sent = true;
      },
    }),
    /already being published/,
  );
  assert.equal(sent, false);
});

test("publishApprovedDraft does not call Telegram when the final story veto returns no draft", async () => {
  let sent = false;
  await assert.rejects(
    publishApprovedDraft({
      repository: withPolicyBypass({
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication(id, channelId) {
          assert.equal(id, "draft-duplicate");
          assert.equal(channelId, "@channel");
          return undefined;
        },
      }),
      token: "token",
      channelId: "@channel",
      draftId: "draft-duplicate",
      sendMessage: async () => {
        sent = true;
      },
    }),
    /not publishable/,
  );
  assert.equal(sent, false);
});
