import assert from "node:assert/strict";
import test from "node:test";
import { NewsRepository } from "../src/news-repository.js";

test("createReviewDraft delegates all state changes to one transactional function", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      return {
        rows: [{ id: "draft-1", article_id: parameters[0] }],
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
  assert.equal(
    calls[0][0],
    "select * from public.create_review_draft($1, $2, $3, $4, $5, $6, $7)",
  );
  assert.deepEqual(calls[0][1], [
    "article-1",
    "Grounded draft",
    "model",
    "v1",
    "{}",
    null,
    null,
  ]);
});

test("createReviewDraft surfaces transaction failures without fallback writes", async () => {
  let calls = 0;
  const repository = new NewsRepository({
    async query() {
      calls += 1;
      throw new Error("injected failure after draft insert");
    },
  });

  await assert.rejects(
    repository.createReviewDraft({
      article_id: "article-1",
      body: "Grounded draft",
    }),
    /Create review draft failed: injected failure after draft insert/,
  );
  assert.equal(calls, 1);
});

test("audit backfill lifecycle uses PostgreSQL functions", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      return {
        rows: text.includes("claim_notion_audit_backfill")
          ? [{ id: "outbox-1" }]
          : [{ value: true }],
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
    ["select * from public.claim_notion_audit_backfill($1)", [10]],
    ["select public.complete_notion_audit_backfill($1) as value", ["outbox-1"]],
    [
      "select public.retry_notion_audit_backfill($1, $2) as value",
      ["outbox-2", "offline"],
    ],
  ]);
});

test("repository rejects PostgreSQL writes that unexpectedly match no rows", async () => {
  const repository = new NewsRepository({
    async query() {
      return { rows: [] };
    },
  });

  await assert.rejects(
    repository.setSourceEnabled("missing", true),
    /Enable source failed: expected one row, received 0/,
  );
});
