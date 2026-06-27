import assert from "node:assert/strict";
import test from "node:test";
import { getApprovalPolicy, runWorkflow } from "../src/workflow.js";

function fixture() {
  const calls = [];
  const repository = {
    calls,
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async startSearchRun() {
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [
        {
          id: "source-1",
          name: "Publisher",
          feed_url: "https://example.com/feed",
          source_type: "rss",
          reliability_score: 95,
          is_primary: true,
        },
      ];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { ...article, id: "article-1" };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
    async createReviewDraft(draft) {
      return { ...draft, id: "draft-1" };
    },
    async approveDraft(id) {
      calls.push(["approve", id]);
    },
    async findPublicationByDraft() {
      return null;
    },
    async claimDraftForPublication(id) {
      calls.push(["claim", id]);
      return { id, body: "Article\n\nhttps://example.com/news" };
    },
    async finalizeDraftPublication(publication) {
      calls.push(["finalize", publication.draftId]);
      return {
        id: "post-1",
        telegram_message_id: publication.messageId,
      };
    },
  };
  const options = {
    repository,
    aiClient: {
      models: {
        async generateContent() {
          return {
            text: JSON.stringify({
              headline: "Article",
              telegramText: "Article\n\nhttps://example.com/news",
              claims: [
                {
                  text: "A primary source published an update.",
                  sourceUrl: "https://example.com/news",
                },
              ],
              sourceUrls: ["https://example.com/news"],
              caveat: "Publisher evidence only.",
            }),
          };
        },
      },
    },
    model: "test",
    ownerId: "00000000-0000-4000-8000-000000000001",
    now: new Date("2026-06-27T12:00:00Z"),
    fetchFeedImpl: async () => [
      {
        title: "Article",
        canonicalUrl: "https://example.com/news",
        publishedAt: "2026-06-27T11:00:00Z",
        summary: "Summary",
        author: "Publisher",
        contentHash: "feed-hash",
      },
    ],
    fetchArticleImpl: async () => ({
      text: "Detailed primary source evidence.",
      contentHash: "article-hash",
      finalUrl: "https://example.com/news",
    }),
  };
  return { repository, options };
}

test("getApprovalPolicy defaults to manual and rejects unknown values", () => {
  assert.equal(getApprovalPolicy({}), "manual");
  assert.equal(getApprovalPolicy({ APPROVAL_POLICY: "AUTOMATIC" }), "automatic");
  assert.throws(
    () => getApprovalPolicy({ APPROVAL_POLICY: "sometimes" }),
    /manual or automatic/,
  );
});

test("manual workflow stops at the approval gate", async () => {
  const { repository, options } = fixture();
  const result = await runWorkflow({
    ...options,
    approvalPolicy: "manual",
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.publication, null);
  assert.equal(repository.calls.length, 0);
});

test("automatic workflow approves and publishes exactly once", async () => {
  const { repository, options } = fixture();
  const result = await runWorkflow({
    ...options,
    approvalPolicy: "automatic",
    telegram: { token: "token", channelId: "@channel" },
    sendMessage: async () => ({ message_id: 42 }),
  });
  assert.equal(result.status, "published");
  assert.equal(result.publication.telegram_message_id, 42);
  assert.deepEqual(repository.calls, [
    ["approve", "draft-1"],
    ["claim", "draft-1"],
    ["finalize", "draft-1"],
  ]);
});
