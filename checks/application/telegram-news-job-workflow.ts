import assert from "node:assert/strict";
import test from "node:test";

import { TypedNewsJobWorkflowAdapter } from "../../src/telegram/typed-news-job-workflow.adapter.js";
import { TypedNewsJobDeliveryAdapter } from "../../src/telegram/typed-news-job-delivery.adapter.js";
import type {
  TelegramNewsCheckpointRow,
  TelegramNewsJobClaimRow,
  SaveTelegramNewsCheckpointInput,
} from "../../src/telegram/telegram-persistence.contracts.js";

/**
 * The `/news` research and delivery phases for the typed runtime.
 *
 * These two adapters are the reason `/news` did anything at all on the typed
 * runtime, and every assertion here is aimed at a way it could quietly do the
 * wrong thing rather than fail loudly: research a second time and be billed
 * twice, publish a draft that was never approved, generate under an automatic
 * policy that publishes before the checkpoint exists, hold the pipeline lease
 * after a failure, or answer the operator with the wrong sentence.
 */

const SETTINGS = {
  channelId: "@integration",
  reviewChatId: 4242,
  approvalPolicy: "manual",
  languageCode: "en",
  topicCodes: ["technology"],
  customTopics: [],
  excludedTopicCodes: [],
  version: 7,
};

function job(overrides: Partial<TelegramNewsJobClaimRow> = {}): TelegramNewsJobClaimRow {
  return {
    id: "job-1",
    request_update_id: 900_001,
    telegram_channel_id: "@integration",
    control_chat_id: 4242,
    requested_by: 77,
    settings_snapshot: SETTINGS as never,
    claim_phase: "execute",
    claim_token: "claim-1",
    outcome_status: null,
    draft_id: null,
    publication_message_id: null,
    error_code: null,
    execution_attempt_count: 0,
    delivery_attempt_count: 0,
    ...overrides,
  };
}

function checkpointRow(
  overrides: Partial<TelegramNewsCheckpointRow> = {},
): TelegramNewsCheckpointRow {
  return {
    update_id: 900_001,
    status: "review_ready",
    draft_id: "draft-1",
    preview: "Preview body",
    window_hours: 48,
    created_at: "2026-09-03T10:00:00.000Z",
    updated_at: "2026-09-03T10:00:00.000Z",
    publication_message_id: null,
    settings_snapshot: SETTINGS as never,
    ...overrides,
  };
}

class NoResearchCandidatesError extends Error {
  override readonly name = "NoResearchCandidatesError";
}

function selection(id = "article-1") {
  return {
    article: { id },
    source: { name: "Example", is_primary: true },
    canonicalUrl: "https://example.test/a",
    title: "A title",
    publishedAt: "2026-09-03T09:00:00.000Z",
    evidenceText: "Evidence.",
  };
}

