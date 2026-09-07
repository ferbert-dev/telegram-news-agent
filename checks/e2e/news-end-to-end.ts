import assert from "node:assert/strict";
import test from "node:test";

import {
  RIG_CONNECTION,
  RIG_ENABLED,
  withNewsRig,
} from "./support/news-rig.js";

/**
 * `/news` on a good day: enqueue, worker, research, corroboration, drafting,
 * review delivery, approval, publication, and the second publish that must not
 * post again.
 *
 * This is the shape of the flow. The paths where it goes wrong are in
 * `news-failure-paths.ts`, and those are where the integration failures
 * actually lived.
 *
 * What is real: PostgreSQL, all the atomic SQL functions, the job queue, the
 * worker, the workflow and delivery adapters, the research gateway, the
 * editorial services, the checkpoint and lease semantics.
 *
 * What is faked, and only these: the HTTP transport that fetches feeds, the AI
 * provider, and the Telegram send.
 */

const skip = !RIG_ENABLED || !RIG_CONNECTION;

test(
  "/news runs end to end against real PostgreSQL without a network call or a paid request",
  { skip },
  async () => {
    await withNewsRig({ host: "happy.example.test" }, async (rig) => {
      const queued = await rig.enqueue();
      assert.equal(
        queued.status,
        "research_queued",
        "the command must accept and return",
      );

      // Execute phase, then delivery phase. Two claims, exactly as the running
      // worker does it.
      assert.equal(
        await rig.runWorkerOnce(),
        "advanced",
        "the research phase must advance the job",
      );

      const afterExecute = await rig.jobRow();
      assert.equal(
        afterExecute?.error_code,
        null,
        `the run failed with ${afterExecute?.error_code}\n  ${rig.diagnosis()}`,
      );
      assert.equal(
        afterExecute?.outcome_status,
        "review_ready",
        `outcome was ${afterExecute?.outcome_status}\n  ${rig.diagnosis()}`,
      );
      assert.ok(afterExecute?.draft_id, "a draft must exist after the research phase");

      const checkpoint = await rig.checkpoint();
      assert.equal(checkpoint?.status, "review_ready");
      assert.ok(
        checkpoint?.preview,
        "the checkpoint must carry the preview the review card renders",
      );

      assert.equal(
        await rig.runWorkerOnce(),
        "advanced",
        "the delivery phase must advance the job",
      );

      const afterDeliver = await rig.jobRow();
      assert.equal(afterDeliver?.status, "completed");
      assert.equal(rig.deliveries.length, 1, "exactly one review card");
      assert.equal(rig.deliveries[0]?.draftId, afterExecute?.draft_id);

      // --- the publish half -------------------------------------------------
      //
      // Everything above proved a draft reaches a reviewer. This proves the
      // half that cannot be undone: approve, publish, and exactly one post.
      const draftId = String(afterExecute?.draft_id);

      // A draft must be `approved` before the publication claim will take it --
      // `claim_draft_for_publication_with_policy` accepts nothing else. This is
      // the human tapping Approve.
      await rig.editorialPersistence.approveDraft(draftId);

      const firstPublish = await rig.editorial.publishApprovedDraft({
        draftId,
        channelId: rig.channelId,
        publicationPath: "manual_review",
      });
      assert.equal(
        firstPublish.status,
        "published",
        `the draft must publish; got ${JSON.stringify(firstPublish)}`,
      );
      assert.equal(rig.published.length, 1, "exactly one post reaches the channel");
      assert.equal(rig.published[0]?.channelId, rig.channelId);

      const { rows: publications } = await rig.pool.query(
        "select telegram_message_id from public.published_posts where draft_id = $1",
        [draftId],
      );
      assert.equal(publications.length, 1, "exactly one publication row");
      assert.equal(Number(publications[0]?.telegram_message_id), 9001);

      // Idempotency, against the real SQL functions rather than a fake: a
      // second publish of the same draft must return the existing publication
      // and send nothing. A divergence here is a duplicate post in a real
      // channel, which is the single worst outcome this system can produce.
      const secondPublish = await rig.editorial.publishApprovedDraft({
        draftId,
        channelId: rig.channelId,
        publicationPath: "manual_review",
      });
      assert.equal(secondPublish.status, "already_published");
      assert.equal(
        rig.published.length,
        1,
        "a second publish must not reach the channel again",
      );
      const { rows: afterSecond } = await rig.pool.query(
        "select count(*)::int as n from public.published_posts where draft_id = $1",
        [draftId],
      );
      assert.equal(afterSecond[0]?.n, 1, "still exactly one publication row");

      // The point of the whole exercise: this cost nothing.
      assert.ok(rig.feedRequests() > 0, "the feed transport must actually have been used");

      // Both Exa paths, on a primary-source article, which is the case that
      // used to fail outright.
      //
      // The search path adds `web_source` items, and draft.js:293 refuses a
      // primary article whose evidence is not all primary. The gateway opts the
      // draft in only when it actually added sources, which is what makes
      // "always search" possible without touching frozen legacy. Removing
      // either the guard or the opt-in brings back "Draft generation requires
      // primary-source evidence".
      assert.ok(
        (rig.schemaCounters.fact_plan ?? 0) > 0,
        `every article must be planned for; ${rig.diagnosis()}`,
      );
      assert.ok(
        rig.factSearches.length > 0,
        `every article must be searched; ${rig.diagnosis()}`,
      );

      // The content port now runs for EVERY article, primary included: it loads
      // the same url the candidate already has, so it adds no source and cannot
      // change the verification class. That is what separates it from the
      // search path, which does add sources and stays gated.
      assert.ok(
        rig.contentFetches.length > 0,
        "the full article must be retrieved through the content port",
      );

      // Every evidence item the model was handed must carry readable text.
      //
      // The corroboration module put its excerpt in `evidenceText` while the
      // whole editorial pipeline reads `text`. Grounding only looks at `url`,
      // so nothing failed -- but the appended source reached the model as a
      // bare link, and editorial-enrichment.js, which reads
      // `item.text ?? item.excerpt`, threw on every run. Four runs on the
      // stage reported `enrichment_failed` with no message.
      const handed = rig.draftEvidenceText.at(-1) ?? [];
      assert.ok(handed.length > 1, `corroboration must have appended a source; ${rig.diagnosis()}`);
      assert.ok(
        handed.every((chars) => chars > 0),
        `every evidence item must carry readable text; lengths ${JSON.stringify(handed)}`,
      );

      // And the database has to say so afterwards.
      //
      // Both retrieval paths used to write the same `extractor`, so once a run
      // was over nothing recorded which one produced the text. On the stage
      // that made "is the full-article path working?" unanswerable from any
      // artefact the run left behind -- the ledger showed searchFact and
      // nothing at all for content retrieval. A dependency that spends metered
      // budget and leaves no trace cannot be told from one that never ran.
      const { rows: rawContents } = await rig.pool.query(
        `select extractor, metadata->>'retrieved_by' as retrieved_by, length(content) as chars
           from public.raw_contents
          where metadata->>'source_url' like $1
          order by created_at desc limit 1`,
        [`https://${rig.host}/%`],
      );
      assert.equal(
        rawContents[0]?.retrieved_by,
        "content-service",
        `the stored text must name its producer; got ${JSON.stringify(rawContents[0])}`,
      );
      assert.match(
        String(rawContents[0]?.extractor),
        /content-service$/,
        `and the extractor column must agree with it; got ${JSON.stringify(rawContents[0])}`,
      );
    });
  },
);
