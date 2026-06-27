import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SECRET_KEY;

function client() {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function requireData(result) {
  assert.ifError(result.error);
  return result.data;
}

async function createReviewFixture(db, suffix) {
  const article = requireData(
    await db
      .from("articles")
      .insert({
        canonical_url: `https://integration.test/${suffix}`,
        title: `Integration ${suffix}`,
        status: "drafted",
      })
      .select()
      .single(),
  );
  const draft = requireData(
    await db
      .from("drafts")
      .insert({
        article_id: article.id,
        body: "Integration draft",
        status: "review",
      })
      .select()
      .single(),
  );
  const session = {
    id: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    draft_id: draft.id,
    control_chat_id: 101,
    preview_message_id: 202,
    requested_by: 303,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  requireData(await db.from("telegram_review_sessions").insert(session));
  return { article, draft, session };
}

test(
  "Telegram RPC integration invariants",
  { skip: !enabled || !url || !key },
  async (t) => {
    const db = client();
    const peer = client();
    const cleanup = [];

    await t.test("session expiry and message binding fail closed", async () => {
      const expired = await createReviewFixture(db, randomUUID());
      cleanup.push(["review", expired.session.id, expired.article.id]);
      requireData(
        await db
          .from("telegram_review_sessions")
          .update({
            created_at: new Date(Date.now() - 120_000).toISOString(),
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq("id", expired.session.id),
      );
      const expiredDecision = await db.rpc("decide_telegram_review_session", {
        p_session_id: expired.session.id,
        p_action: "publish",
        p_chat_id: 101,
        p_message_id: 202,
        p_actor_id: 303,
      });
      assert.match(expiredDecision.error?.message ?? "", /expired/i);

      const bound = await createReviewFixture(db, randomUUID());
      cleanup.push(["review", bound.session.id, bound.article.id]);
      const wrongMessage = await db.rpc("decide_telegram_review_session", {
        p_session_id: bound.session.id,
        p_action: "publish",
        p_chat_id: 101,
        p_message_id: 999,
        p_actor_id: 303,
      });
      assert.match(wrongMessage.error?.message ?? "", /binding mismatch/i);
    });

    await t.test("stale claims recover and old claim tokens are fenced", async () => {
      const updateId = Date.now();
      const first = requireData(
        await db.rpc("claim_telegram_update", {
          p_update_id: updateId,
          p_update_kind: "news_callback",
          p_stale_after_seconds: 30,
        }),
      )[0];
      cleanup.push(["update", updateId]);
      assert.equal(first.claimed, true);

      const busy = requireData(
        await peer.rpc("claim_telegram_update", {
          p_update_id: updateId,
          p_update_kind: "news_callback",
          p_stale_after_seconds: 30,
        }),
      )[0];
      assert.equal(busy.claim_status, "busy");

      requireData(
        await db
          .from("telegram_updates")
          .update({ claimed_at: new Date(Date.now() - 31_000).toISOString() })
          .eq("update_id", updateId),
      );
      const second = requireData(
        await peer.rpc("claim_telegram_update", {
          p_update_id: updateId,
          p_update_kind: "news_callback",
          p_stale_after_seconds: 30,
        }),
      )[0];
      assert.equal(second.claimed, true);
      assert.notEqual(second.claim_token, first.claim_token);

      assert.equal(
        requireData(
          await db.rpc("finish_telegram_update", {
            p_update_id: updateId,
            p_claim_token: first.claim_token,
            p_status: "completed",
          }),
        ),
        false,
      );
      assert.equal(
        requireData(
          await peer.rpc("finish_telegram_update", {
            p_update_id: updateId,
            p_claim_token: second.claim_token,
            p_status: "completed",
          }),
        ),
        true,
      );
    });

    await t.test("failed update claims are immediately retryable", async () => {
      const updateId = Date.now() + 1;
      const first = requireData(
        await db.rpc("claim_telegram_update", {
          p_update_id: updateId,
          p_update_kind: "news_callback",
          p_stale_after_seconds: 30,
        }),
      )[0];
      cleanup.push(["update", updateId]);
      assert.equal(
        requireData(
          await db.rpc("finish_telegram_update", {
            p_update_id: updateId,
            p_claim_token: first.claim_token,
            p_status: "failed",
            p_error_code: "internal_error",
          }),
        ),
        true,
      );

      const retry = requireData(
        await peer.rpc("claim_telegram_update", {
          p_update_id: updateId,
          p_update_kind: "news_callback",
          p_stale_after_seconds: 30,
        }),
      )[0];
      assert.equal(retry.claimed, true);
      assert.notEqual(retry.claim_token, first.claim_token);
    });

    await t.test("double Publish has one winner and a resumable decision", async () => {
      const fixture = await createReviewFixture(db, randomUUID());
      cleanup.push(["review", fixture.session.id, fixture.article.id]);
      const input = {
        p_session_id: fixture.session.id,
        p_action: "publish",
        p_chat_id: 101,
        p_message_id: 202,
        p_actor_id: 303,
      };
      const results = await Promise.all([
        db.rpc("decide_telegram_review_session", input),
        peer.rpc("decide_telegram_review_session", input),
      ]);
      const decisions = results.flatMap((result) => requireData(result));
      assert.deepEqual(
        decisions.map(({ decision_won }) => decision_won).sort(),
        [false, true],
      );
      assert.ok(decisions.every(({ decision }) => decision === "publish"));

      requireData(
        await db
          .from("telegram_review_sessions")
          .update({
            created_at: new Date(Date.now() - 120_000).toISOString(),
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq("id", fixture.session.id),
      );
      const replay = requireData(
        await db.rpc("decide_telegram_review_session", input),
      )[0];
      assert.equal(replay.decision, "publish");
      assert.equal(replay.decision_won, false);
    });

    await t.test("Publish/Reject race commits exactly one decision", async () => {
      const fixture = await createReviewFixture(db, randomUUID());
      cleanup.push(["review", fixture.session.id, fixture.article.id]);
      const base = {
        p_session_id: fixture.session.id,
        p_chat_id: 101,
        p_message_id: 202,
        p_actor_id: 303,
      };
      const results = await Promise.all([
        db.rpc("decide_telegram_review_session", {
          ...base,
          p_action: "publish",
        }),
        peer.rpc("decide_telegram_review_session", {
          ...base,
          p_action: "reject",
        }),
      ]);
      const decisions = results.flatMap((result) => requireData(result));
      assert.equal(decisions.filter(({ decision_won }) => decision_won).length, 1);
      assert.equal(new Set(decisions.map(({ decision }) => decision)).size, 1);
    });

    await t.test("expired poll lease is fenced from renewal and reclaimable", async () => {
      const name = `telegram-integration-${randomUUID()}`;
      const owner = randomUUID();
      const nextOwner = randomUUID();
      cleanup.push(["lease", name]);
      assert.equal(
        requireData(
          await db.rpc("acquire_pipeline_lease", {
            p_name: name,
            p_owner_id: owner,
            p_ttl_seconds: 30,
          }),
        ),
        true,
      );
      requireData(
        await db
          .from("pipeline_leases")
          .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
          .eq("name", name),
      );
      assert.equal(
        requireData(
          await db.rpc("renew_pipeline_lease", {
            p_name: name,
            p_owner_id: owner,
            p_ttl_seconds: 30,
          }),
        ),
        false,
      );
      assert.equal(
        requireData(
          await peer.rpc("acquire_pipeline_lease", {
            p_name: name,
            p_owner_id: nextOwner,
            p_ttl_seconds: 30,
          }),
        ),
        true,
      );
    });

    for (const item of cleanup.reverse()) {
      if (Array.isArray(item) && item[0] === "update") {
        await db.from("telegram_updates").delete().eq("update_id", item[1]);
      } else if (Array.isArray(item) && item[0] === "lease") {
        await db.from("pipeline_leases").delete().eq("name", item[1]);
      } else if (Array.isArray(item) && item[0] === "review") {
        await db.from("telegram_review_sessions").delete().eq("id", item[1]);
        await db.from("articles").delete().eq("id", item[2]);
      } else {
        await db.from("articles").delete().eq("id", item);
      }
    }
  },
);
