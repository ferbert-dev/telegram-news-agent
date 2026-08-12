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
      await t.test("night-pause helpers honor Madrid time and DST", async () => {
        const boundaries = await one(
          db,
          `select
             public.is_news_quiet_hours('2026-08-07T19:59:59Z') as summer_before,
             public.is_news_quiet_hours('2026-08-07T20:00:00Z') as summer_start,
             public.is_news_quiet_hours('2026-08-08T05:59:59Z') as summer_before_end,
             public.is_news_quiet_hours('2026-08-08T06:00:00Z') as summer_end,
             public.is_news_quiet_hours('2026-01-15T21:00:00Z') as winter_start,
             public.next_allowed_news_schedule_at('2026-08-07T22:30:00Z', true) as summer_next,
             public.next_allowed_news_schedule_at('2026-01-15T22:30:00Z', true) as winter_next,
             public.next_allowed_news_schedule_at('2026-08-07T22:30:00Z', false) as disabled_next`,
        );
        assert.equal(boundaries.summer_before, false);
        assert.equal(boundaries.summer_start, true);
        assert.equal(boundaries.summer_before_end, true);
        assert.equal(boundaries.summer_end, false);
        assert.equal(boundaries.winter_start, true);
        assert.equal(
          new Date(boundaries.summer_next).toISOString(),
          "2026-08-08T06:00:00.000Z",
        );
        assert.equal(
          new Date(boundaries.winter_next).toISOString(),
          "2026-01-16T07:00:00.000Z",
        );
        assert.equal(
          new Date(boundaries.disabled_next).toISOString(),
          "2026-08-07T22:30:00.000Z",
        );
      });

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
        const renewed = await one(
          db,
          "select * from public.renew_telegram_review_session($1, $2)",
          [expired.draft.id, new Date(Date.now() + 60_000)],
        );
        assert.equal(renewed.id, expired.session.id);

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

      await t.test("failure counts preserve active claim ownership before quarantine", async () => {
        const updateId = Date.now() + 2;
        cleanup.push(["update", updateId]);

        const firstFailure = await one(
          db,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [updateId, "public_feedback", "handler_failed", 3, false, null],
        );
        assert.deepEqual(firstFailure, {
          attempt_count: 1,
          terminal: false,
          failure_status: "failed",
          recorded: true,
        });

        const retryClaim = await one(
          db,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "public_feedback", 30],
        );
        assert.equal(retryClaim.claimed, true);

        const busyObservation = await one(
          peer,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [updateId, "public_feedback", "handler_failed", 3, false, null],
        );
        assert.deepEqual(busyObservation, {
          attempt_count: 1,
          terminal: false,
          failure_status: "processing",
          recorded: false,
        });
        assert.equal(
          await scalar(db, "finish_telegram_update", [
            updateId,
            retryClaim.claim_token,
            "failed",
            "handler_failed",
          ]),
          true,
        );

        const secondFailure = await one(
          db,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [updateId, "public_feedback", "handler_failed", 3, false, null],
        );
        assert.deepEqual(secondFailure, {
          attempt_count: 2,
          terminal: false,
          failure_status: "failed",
          recorded: true,
        });

        const finalClaim = await one(
          peer,
          "select * from public.claim_telegram_update($1, $2, $3)",
          [updateId, "public_feedback", 30],
        );
        assert.equal(finalClaim.claimed, true);
        const wrongOwner = await one(
          db,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [
            updateId,
            "public_feedback",
            "handler_failed",
            3,
            false,
            randomUUID(),
          ],
        );
        assert.deepEqual(wrongOwner, {
          attempt_count: 2,
          terminal: false,
          failure_status: "processing",
          recorded: false,
        });
        assert.equal(
          await scalar(peer, "finish_telegram_update", [
            updateId,
            finalClaim.claim_token,
            "failed",
            "handler_failed",
          ]),
          true,
        );

        const quarantined = await one(
          db,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [updateId, "public_feedback", "handler_failed", 3, false, null],
        );
        assert.deepEqual(quarantined, {
          attempt_count: 3,
          terminal: true,
          failure_status: "quarantined",
          recorded: true,
        });
        assert.deepEqual(
          await one(
            peer,
            "select * from public.claim_telegram_update($1, $2, $3)",
            [updateId, "public_feedback", 30],
          ),
          { claimed: false, claim_token: null, claim_status: "terminal" },
        );

        const replay = await one(
          peer,
          "select * from public.record_telegram_update_failure($1, $2, $3, $4, $5, $6)",
          [updateId, "public_feedback", "different_error", 3, false, null],
        );
        assert.deepEqual(replay, { ...quarantined, recorded: false });
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

      await t.test("settings versions and due schedule claims have one winner", async () => {
        const channelId = `@schedule_${randomUUID().replaceAll("-", "")}`;
        cleanup.push(["settings", channelId]);
        const created = await one(
          db,
          "select * from public.get_or_create_news_settings($1, $2, $3)",
          [channelId, 101, 303],
        );
        assert.equal(created.version, 1);

        const updateValues = [
          channelId,
          101,
          60,
          "de",
          ["world", "nature"],
          ["Ocean exploration"],
          "manual",
          303,
          created.version,
        ];
        const versionRace = await Promise.all([
          db.query(
            "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            updateValues,
          ),
          peer.query(
            "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            updateValues,
          ),
        ]);
        assert.equal(
          versionRace.reduce((count, result) => count + result.rows.length, 0),
          1,
        );

        await db.query(
          "update public.news_bot_settings set quiet_hours_enabled = false, next_run_at = $1 where telegram_channel_id = $2",
          [new Date("2000-01-01T00:00:00Z"), channelId],
        );
        const pipelineOwner = randomUUID();
        cleanup.push(["lease", "daily-news-pipeline"]);
        assert.equal(
          await scalar(db, "acquire_pipeline_lease", [
            "daily-news-pipeline",
            pipelineOwner,
            30,
          ]),
          true,
        );
        assert.equal(
          (
            await peer.query(
              "select * from public.claim_due_news_schedule($1, $2)",
              [randomUUID(), 30],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          await scalar(db, "release_pipeline_lease", [
            "daily-news-pipeline",
            pipelineOwner,
          ]),
          true,
        );
        const firstToken = randomUUID();
        const competingToken = randomUUID();
        const claims = await Promise.all([
          db.query("select * from public.claim_due_news_schedule($1, $2)", [
            firstToken,
            30,
          ]),
          peer.query("select * from public.claim_due_news_schedule($1, $2)", [
            competingToken,
            30,
          ]),
        ]);
        const won = claims.flatMap((result) => result.rows);
        assert.equal(won.length, 1);
        const winningToken = won[0].schedule_claim_token;
        assert.ok([firstToken, competingToken].includes(winningToken));

        await db.query(
          "update public.news_bot_settings set schedule_claimed_at = $1 where telegram_channel_id = $2",
          [new Date(Date.now() - 31_000), channelId],
        );
        const recoveryToken = randomUUID();
        const recovered = await one(
          peer,
          "select * from public.claim_due_news_schedule($1, $2)",
          [recoveryToken, 30],
        );
        assert.equal(recovered.telegram_channel_id, channelId);
        assert.equal(recovered.schedule_claim_token, recoveryToken);
        assert.equal(recovered.schedule_run_id, won[0].schedule_run_id);
        assert.equal(recovered.schedule_settings_snapshot.languageCode, "de");
        assert.equal(
          await scalar(peer, "renew_news_schedule_claim", [
            channelId,
            recoveryToken,
          ]),
          true,
        );
        assert.equal(
          await scalar(db, "renew_news_schedule_claim", [
            channelId,
            winningToken,
          ]),
          false,
        );

        const scheduled = await createReviewFixture(db, randomUUID());
        cleanup.push(["review", scheduled.session.id, scheduled.article.id]);
        assert.equal(
          await scalar(db, "has_pending_telegram_review", [channelId]),
          true,
        );
        assert.equal(
          await scalar(peer, "save_news_schedule_draft", [
            channelId,
            recoveryToken,
            scheduled.draft.id,
            "Durable scheduled preview",
            48,
          ]),
          true,
        );

        const changedDuringRun = await one(
          db,
          "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [
            channelId,
            101,
            60,
            "uk",
            ["history"],
            [],
            "automatic",
            false,
            303,
            recovered.version,
          ],
        );
        assert.equal(changedDuringRun.schedule_claim_token, recoveryToken);
        assert.equal(
          changedDuringRun.schedule_settings_snapshot.languageCode,
          "de",
        );
        assert.equal(
          await scalar(peer, "save_news_schedule_publication", [
            channelId,
            recoveryToken,
            scheduled.draft.id,
            909,
          ]),
          true,
        );

        assert.equal(
          await scalar(db, "finish_news_schedule", [
            channelId,
            winningToken,
            "published",
            null,
          ]),
          false,
        );
        assert.equal(
          await scalar(peer, "finish_news_schedule", [
            channelId,
            recoveryToken,
            "published",
            null,
          ]),
          true,
        );
        const finished = await one(
          db,
          "select * from public.get_news_settings($1)",
          [channelId],
        );
        assert.equal(finished.schedule_claim_token, null);
        assert.equal(finished.schedule_run_id, null);
        assert.equal(finished.schedule_draft_id, null);
        assert.equal(finished.last_run_status, "published");
        assert.ok(new Date(finished.next_run_at) > new Date());
      });

      await t.test("unresolved pause fences stale settings callbacks", async () => {
        const channelId = `@unresolved_${randomUUID().replaceAll("-", "")}`;
        cleanup.push(["settings", channelId]);
        const created = await one(
          db,
          "select * from public.get_or_create_news_settings($1, $2, $3)",
          [channelId, 101, 303],
        );
        const enabled = await one(
          db,
          "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [channelId, 101, 60, "en", ["world"], [], "automatic", false, 303, created.version],
        );
        await db.query(
          "update public.news_bot_settings set next_run_at = now() - interval '1 minute' where telegram_channel_id = $1",
          [channelId],
        );
        const token = randomUUID();
        await one(
          db,
          "select * from public.claim_due_news_schedule($1, $2)",
          [token, 30],
        );
        assert.equal(
          await scalar(db, "pause_news_schedule_unresolved", [
            channelId,
            token,
            "publication_unresolved",
          ]),
          true,
        );
        const paused = await one(
          db,
          "select * from public.get_news_settings($1)",
          [channelId],
        );
        assert.equal(paused.schedule_interval_minutes, null);
        assert.equal(paused.version, enabled.version + 1);
        assert.equal(
          (
            await db.query(
              "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9)",
              [channelId, 101, 60, "en", ["world"], [], "automatic", 303, enabled.version],
            )
          ).rows.length,
          0,
        );
      });

      await t.test("settings constraints reject unsupported values", async () => {
        const channelId = `@invalid_${randomUUID().replaceAll("-", "")}`;
        await assert.rejects(
          db.query(
            "insert into public.news_bot_settings (telegram_channel_id, review_chat_id, schedule_interval_minutes, next_run_at, language_code, updated_by) values ($1, 101, 30, now(), 'fr', 303)",
            [channelId],
          ),
          /check constraint/i,
        );
        await assert.rejects(
          db.query(
            "insert into public.news_bot_settings (telegram_channel_id, review_chat_id, topic_codes, custom_topics, updated_by) values ($1, 101, '{}', '{}', 303)",
            [channelId],
          ),
          /check constraint/i,
        );
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
        } else if (item[0] === "settings") {
          await db.query(
            "delete from public.news_bot_settings where telegram_channel_id = $1",
            [item[1]],
          );
        } else if (item[0] === "review") {
          await db.query("delete from public.telegram_review_sessions where id = $1", [item[1]]);
          await db.query("delete from public.articles where id = $1", [item[2]]);
        }
      }
      await Promise.all([db.end(), peer.end()]);
    }
  },
);
