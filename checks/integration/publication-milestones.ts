import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "publication milestone claim has one PostgreSQL winner and fences ambiguous delivery",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const suffix = randomUUID();
    const channelId = `@milestone_${suffix.replaceAll("-", "")}`;
    const articleIds: string[] = [];
    const draftIds: string[] = [];
    let lastPublicationId = "";

    try {
      await pool.query(
        `insert into public.news_bot_settings (
           telegram_channel_id, review_chat_id, updated_by
         ) values ($1, 1, 1)`,
        [channelId],
      );

      for (let ordinal = 1; ordinal <= 50; ordinal += 1) {
        const article = await pool.query<{ id: string }>(
          `insert into public.articles (canonical_url, title)
           values ($1, $2) returning id`,
          [
            `https://publication-milestone.test/${suffix}/${ordinal}`,
            `Milestone article ${ordinal}`,
          ],
        );
        articleIds.push(article.rows[0].id);
        const draft = await pool.query<{ id: string }>(
          `insert into public.drafts (article_id, body, status)
           values ($1, $2, 'published') returning id`,
          [article.rows[0].id, `Milestone draft ${ordinal}`],
        );
        draftIds.push(draft.rows[0].id);
        const publication = await pool.query<{ id: string }>(
          `insert into public.published_posts (
             draft_id, article_id, telegram_channel_id,
             telegram_message_id, published_at, message_text
           ) values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            draft.rows[0].id,
            article.rows[0].id,
            channelId,
            100_000 + ordinal,
            new Date(Date.UTC(2026, 7, 21, 10, 0, ordinal)),
            `Published milestone article ${ordinal}`,
          ],
        );
        lastPublicationId = publication.rows[0].id;
      }

      const claimSql = `select id, state, claim_token::text as claim_token,
                               ordinal, attempt_count
                        from public.claim_publication_milestone($1, 'en', 'Mikhail')`;
      const claims = await Promise.all([
        pool.query(claimSql, [lastPublicationId]),
        pool.query(claimSql, [lastPublicationId]),
      ]);
      assert.deepEqual(
        claims.map(({ rowCount }) => rowCount).sort(),
        [0, 1],
      );
      const winner = claims.flatMap(({ rows }) => rows)[0] as {
        id: string;
        state: string;
        claim_token: string;
        ordinal: number;
        attempt_count: number;
      };
      assert.equal(winner.state, "sending");
      assert.equal(winner.ordinal, 50);
      assert.equal(winner.attempt_count, 1);
      assert.match(winner.claim_token, /^[0-9a-f-]{36}$/);

      assert.equal(
        (await pool.query(claimSql, [lastPublicationId])).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "select * from public.reconcile_publication_milestone_not_sent($1)",
            [winner.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "select * from public.reconcile_publication_milestone_sent($1, 9000)",
            [winner.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            `select * from public.mark_publication_milestone_uncertain(
               $1, $2, 'timeout after Telegram acceptance'
             )`,
            [winner.id, winner.claim_token],
          )
        ).rows[0].state,
        "uncertain",
      );
      assert.equal(
        (await pool.query(claimSql, [lastPublicationId])).rowCount,
        0,
      );

      assert.equal(
        (
          await pool.query(
            "select * from public.reconcile_publication_milestone_not_sent($1)",
            [winner.id],
          )
        ).rows[0].state,
        "failed",
      );
      const retries = await Promise.all([
        pool.query(
          "select * from public.retry_publication_milestone($1)",
          [winner.id],
        ),
        pool.query(
          "select * from public.retry_publication_milestone($1)",
          [winner.id],
        ),
      ]);
      assert.deepEqual(
        retries.map(({ rowCount }) => rowCount).sort(),
        [0, 1],
      );
      const retryWinner = retries.flatMap(({ rows }) => rows)[0] as {
        claim_token: string;
      };
      assert.equal(
        (
          await pool.query(
            "select * from public.mark_publication_milestone_sent($1, $2, 9001)",
            [winner.id, randomUUID()],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "select * from public.mark_publication_milestone_sent($1, $2, 9001)",
            [winner.id, retryWinner.claim_token],
          )
        ).rows[0].state,
        "sent",
      );

      const privileges = await pool.query<{
        service_claim: boolean;
        service_uncertain: boolean;
        anon_execute: boolean;
      }>(
        `select
           has_function_privilege(
             'service_role',
             'public.claim_publication_milestone(uuid,text,text)',
             'EXECUTE'
           ) as service_claim,
           has_function_privilege(
             'service_role',
             'public.mark_publication_milestone_uncertain(uuid,uuid,text)',
             'EXECUTE'
           ) as service_uncertain,
           has_function_privilege(
             'anon',
             'public.claim_publication_milestone(uuid,text,text)',
             'EXECUTE'
           ) as anon_execute`,
      );
      assert.equal(privileges.rows[0].service_claim, true);
      assert.equal(privileges.rows[0].service_uncertain, true);
      assert.equal(privileges.rows[0].anon_execute, false);
    } finally {
      await pool.query(
        "delete from public.published_posts where telegram_channel_id = $1",
        [channelId],
      ).catch(() => {});
      await pool.query(
        "delete from public.drafts where id = any($1::uuid[])",
        [draftIds],
      ).catch(() => {});
      await pool.query(
        "delete from public.articles where id = any($1::uuid[])",
        [articleIds],
      ).catch(() => {});
      await pool.query(
        "delete from public.news_bot_settings where telegram_channel_id = $1",
        [channelId],
      ).catch(() => {});
      await pool.end();
    }
  },
);
