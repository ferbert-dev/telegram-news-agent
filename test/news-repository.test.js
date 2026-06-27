import assert from "node:assert/strict";
import test from "node:test";
import { NewsRepository } from "../src/news-repository.js";

test("createReviewDraft delegates all state changes to one transactional RPC", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async rpc(name, parameters) {
      calls.push([name, parameters]);
      return {
        data: [{ id: "draft-1", article_id: parameters.p_article_id }],
        error: null,
      };
    },
  });

  const draft = await repository.createReviewDraft({
    article_id: "article-1",
    body: "Grounded draft",
    model: "model",
    prompt_version: "v1",
    reviewer_notes: "{}",
  });

  assert.equal(draft.id, "draft-1");
  assert.deepEqual(calls, [
    [
      "create_review_draft",
      {
        p_article_id: "article-1",
        p_body: "Grounded draft",
        p_model: "model",
        p_prompt_version: "v1",
        p_reviewer_notes: "{}",
        p_lease_name: null,
        p_lease_owner_id: null,
      },
    ],
  ]);
});

test("createReviewDraft surfaces RPC rollback failures without fallback writes", async () => {
  let calls = 0;
  const repository = new NewsRepository({
    async rpc() {
      calls += 1;
      return {
        data: null,
        error: new Error("injected failure after draft insert"),
      };
    },
  });

  await assert.rejects(
    repository.createReviewDraft({
      article_id: "article-1",
      body: "Grounded draft",
    }),
    /injected failure after draft insert/,
  );
  assert.equal(calls, 1);
});

test("audit backfill lifecycle uses service-role RPCs", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async rpc(name, parameters) {
      calls.push([name, parameters]);
      return {
        data: name.startsWith("claim_") ? [{ id: "outbox-1" }] : true,
        error: null,
      };
    },
  });

  assert.equal((await repository.claimNotionAuditBackfill(10))[0].id, "outbox-1");
  assert.equal(await repository.completeNotionAuditBackfill("outbox-1"), true);
  assert.equal(
    await repository.retryNotionAuditBackfill("outbox-2", new Error("offline")),
    true,
  );
  assert.deepEqual(calls, [
    ["claim_notion_audit_backfill", { p_limit: 10 }],
    ["complete_notion_audit_backfill", { p_id: "outbox-1" }],
    ["retry_notion_audit_backfill", { p_id: "outbox-2", p_error: "offline" }],
  ]);
});