/** Records every call, so ordering and non-calls are both assertable. */
function harness(
  options: {
    checkpoints?: TelegramNewsCheckpointRow | null;
    researchResults?: Array<"empty" | ReturnType<typeof selection> | Error>;
    acquire?: boolean;
    renew?: boolean;
    draftStatus?: string;
    publishResult?: unknown;
    settings?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];
  const saved: SaveTelegramNewsCheckpointInput[] = [];
  const generateInputs: Record<string, unknown>[] = [];
  let stored = options.checkpoints ?? null;
  const results = [...(options.researchResults ?? [selection()])];
  const timers: Array<() => void> = [];
  let approved = false;

  const adapter = new TypedNewsJobWorkflowAdapter({
    research: {
      async execute(request) {
        calls.push(`research:${(request.input as { windowHours?: number }).windowHours}`);
        const next = results.shift();
        if (next === undefined || next === "empty") {
          throw new NoResearchCandidatesError("no candidates");
        }
        if (next instanceof Error) throw next;
        return { selected: next as never };
      },
    },
    editorial: {
      async generateReviewDraft(input: Record<string, unknown>) {
        calls.push("generate");
        generateInputs.push(input);
        return {
          draft: { id: "draft-1" },
          generation: { draft: { body: "Preview body" } },
        };
      },
      async publishApprovedDraft() {
        calls.push("publish");
        // Mirrors `claim_draft_for_publication_with_policy`, which accepts only
        // an `approved` draft. Without this the fake would publish anything,
        // and a workflow that skipped the approve would still pass.
        if (!approved && (options.draftStatus ?? "review") === "review") {
          throw new Error("Draft is not publishable: not_approved");
        }
        return (
          options.publishResult ?? {
            status: "published",
            alreadyPublished: false,
            publication: { telegram_message_id: 555 },
          }
        );
      },
      async reconcilePublication() {
        throw new Error("unused");
      },
    } as never,
    editorialPersistence: {
      async getDraft() {
        calls.push("getDraft");
        return { id: "draft-1", status: options.draftStatus ?? "review" };
      },
      async approveDraft() {
        calls.push("approveDraft");
        approved = true;
        return { id: "draft-1", status: "approved" };
      },
    } as never,
    checkpoints: {
      async getTelegramNewsCheckpoint() {
        calls.push("getCheckpoint");
        return stored;
      },
      async saveTelegramNewsCheckpoint(input: SaveTelegramNewsCheckpointInput) {
        calls.push(`saveCheckpoint:${input.status}`);
        saved.push(input);
        stored = checkpointRow({
          status: input.status ?? "review_ready",
          draft_id: input.draft_id ?? null,
          preview: input.preview ?? null,
          window_hours: input.window_hours ?? null,
          publication_message_id: input.publication_message_id ?? null,
        });
        return stored;
      },
    },
    pipelineLease: {
      async acquire() {
        calls.push("acquire");
        return options.acquire ?? true;
      },
      async renew() {
        calls.push("renew");
        return options.renew ?? true;
      },
      async release() {
        calls.push("release");
        return true;
      },
    },
    ownerId: "owner-1",
    // Deterministic: the heartbeat never fires on its own, and a test that
    // wants a renewal drives it explicitly.
    setIntervalImpl: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearIntervalImpl: () => undefined,
  });

  return { adapter, calls, saved, generateInputs, fireHeartbeat: () => timers.forEach((t) => t()) };
}

test("an existing checkpoint is reported without researching again", async () => {
  const { adapter, calls } = harness({ checkpoints: checkpointRow() });

  const outcome = await adapter.run(job(), {});

  assert.deepEqual(outcome, {
    status: "review_ready",
    draftId: "draft-1",
    publicationMessageId: null,
  });
  // The whole point: the research was already done and paid for. A retry of
  // this job must not spend it again, so nothing may reach the provider.
  assert.deepEqual(calls, ["getCheckpoint"]);
});

test("a fresh job researches under the pipeline lease and checkpoints review_ready", async () => {
  const { adapter, calls, saved } = harness();

  const outcome = await adapter.run(job(), {});

  assert.equal(outcome.status, "review_ready");
  assert.equal(outcome.draftId, "draft-1");
  assert.deepEqual(calls, [
    "getCheckpoint",
    "acquire",
    "research:48",
    "generate",
    "release",
    "saveCheckpoint:review_ready",
  ]);
  // The lease is released before the checkpoint write, and both happen: a run
  // that kept the lease would block the scheduler for its full 15-minute TTL.
  assert.equal(saved[0]?.preview, "Preview body");
  assert.equal(saved[0]?.window_hours, 48);
});

test("an empty first tier escalates to the wider window rather than giving up", async () => {
  const { adapter, calls } = harness({ researchResults: ["empty", selection()] });

  const outcome = await adapter.run(job(), {});

  assert.equal(outcome.status, "review_ready");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("research")),
    ["research:48", "research:168"],
  );
});

test("a non-empty research failure surfaces immediately instead of escalating", async () => {
  const boom = new Error("provider exhausted");
  const { adapter, calls } = harness({ researchResults: [boom, selection()] });

  await assert.rejects(adapter.run(job(), {}), /provider exhausted/);
  // Escalating here would re-run a failing provider against a wider window,
  // spending more on the same failure.
  assert.deepEqual(
    calls.filter((call) => call.startsWith("research")),
    ["research:48"],
  );
  assert.ok(calls.includes("release"), "the lease must be released on failure");
});

test("every tier empty checkpoints no_candidates rather than throwing", async () => {
  const { adapter, calls } = harness({ researchResults: ["empty", "empty"] });

  const outcome = await adapter.run(job(), {});

  assert.deepEqual(outcome, {
    status: "no_candidates",
    draftId: null,
    publicationMessageId: null,
  });
  // Checkpointed, not merely returned: the delivery phase reads the
  // checkpoint, so an uncheckpointed outcome is undeliverable.
  assert.ok(calls.includes("saveCheckpoint:no_candidates"));
  assert.ok(calls.includes("release"));
});

