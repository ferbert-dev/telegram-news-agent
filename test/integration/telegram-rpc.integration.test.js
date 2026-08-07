import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

async function one(pool, text, values = []) {
  const result = await pool.query(text, values);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function scalar(pool, name, values) {
  return (await one(
    pool,
    `select public.${name}(${values.map((_, index) => `$${index + 1}`).join(", ")}) as value`,
    values,
  )).value;
}

async function createReviewFixture(pool, suffix) {
  const article = await one(
    pool,
    "insert into public.articles (canonical_url, title, status) values ($1, $2, 'drafted') returning *",
    [`https://integration.test/${suffix}`, `Integration ${suffix}`],
  );
  const draft = await one(
    pool,
    "insert into public.drafts (article_id, body, status) values ($1, 'Integration draft', 'review') returning *",
    [article.id],
  );
  const session = {
    id: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    draft_id: draft.id,
    control_chat_id: 101,
    preview_message_id: 202,
    requested_by: 303,
    expires_at: new Date(Date.now() + 60_000),
  };
  await pool.query(
    "insert into public.telegram_review_sessions (id, draft_id, control_chat_id, preview_message_id, requested_by, expires_at) values ($1, $2, $3, $4, $5, $6)",
    [
      session.id,
      session.draft_id,
      session.control_chat_id,
      session.preview_message_id,
      session.requested_by,
      session.expires_at,
    ],
  );
  return { article, draft, session };
}

test(
  "Telegram PostgreSQL function integration invariants",
  { skip: !enabled || !connectionString },
  async (t) => {
    const db = new Pool({ connectionString, max: 2 });
    const peer = new Pool({ connectionString, max: 2 });
    const cleanup = [];

    try {
      await t.test("session expiry and message binding fail closed", async () => {
        const expired = await createReviewFixture(db, randomUUID());
        cleanup.push(["review", expired.session.id, expired.article.id]);
        await db.query(
          "update public.telegram_review_sessions set created_at = $1, expires_at = $2 where id = $3",
          [
            new Date(Date.now() - 120_000),
            new Date(Date.now() - 60_000),
            expired.session.id,
          ],
        );
        await assert.rejects(
          db.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            [expired.session.id, "publish", 101, 202, 303],
          ),
          /expired/i,
        );

        const bound = await createReviewFixture(db, randomUUID());
        cleanup.push(["review", bound.session.id, bound.article.id]);
        await assert.rejects(
          db.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            [bound.session.id, "publish", 101, 999, 303],
          ),
          /binding mismatch/i,
        );
      });

      await t.test("stale claims recover and old claim tokens are fenced", async () => {
        const updateId = Date.now();
        const first = await one(
          db,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "news_callback", 30],
        );
        cleanup.push(["update", updateId]);
        assert.equal(first.claimed, true);

        const busy = await one(
          peer,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "news_callback", 30],
        );
        assert.equal(busy.claim_status, "busy");

        await db.query(
          "update public.telegram_updates set claimed_at = $1 where update_id = $2",
          [new Date(Date.now() - 31_000), updateId],
        );
        const second = await one(
          peer,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "news_callback", 30],
        );
        assert.equal(second.claimed, true);
        assert.notEqual(second.claim_token, first.claim_token);

        assert.equal(
          await scalar(db, "finish_telegram_update", [
            updateId,
            first.claim_token,
            "completed",
            null,
          ]),
          false,
        );
        assert.equal(
          await scalar(peer, "finish_telegram_update", [
            updateId,
            second.claim_token,
            "completed",
            null,
          ]),
          true,
        );
      });

      await t.test("failed update claims are immediately retryable", async () => {
        const updateId = Date.now() + 1;
        const first = await one(
          db,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "news_callback", 30],
        );
        cleanup.push(["update", updateId]);
        assert.equal(
          await scalar(db, "finish_telegram_update", [
            updateId,
            first.claim_token,
            "failed",
            "internal_error",
          ]),
          true,
        );
        const retry = await one(
          peer,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "news_callback", 30],
        );
        assert.equal(retry.claimed, true);
        assert.notEqual(retry.claim_token, first.claim_token);
      });

      await t.test("double Publish has one winner and a resumable decision", async () => {
        const fixture = await createReviewFixture(db, randomUUID());
        cleanup.push(["review", fixture.session.id, fixture.article.id]);
        const values = [fixture.session.id, "publish", 101, 202, 303];
        const results = await Promise.all([
          db.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            values,
          ),
          peer.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            values,
          ),
        ]);
        const decisions = results.flatMap((result) => result.rows);
        assert.deepEqual(
          decisions.map(({ decision_won }) => decision_won).sort(),
          [false, true],
        );
        assert.ok(decisions.every(({ decision }) => decision === "publish"));

        await db.query(
          "update public.telegram_review_sessions set created_at = $1, expires_at = $2 where id = $3",
          [
            new Date(Date.now() - 120_000),
            new Date(Date.now() - 60_000),
            fixture.session.id,
          ],
        );
        const replay = await one(
          db,
          "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
          values,
        );
        assert.equal(replay.decision, "publish");
        assert.equal(replay.decision_won, false);
      });

      await t.test("Publish/Reject race commits exactly one decision", async () => {
        const fixture = await createReviewFixture(db, randomUUID());
        cleanup.push(["review", fixture.session.id, fixture.article.id]);
        const base = [fixture.session.id, null, 101, 202, 303];
        const results = await Promise.all([
          db.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            [base[0], "publish", ...base.slice(2)],
          ),
          peer.query(
            "select * from public.decide_telegram_review_session($1, $2, $3, $4, $5)",
            [base[0], "reject", ...base.slice(2)],
          ),
        ]);
        const decisions = results.flatMap((result) => result.rows);
        assert.equal(decisions.filter(({ decision_won }) => decision_won).length, 1);
        assert.equal(new Set(decisions.map(({ decision }) => decision)).size, 1);
      });

      await t.test("expired poll lease is fenced and reclaimable", async () => {
        const name = `telegram-integration-${randomUUID()}`;
        const owner = randomUUID();
        const nextOwner = randomUUID();
        cleanup.push(["lease", name]);
        assert.equal(
          await scalar(db, "acquire_pipeline_lease", [name, owner, 30]),
          true,
        );
        await db.query(
          "update public.pipeline_leases set expires_at = $1 where name = $2",
          [new Date(Date.now() - 1_000), name],
        );
        assert.equal(
          await scalar(db, "renew_pipeline_lease", [name, owner, 30]),
          false,
        );
        assert.equal(
          await scalar(peer, "acquire_pipeline_lease", [name, nextOwner, 30]),
          true,
        );
      });
    } finally {
      for (const item of cleanup.reverse()) {
        if (item[0] === "update") {
          await db.query("delete from public.telegram_updates where update_id = $1", [item[1]]);
        } else if (item[0] === "lease") {
          await db.query("delete from public.pipeline_leases where name = $1", [item[1]]);
        } else if (item[0] === "review") {
          await db.query("delete from public.telegram_review_sessions where id = $1", [item[1]]);
          await db.query("delete from public.articles where id = $1", [item[2]]);
        }
      }
      await Promise.all([db.end(), peer.end()]);
    }
  },
);
