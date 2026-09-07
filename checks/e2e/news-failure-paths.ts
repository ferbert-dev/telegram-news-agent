import assert from "node:assert/strict";
import test from "node:test";

import {
  RIG_CONNECTION,
  RIG_ENABLED,
  withNewsRig,
} from "./support/news-rig.js";

/**
 * The days `/news` does not go well.
 *
 * Every scenario here is a failure that has actually reached a live bot, or is
 * one step away from it. They exist because the happy-path check was green
 * through four consecutive integration failures: it could not reach any of
 * these paths, so it reported a safety it had never established.
 *
 * The property under test is almost always the same one, and it is worth naming
 * because it is easy to get backwards: **a dependency that fails must degrade
 * the article, never fail the run** — except at the gate before the send, where
 * anything uncertain must stop the post entirely. Detail is optional. Posting
 * the wrong thing is not.
 */

const skip = !RIG_ENABLED || !RIG_CONNECTION;

/**
 * A scenario that never reached the pipeline proves nothing, and it proves it
 * quickly — which is how it hides. Four of these passed in under 110ms while
 * the ones doing real work took five to thirteen seconds, and every assertion
 * in them held against an empty job row.
 *
 * So the work is asserted, not assumed: the feed must have been fetched and the
 * model must have been asked something. Any scenario whose worker claimed
 * nothing now fails here instead of reporting a safety it never tested.
 */
function assertPipelineRan(rig: {
  feedRequests: () => number;
  schemaCounters: Record<string, number>;
  diagnosis: () => string;
}): void {
  assert.ok(
    rig.feedRequests() > 0,
    `the scenario never fetched a feed, so it tested nothing\n  ${rig.diagnosis()}`,
  );
  assert.ok(
    Object.keys(rig.schemaCounters).length > 0,
    `the scenario never reached the model, so it tested nothing\n  ${rig.diagnosis()}`,
  );
}

/** What the Exa content adapter throws once the day's budget is spent. */
class QuotaExhausted extends Error {
  constructor() {
    super("Exa daily content cap reached");
    this.name = "ExaDailyContentCapError";
  }
}

test(
  "the run still produces an article when the content provider is over its quota",
  { skip },
  async () => {
    // EXA_DAILY_SEARCH_CAP is 24. The 25th article of the day gets this, and so
    // does every article if the key is rejected or Exa is down. Before the
    // fallback existed this was a failed run and a silent bot.
    await withNewsRig(
      {
        host: "content-quota.example.test",
        articleContent: {
          async fetch() {
            throw new QuotaExhausted();
          },
        },
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.equal(
          job?.error_code,
          null,
          `a content provider over quota must not fail the run\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          job?.outcome_status,
          "review_ready",
          `the article must still be written from what is available\n  ${rig.diagnosis()}`,
        );
        assert.ok(job?.draft_id, "a draft must still exist");

        // And nothing may be recorded as having come from the content service,
        // because it threw on every call. A run that reports a source it never
        // used is worse than one that reports nothing.
        const { rows } = await rig.pool.query(
          `select count(*)::int as n from public.raw_contents
            where metadata->>'source_url' like $1
              and metadata->>'retrieved_by' = 'content-service'`,
          [`https://${rig.host}/%`],
        );
        assert.equal(
          rows[0]?.n,
          0,
          "a provider that threw must not be credited with the text",
        );
      },
    );
  },
);

test(
  "one failed search does not throw away the source another already paid for",
  { skip },
  async () => {
    // The mutation that exposed this: deleting the per-request catch inside
    // EvidenceCorroborationService changed nothing, because the draft gateway
    // wraps the whole block in a catch of its own and falls back to the
    // original evidence. Both survive a failure -- but the outer one discards
    // every source the earlier searches already found, and Exa searches cost
    // money.
    //
    // So the scenario has to distinguish them: the first search succeeds, the
    // second throws, and the source from the first must still reach the draft.
    let searches = 0;
    await withNewsRig(
      {
        host: "search-partial.example.test",
        ai(request) {
          if (request.expectedClaim && request.query) {
            searches += 1;
            if (searches > 1) throw new Error("Exa search unavailable");
          }
          return undefined;
        },
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.equal(
          job?.error_code,
          null,
          `a failed search must not fail the run\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          job?.outcome_status,
          "review_ready",
          `the article must still be written\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          rig.factSearches.length,
          1,
          `exactly one search may be recorded as successful\n  ${rig.diagnosis()}`,
        );
        const evidence = rig.draftEvidence.at(-1) ?? [];
        assert.ok(
          evidence.some((url) => url.startsWith("https://corroborator-")),
          `the source the successful search found must survive the failed one\n  ${rig.diagnosis()}`,
        );
      },
    );
  },
);