test("a busy pipeline raises the message the worker classifies as a retryable busy", async () => {
  const { adapter, calls } = harness({ acquire: false });

  await assert.rejects(adapter.run(job(), {}), /already running/);
  // Wording is load-bearing: `defaultExecutionError` matches /already running/i
  // to choose a non-terminal retry. A reworded message becomes a terminal
  // failure and the operator's /news dies instead of waiting its turn.
  assert.deepEqual(calls, ["getCheckpoint", "acquire"]);
});

test("a lost lease stops the run before generation tokens are spent", async () => {
  const { adapter, calls, fireHeartbeat } = harness({
    renew: false,
    researchResults: [selection()],
  });

  const original = adapter as unknown as {
    options: { research: { execute: (...args: unknown[]) => Promise<unknown> } };
  };
  const inner = original.options.research.execute.bind(original.options.research);
  original.options.research.execute = async (...args: unknown[]) => {
    const result = await inner(...args);
    // The lease expires while research is running, which is the realistic
    // failure: research is the long phase.
    fireHeartbeat();
    await Promise.resolve();
    return result;
  };

  await assert.rejects(adapter.run(job(), {}), /ownership was lost/);
  assert.ok(!calls.includes("generate"), "generation must not run without the lease");
  assert.ok(calls.includes("release"));
});

test("an automatic channel generates a manual draft, then approves and publishes it", async () => {
  const { adapter, calls, saved, generateInputs } = harness({
    settings: { approvalPolicy: "automatic" },
  });
  const automatic = job({
    settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never,
  });

  const outcome = await adapter.run(automatic, {});

  assert.deepEqual(outcome, {
    status: "published",
    draftId: "draft-1",
    publicationMessageId: 555,
  });
  // Generation must not itself auto-publish: publishing before the
  // review_ready checkpoint exists would leave a published article that no
  // checkpoint records, so a crash in between loses the connection to /news.
  assert.equal(generateInputs[0]?.settingsSnapshot &&
    (generateInputs[0].settingsSnapshot as { approvalPolicy?: string }).approvalPolicy,
    "manual");
  assert.deepEqual(saved.map((entry) => entry.status), ["review_ready", "published"]);
  // `claim_draft_for_publication_with_policy` accepts only `approved`, so the
  // approve is a precondition, not a formality. Asserted as a subsequence
  // rather than with indexOf: a missing call gives indexOf -1, which is less
  // than every index, so the obvious form of this assertion cannot fail.
  assert.deepEqual(
    calls.filter((call) => ["getDraft", "approveDraft", "publish"].includes(call)),
    ["getDraft", "approveDraft", "publish"],
  );
});

test("an automatic run resumes from a review_ready checkpoint by publishing, not researching", async () => {
  const { adapter, calls } = harness({
    checkpoints: checkpointRow({
      settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never,
    }),
  });

  const outcome = await adapter.run(
    job({ settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never }),
    {},
  );

  assert.equal(outcome.status, "published");
  assert.ok(!calls.some((call) => call.startsWith("research")));
  assert.ok(!calls.includes("acquire"), "resuming a publish needs no pipeline lease");
});

test("a rejected draft is refused rather than published", async () => {
  const { adapter } = harness({
    draftStatus: "rejected",
    checkpoints: checkpointRow({
      settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never,
    }),
  });

  // Narrower than the scheduler's equivalent, which tolerates `rejected`.
  // Legacy's /news path does not, and publishing a draft a human rejected is
  // the worst outcome this path can produce.
  await assert.rejects(
    adapter.run(
      job({ settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never }),
      {},
    ),
    /is not publishable/,
  );
});

test("a policy block is checkpointed as blocked_by_policy, not as published", async () => {
  const { adapter, saved } = harness({
    publishResult: { status: "blocked", reasonCode: "excluded_topic", publication: null },
    checkpoints: checkpointRow({
      settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never,
    }),
  });

  const outcome = await adapter.run(
    job({ settings_snapshot: { ...SETTINGS, approvalPolicy: "automatic" } as never }),
    {},
  );

  assert.equal(outcome.status, "blocked_by_policy");
  assert.equal(outcome.publicationMessageId, null);
  assert.equal(saved.at(-1)?.status, "blocked_by_policy");
});