test(
  "the run still produces an article when every corroboration search fails",
  { skip },
  async () => {
    // The other half of the Exa budget, exhausted or down. Nothing is found,
    // nothing is added, and in particular the draft must not be opted into
    // `allowUnverified` -- that opt-in exists only to admit sources this
    // gateway actually appended.
    await withNewsRig(
      {
        host: "search-down.example.test",
        ai(request) {
          if (request.expectedClaim && request.query) {
            throw new Error("Exa search unavailable");
          }
          return undefined;
        },
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.equal(
          job?.error_code,
          null,
          `a failed search must not fail the run\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          job?.outcome_status,
          "review_ready",
          `the article must still be written\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          rig.factSearches.length,
          0,
          "no search may be recorded as successful when every one threw",
        );
        assert.ok(
          (rig.schemaCounters.fact_plan ?? 0) > 0,
          `the planner must still have run\n  ${rig.diagnosis()}`,
        );
      },
    );
  },
);

test(
  "the run still produces an article when the fact planner answers with nothing usable",
  { skip },
  async () => {
    // A model that returns a schema-valid but empty plan, or drifts off the
    // schema entirely. `FactPlanService.plan` returns [] on any failure, and
    // corroboration treats an empty plan as "nothing to ask" rather than as an
    // error. This proves that path is reached rather than assumed.
    await withNewsRig(
      {
        host: "no-plan.example.test",
        ai(_request, schema) {
          if (schema.includes("fact_plan")) return { nonsense: true };
          return undefined;
        },
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.equal(
          job?.error_code,
          null,
          `an unusable plan must not fail the run\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          job?.outcome_status,
          "review_ready",
          `the article must still be written\n  ${rig.diagnosis()}`,
        );
        assert.equal(
          rig.factSearches.length,
          0,
          "no budget may be spent when there is nothing to ask",
        );
      },
    );
  },
);

test(
  "nothing reaches the channel when the excluded-topic gate blocks the publication",
  { skip },
  async () => {
    // The gate that runs immediately before the send, against the exact
    // outbound text. It exists because the research-stage classification looks
    // at a different artefact and can let something through. A regression here
    // is a blocked topic reaching real readers, which cannot be undone.
    await withNewsRig(
      {
        host: "blocked-topic.example.test",
        ai(_request, schema) {
          if (schema === "final_publication_excluded_topic_classification") {
            return {
              assessments: [{ topicCode: "war_conflict", relation: "main_subject" }],
            };
          }
          return undefined;
        },
      },
      async (rig) => {
        await rig.pool.query(
          "update public.news_bot_settings set excluded_topic_codes = $2 where telegram_channel_id = $1",
          [rig.channelId, ["war_conflict"]],
        );

        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.equal(
          job?.outcome_status,
          "review_ready",
          `research must still reach a draft\n  ${rig.diagnosis()}`,
        );
        const draftId = String(job?.draft_id);
        await rig.editorialPersistence.approveDraft(draftId);

        const result = await rig.editorial.publishApprovedDraft({
          draftId,
          channelId: rig.channelId,
          publicationPath: "manual_review",
        });

        assert.notEqual(
          result.status,
          "published",
          `a blocked topic must not publish; got ${JSON.stringify(result)}`,
        );
        assert.equal(
          rig.published.length,
          0,
          "nothing may reach the channel once the gate has blocked",
        );
        const { rows } = await rig.pool.query(
          "select count(*)::int as n from public.published_posts where draft_id = $1",
          [draftId],
        );
        assert.equal(rows[0]?.n, 0, "and no publication row may be written");
      },
    );
  },
);

test(
  "an uncertain classifier blocks the publication rather than guessing",
  { skip },
  async () => {
    // Fail-closed, stated as a test. `uncertain` and `main_subject` both block;
    // the difference is only the reason code. A change that made `uncertain`
    // permissive would look like a small relaxation and would publish exactly
    // the articles nobody could classify.
    await withNewsRig(
      {
        host: "uncertain-topic.example.test",
        ai(_request, schema) {
          if (schema === "final_publication_excluded_topic_classification") {
            return {
              assessments: [{ topicCode: "war_conflict", relation: "uncertain" }],
            };
          }
          return undefined;
        },
      },
      async (rig) => {
        await rig.pool.query(
          "update public.news_bot_settings set excluded_topic_codes = $2 where telegram_channel_id = $1",
          [rig.channelId, ["war_conflict"]],
        );

        await rig.enqueue();
        await rig.runWorkerOnce();
        assertPipelineRan(rig);
        const job = await rig.jobRow();
        const draftId = String(job?.draft_id);
        await rig.editorialPersistence.approveDraft(draftId);

        const result = await rig.editorial.publishApprovedDraft({
          draftId,
          channelId: rig.channelId,
          publicationPath: "manual_review",
        });
        assert.notEqual(result.status, "published");
        assert.equal(rig.published.length, 0, "uncertainty must not reach the channel");
      },
    );
  },
);

test(
  "a feed that answers 500 ends the job cleanly and tells the requester",
  { skip },
  async () => {
    // The bot's worst behaviour is not an error message, it is silence. A dead
    // feed must reach a terminal job state and produce something the requester
    // sees, rather than leaving a claim to expire.
    await withNewsRig(
      {
        host: "dead-feed.example.test",
        feedResponse: () => new Response("upstream is down", { status: 500 }),
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.ok(
          job?.outcome_status !== "review_ready",
          `a dead feed cannot produce an article; got ${job?.outcome_status}`,
        );

        // Drain to the terminal state, however many phases that takes. The
        // assertion is that it terminates -- a job that stays claimed is the
        // failure this scenario is about.
        for (let i = 0; i < 4; i += 1) {
          const current = await rig.jobRow();
          if (current?.status === "completed" || current?.status === "failed") break;
          await rig.runWorkerOnce();
        }

        const final = await rig.jobRow();
        assert.ok(
          final?.status === "completed" || final?.status === "failed",
          `the job must reach a terminal state, not stay claimed; got ${final?.status}\n  ${rig.diagnosis()}`,
        );
        assert.equal(rig.published.length, 0, "and nothing may be posted");
        assert.ok(
          rig.deliveries.length > 0 || rig.sentToTelegram.length > 0,
          `the requester must be told something\n  ${rig.diagnosis()}`,
        );
      },
    );
  },
);

test(
  "a second /news while one is running is suppressed rather than queued twice",
  { skip },
  async () => {
    // Documented as the stage's most confusing failure, and the guard against
    // paying for the same research twice. Two jobs for one channel is two
    // research passes and, at the end, two drafts of the same story.
    await withNewsRig({ host: "double-news.example.test" }, async (rig) => {
      assert.equal((await rig.enqueue()).status, "research_queued");

      const second = await rig.enqueue(rig.updateId + 1);
      assert.equal(
        second.status,
        "already_running",
        `a concurrent /news must be suppressed; got ${JSON.stringify(second)}`,
      );

      const { rows } = await rig.pool.query(
        `select count(*)::int as n from public.telegram_news_jobs
          where telegram_channel_id = $1 and status in ('queued', 'processing')`,
        [rig.channelId],
      );
      assert.equal(rows[0]?.n, 1, "exactly one job may be live for a channel");
    });
  },
);

test(
  "a draft citing a source it was never given is refused, not published",
  { skip },
  async () => {
    // The grounding validator is the last defence against a model inventing a
    // citation. It must refuse the draft outright: an article whose sources
    // cannot be checked is worse than no article, because it reads exactly like
    // one that can.
    await withNewsRig(
      {
        host: "ungrounded.example.test",
        ai(request, schema) {
          if (!schema.includes("draft") && !schema.includes("Draft")) return undefined;
          const input = request.input as { article?: { title?: string } };
          const headline = String(input.article?.title ?? "Untitled");
          const invented = "https://never-supplied.example/exclusive";
          return {
            headline,
            telegramText: [headline, "", "A claim.", "", "Source:", invented].join("\n"),
            claims: [{ text: headline, sourceUrl: invented }],
            sourceUrls: [invented],
            caveat: "None.",
            topicTags: [],
          };
        },
      },
      async (rig) => {
        assert.equal((await rig.enqueue()).status, "research_queued");
        await rig.runWorkerOnce();
        assertPipelineRan(rig);

        const job = await rig.jobRow();
        assert.notEqual(
          job?.outcome_status,
          "review_ready",
          `an ungrounded draft must not become a review card\n  ${rig.diagnosis()}`,
        );
        assert.equal(rig.published.length, 0, "and nothing may be posted");
        assert.equal(
          rig.deliveries.length,
          0,
          "and no review card may be delivered",
        );
      },
    );
  },
);