// --- delivery ---------------------------------------------------------------

function deliveryHarness(
  options: {
    checkpoint?: TelegramNewsCheckpointRow | null;
    reviewStatus?: string;
    notifyFails?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const reviews: Record<string, unknown>[] = [];
  const adapter = new TypedNewsJobDeliveryAdapter({
    checkpoints: {
      async getTelegramNewsCheckpoint() {
        return options.checkpoint === undefined ? checkpointRow() : options.checkpoint;
      },
      async saveTelegramNewsCheckpoint() {
        throw new Error("delivery must not write checkpoints");
      },
    },
    reviewDelivery: {
      async execute(input) {
        reviews.push(input as never);
        return { status: options.reviewStatus ?? "review_ready" };
      },
    },
    adminMessages: {
      async notify(input) {
        if (options.notifyFails) throw new Error("telegram unavailable");
        sent.push(input.text);
      },
    },
  });
  return { adapter, sent, reviews };
}

test("a review-ready job delivers the checkpoint's preview, not the job row's", async () => {
  const { adapter, reviews } = deliveryHarness();

  await adapter.deliver(job({ outcome_status: "review_ready", draft_id: "draft-1" }), {});

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.preview, "Preview body");
  assert.equal(reviews[0]?.draftId, "draft-1");
  assert.equal(reviews[0]?.chatId, 4242);
});

test("a checkpoint that does not match the job is refused rather than delivered", async () => {
  for (const checkpoint of [
    null,
    checkpointRow({ status: "no_candidates" }),
    checkpointRow({ draft_id: "other-draft" }),
    checkpointRow({ preview: "" }),
    // The case legacy's `!==` missed: two nulls compare equal, so a
    // review_ready checkpoint with no draft would have been delivered as a
    // review card with live Publish and Reject buttons and nothing behind them.
    checkpointRow({ draft_id: null }),
  ]) {
    const { adapter, reviews } = deliveryHarness({ checkpoint });
    await assert.rejects(
      adapter.deliver(job({ outcome_status: "review_ready", draft_id: null }), {}),
      /review checkpoint is invalid/,
    );
    assert.equal(reviews.length, 0);
  }
});

test("an already-resolved review tells the operator instead of failing silently", async () => {
  const { adapter, sent } = deliveryHarness({ reviewStatus: "review_unavailable" });

  await adapter.deliver(job({ outcome_status: "review_ready", draft_id: "draft-1" }), {});

  assert.deepEqual(sent, [
    "This draft's review was already completed or is no longer actionable.",
  ]);
});

test("each terminal outcome renders the operator sentence legacy sends", async () => {
  const cases: Array<[Partial<TelegramNewsJobClaimRow>, string]> = [
    [
      { outcome_status: "no_candidates" },
      "No suitable recent news was found. Nothing was drafted or published.",
    ],
    [
      { outcome_status: "published", publication_message_id: 99 },
      "Published automatically as Telegram message 99.",
    ],
    [{ outcome_status: "published" }, "Published automatically."],
    [
      { outcome_status: "blocked_by_policy" },
      "Publication was blocked by the current excluded-topic policy. Nothing was sent to the news channel.",
    ],
    [
      { outcome_status: "failed", error_code: "publication_unresolved" },
      "The news request stopped because publication status is unresolved. Reconcile the draft before starting /news again.",
    ],
    [
      { outcome_status: "failed", error_code: "news_job_failed" },
      "The news request could not be completed after its retry budget. Check draft and publication status before starting /news again.",
    ],
  ];

  for (const [overrides, expected] of cases) {
    const { adapter, sent } = deliveryHarness();
    await adapter.deliver(job(overrides), {});
    assert.deepEqual(sent, [expected]);
  }
});

test("an unreportable outcome fails rather than completing the job silently", async () => {
  const { adapter } = deliveryHarness();

  await assert.rejects(
    adapter.deliver(job({ outcome_status: "already_running" }), {}),
    /outcome is invalid/,
  );
});

test("a failed admin message propagates, so the delivery phase retries it", async () => {
  const { adapter } = deliveryHarness({ notifyFails: true });

  // Swallowing this would complete the job with the operator never told, and
  // the channel's next /news would be the only sign anything happened.
  await assert.rejects(
    adapter.deliver(job({ outcome_status: "no_candidates" }), {}),
    /telegram unavailable/,
  );
});
