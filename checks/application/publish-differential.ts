import assert from "node:assert/strict";
import test from "node:test";

import { publishApprovedDraft } from "../../src/publish.js";
import { TelegramError } from "../../src/telegram.js";
import { PublishApprovedDraftUseCase } from "../../src/editorial/application/publish-approved-draft.use-case.js";
import { PublicationDeliveryError } from "../../src/editorial/editorial-application.contracts.js";

/**
 * Publication, legacy against typed, on one fixture per scenario.
 *
 * `src/publish.js` and `publish-approved-draft.use-case.ts` are two independent
 * implementations -- the typed one imports nothing from the legacy module it
 * replaces. Each has thorough tests: eleven in `test/publish.test.js`, seven in
 * `checks/application/editorial-application.ts`. Neither proves they agree, and
 * they were written from different fixtures with different assertions.
 *
 * Publication is the one operation in this system that cannot be undone. A
 * divergence double-posts to real readers or loses a post, which is why
 * CLAUDE.md names it first among behaviours that must be preserved:
 * "idempotent per-draft publication (an uncertain Telegram response leaves the
 * draft in `publishing` for manual reconciliation -- never blind retry)".
 *
 * Three things are compared, not one:
 *
 *   1. the returned result,
 *   2. every Telegram call, in order -- a send that only one side makes is a
 *      double-post,
 *   3. every repository write, in order, recording key PRESENCE as well as
 *      value.
 *
 * The third is the one that earns its place. Today's migration bug was an
 * absent key against a present null: identical under `deepEqual`, and the
 * difference the SQL functions act on.
 */

const ARTICLE = Object.freeze({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Observatory narrows the Hubble constant uncertainty",
  canonical_url: "https://feed.example.test/hubble",
});

const DRAFT = Object.freeze({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  article_id: ARTICLE.id,
  body: "Observatory narrows the Hubble constant uncertainty\n\nBody.",
  status: "approved",
  model: "differential-model",
  prompt_version: "telegram-grounded-v2",
  reviewer_notes: JSON.stringify({ editor: { name: "Editor" } }),
  approved_at: "2026-09-04T10:00:00.000Z",
  created_at: "2026-09-04T09:00:00.000Z",
  updated_at: "2026-09-04T10:00:00.000Z",
});

const PUBLICATION = Object.freeze({
  id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
  draft_id: DRAFT.id,
  article_id: ARTICLE.id,
  telegram_channel_id: "@channel",
  telegram_message_id: 42,
  published_at: "2026-09-04T10:01:00.000Z",
  message_text: DRAFT.body,
  metadata: {},
  created_at: "2026-09-04T10:01:00.000Z",
});

const SETTINGS = Object.freeze({
  telegram_channel_id: "@channel",
  excluded_topic_codes: [],
  version: 3,
  language_code: "en",
  approval_policy: "manual",
});

type Scenario = {
  existingPublication?: typeof PUBLICATION | null;
  existingBlock?: Record<string, unknown> | null;
  claimOutcome?: "claimed" | "already_published" | "already_blocked" | "not_publishable";
  excludedTopicCodes?: string[];
  policyDecision?: "allow" | "block" | "uncertain";
  /** How the Telegram send behaves: accepted, definitively rejected, or ambiguous. */
  send?: "ok" | "rejected" | "ambiguous";
  /** Whether recording the publication fails AFTER Telegram accepted the message. */
  finalizeFails?: boolean;
};

/**
 * One recording backend, built fresh for each side.
 *
 * Built by a factory rather than shared between the two runs, exactly as
 * `checks/application/ai-provider-composition.ts` builds its providers twice:
 * a shared instance would let the first run's mutations reach the second and
 * quietly make the comparison meaningless.
 *
 * Writes record whether a key was PRESENT, not only its value. Absent and
 * present-and-null are indistinguishable under `deepEqual`, and that is the
 * exact distinction the create/finalize SQL functions branch on.
 */
function backend(scenario: Scenario) {
  const writes: Array<Record<string, unknown>> = [];
  const telegram: Array<Record<string, unknown>> = [];

  const record = (call: string, input: Record<string, unknown>) => {
    writes.push({
      call,
      keys: Object.keys(input).sort(),
      ...Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          value === undefined ? "(undefined)" : value === null ? "(null)" : value,
        ]),
      ),
    });
  };

  const repository = {
    async findPublicationByDraft() {
      return scenario.existingPublication ?? null;
    },
    async findPublicationPolicyBlockByDraft() {
      return scenario.existingBlock ?? null;
    },
    async getDraft() {
      return { ...DRAFT, articles: ARTICLE };
    },
    async getNewsSettings() {
      return { ...SETTINGS, excluded_topic_codes: scenario.excludedTopicCodes ?? [] };
    },
    async claimDraftForPublicationWithPolicy(input: Record<string, unknown>) {
      record("claimDraftForPublicationWithPolicy", input);
      const outcome = scenario.claimOutcome ?? "claimed";
      return {
        outcome,
        draft: outcome === "claimed" ? { ...DRAFT, status: "publishing" } : null,
      };
    },
    async blockDraftPublication(input: Record<string, unknown>) {
      record("blockDraftPublication", input);
      return {
        outcome: "blocked",
        blockId: "block-1",
        draftId: DRAFT.id,
        articleId: ARTICLE.id,
        reasonCode: String(input.reasonCode ?? "excluded_topic_uncertain"),
      };
    },
    async releaseRejectedDraftPublication(draftId: string) {
      record("releaseRejectedDraftPublication", { draftId });
      return { ...DRAFT, status: "approved" };
    },
    async finalizeDraftPublication(input: Record<string, unknown>) {
      record("finalizeDraftPublication", input);
      if (scenario.finalizeFails) throw new Error("database unavailable");
      return { ...PUBLICATION, telegram_message_id: Number(input.messageId ?? 42) };
    },
    async recordAiUsage(event: Record<string, unknown>) {
      record("recordAiUsage", { operation: event.operation ?? null });
      return { id: "usage-1" };
    },
  };

  const sendMessage = async (input: Record<string, unknown>) => {
    telegram.push({ call: "sendMessage", text: input.text, channelId: input.channelId });
    if (scenario.send === "rejected") {
      throw new TelegramError("Bad Request: chat not found", { status: 400 });
    }
    if (scenario.send === "ambiguous") throw new Error("socket hang up");
    return { message_id: 42, date: 1_757_000_000 };
  };

  return { repository, sendMessage, writes, telegram };
}

/** The excluded-topic decision, in each side's own shape, from one scenario. */
function policyDecision(scenario: Scenario) {
  const decision = scenario.policyDecision ?? "allow";
  return {
    legacyProvider: {
      names: ["openai"],
      async generateStructured() {
        return {
          value: {
            // The relation must model the SAME decision the typed policy
            // reports. Returning "main_subject" for an uncertain scenario gave
            // the two sides different inputs, and the resulting difference in
            // the recorded classification looked like a divergence in the code.
            assessments: (scenario.excludedTopicCodes ?? []).map((code) => ({
              topicCode: code,
              relation:
                decision === "allow"
                  ? "unrelated"
                  : decision === "uncertain"
                    ? "uncertain"
                    : "main_subject",
            })),
          },
          usageEvents: [],
          provider: "openai",
          model: "differential-model",
        };
      },
    },
    // Symmetry matters more than realism here. The legacy provider reports its
    // provider, model and prompt version through the structured response; the
    // typed policy reports them on the decision. A fake that gave one side
    // less information than the other would produce a difference that is the
    // fake's fault and read as a divergence in the code.
    typedPolicy: {
      async evaluate() {
        const attribution = {
          provider: "openai",
          model: "differential-model",
          promptVersion: "excluded-topics-v1",
        };
        return decision === "allow"
          ? { decision: "allow" as const }
          : decision === "block"
            ? { decision: "block" as const, reasonCode: "excluded_topic", ...attribution }
            : {
                decision: "uncertain" as const,
                reasonCode: "insufficient_evidence",
                ...attribution,
              };
      },
    },
  };
}

/** Normalises each side's thrown error into something comparable. */
async function attempt<T>(operation: () => Promise<T>) {
  try {
    return { outcome: "returned" as const, value: await operation() };
  } catch (error) {
    return { outcome: "threw" as const, message: (error as Error).message };
  }
}

async function runLegacy(scenario: Scenario) {
  const { repository, sendMessage, writes, telegram } = backend(scenario);
  const { legacyProvider } = policyDecision(scenario);
  const result = await attempt(() =>
    publishApprovedDraft({
      repository: repository as never,
      aiProvider: legacyProvider as never,
      token: "test-token",
      channelId: "@channel",
      draftId: DRAFT.id,
      publicationPath: "manual",
      sendMessage: sendMessage as never,
    } as never),
  );
  return { result, writes, telegram };
}

async function runTyped(scenario: Scenario) {
  const { repository, sendMessage, writes, telegram } = backend(scenario);
  const { typedPolicy } = policyDecision(scenario);
  const result = await attempt(() =>
    new PublishApprovedDraftUseCase(
      repository as never,
      { async getNewsSettings() { return repository.getNewsSettings(); } } as never,
      { async recordAiUsage(event: Record<string, unknown>) { return repository.recordAiUsage(event); } } as never,
      typedPolicy as never,
      {
        // The real gateway (legacy-editorial-publication.gateway.ts) converts a
        // TelegramError into PublicationDeliveryError(outcome: "rejected") and
        // lets anything else through as ambiguous. That conversion IS the
        // gateway's job, so the fake has to do it too -- otherwise the typed
        // path never learns a rejection was definitive and skips the release,
        // which looks exactly like a missing behaviour.
        //
        // `messageDate`, not `date`: EditorialPublicationReceipt names it that,
        // and passing the wrong key silently drops it from the metadata.
        async publish(input: Record<string, unknown>) {
          try {
            const sent = await sendMessage({ text: input.text, channelId: input.channelId });
            return { messageId: sent.message_id, messageDate: sent.date };
          } catch (error) {
            if (error instanceof TelegramError) {
              throw new PublicationDeliveryError(
                "Telegram rejected the publication",
                "rejected",
                { cause: error },
              );
            }
            throw error;
          }
        },
      } as never,
    ).execute({
      draftId: DRAFT.id,
      channelId: "@channel",
      publicationPath: "manual",
    } as never),
  );
  return { result, writes, telegram };
}

/**
 * How `defaultExecutionError` in src/telegram-news-jobs.js classifies a failed
 * publication. Reproduced rather than imported because it is a private
 * function, and because the point is to check the message a caller would
 * actually see rather than to share an implementation with it.
 */
function classifyFailure(message: string): string {
  if (/unresolved|already being published/i.test(message)) return "publication_unresolved(terminal)";
  if (/already running/i.test(message)) return "pipeline_busy";
  if (/rate.?limit/i.test(message)) return "rate_limited";
  return "news_job_failed";
}

/**
 * The part of an outcome that both implementations must agree on.
 *
 * Not the whole return value, and the reason is recorded here rather than
 * silently loosened: the two agree on every observable effect and differ in two
 * places on purpose.
 *
 *   1. ERROR WORDING. Legacy says "Telegram publication outcome is
 *      unresolved..."; the typed layer says "Publication outcome is
 *      unresolved...". The typed use case sits behind a publication gateway and
 *      no longer knows the transport is Telegram, which is the point of the
 *      port. What matters is that both messages classify identically for the
 *      job worker's retry decision, and that IS asserted -- a reworded message
 *      that changed the classification would turn a terminal failure into a
 *      retry, and re-run the whole publication.
 *
 *   2. BLOCKED RESULT SHAPE. Legacy returns `block` and `alreadyPublished`
 *      alongside the decision; the typed contract
 *      (`PublishApprovedDraftResult`) deliberately narrows to
 *      `{ status, reasonCode, publication, draft }`. The block itself is
 *      durable either way -- `blockDraftPublication` is called identically on
 *      both paths, which the write comparison proves -- so nothing is lost from
 *      the database. What IS lost is the detail `src/workflow.js:60` reads as
 *      `policyBlock`, and no typed caller reads it. Recorded as a known
 *      difference below rather than asserted away.
 */
function decisionOf(
  result: { outcome: "threw"; message: string } | { outcome: "returned"; value: unknown },
) {
  if (result.outcome === "threw") {
    return { outcome: "threw", classification: classifyFailure(result.message) };
  }
  const value = result.value as Record<string, unknown>;
  const publication = value.publication as { telegram_message_id?: number } | null;
  return {
    outcome: "returned",
    status: value.status ?? null,
    reasonCode: value.reasonCode ?? null,
    publicationMessageId: publication?.telegram_message_id ?? null,
  };
}

/**
 * Compares the two runs, reporting which axis diverged rather than only that
 * something did. Side effects first: those are what reach real readers and a
 * real database, and a difference there matters more than any return value.
 */
async function assertIdentical(name: string, scenario: Scenario) {
  const legacy = await runLegacy(scenario);
  const typed = await runTyped(scenario);

  assert.deepEqual(
    typed.telegram,
    legacy.telegram,
    `${name}: both paths must make the same Telegram calls — a send only one side makes is a double-post or a lost post`,
  );
  assert.deepEqual(
    typed.writes,
    legacy.writes,
    `${name}: both paths must make the same repository writes, including which keys are present`,
  );
  assert.deepEqual(
    decisionOf(typed.result),
    decisionOf(legacy.result),
    `${name}: both paths must reach the same decision, and a failure must classify the same way`,
  );
}

test("already published: neither path sends, both return the existing publication", async () => {
  // The idempotency guarantee. A divergence here posts a second copy of an
  // article that is already in the channel.
  await assertIdentical("already published", { existingPublication: PUBLICATION });
});

test("an ambiguous Telegram response leaves the draft publishing on both paths", async () => {
  // The invariant CLAUDE.md names: an uncertain response must never be retried
  // blind. Both paths must refuse to release or finalize, so the draft stays
  // in `publishing` for manual reconciliation.
  await assertIdentical("ambiguous send", { send: "ambiguous" });
});

test("a database failure after Telegram accepted the message stays unresolved on both paths", async () => {
  // The worst case in the system: the post exists in the channel and the
  // database does not know. Releasing here would publish it twice.
  await assertIdentical("finalize fails after send", { finalizeFails: true });
});

test("a definitive Telegram rejection is released for retry on both paths", async () => {
  // The mirror of the previous case, and the reason the two are distinguished
  // at all: a definitive rejection means nothing was posted, so the draft is
  // safe to release.
  await assertIdentical("definitive rejection", { send: "rejected" });
});

test("a blocked excluded-topic decision claims nothing and sends nothing on both paths", async () => {
  // The other irreversible outcome: a blocked topic reaching real readers.
  await assertIdentical("policy blocks", {
    excludedTopicCodes: ["war_conflict"],
    policyDecision: "block",
  });
});

test("an uncertain excluded-topic decision blocks rather than publishing, on both paths", async () => {
  // Fail-closed. An article that could not be checked must not be published,
  // and both paths must agree on that rather than one of them proceeding.
  await assertIdentical("policy uncertain", {
    excludedTopicCodes: ["war_conflict"],
    policyDecision: "uncertain",
  });
});

test("the two known differences are shape and wording, and neither reaches the database", async () => {
  // Recorded, not asserted away. A differential test that quietly excludes the
  // places two implementations disagree is worse than none: it reads as proof
  // of equivalence while hiding exactly what a reviewer needs to see.
  const scenario: Scenario = {
    excludedTopicCodes: ["war_conflict"],
    policyDecision: "block",
  };
  const legacy = await runLegacy(scenario);
  const typed = await runTyped(scenario);

  const legacyValue = (legacy.result as { value: Record<string, unknown> }).value;
  const typedValue = (typed.result as { value: Record<string, unknown> }).value;

  // The decision is identical.
  assert.equal(legacyValue.status, "blocked");
  assert.equal(typedValue.status, "blocked");
  assert.equal(legacyValue.reasonCode, typedValue.reasonCode);

  // The shape is not. Legacy carries the block detail src/workflow.js:60 reads
  // as `policyBlock`; the typed contract narrows it away. No typed caller reads
  // it, and the block is durable regardless -- blockDraftPublication ran
  // identically on both paths, which assertIdentical already proved.
  assert.ok("block" in legacyValue, "legacy returns the block detail");
  assert.equal("block" in typedValue, false, "the typed contract deliberately omits it");

  // And the wording. Both classify the same, which is the property the job
  // worker depends on; if that stops being true this assertion fails and the
  // retry behaviour has changed.
  const rejected = { send: "rejected" as const };
  const legacyRejected = await runLegacy(rejected);
  const typedRejected = await runTyped(rejected);
  const legacyMessage = (legacyRejected.result as { message: string }).message;
  const typedMessage = (typedRejected.result as { message: string }).message;
  assert.notEqual(legacyMessage, typedMessage, "the wording differs, by design");
  assert.equal(
    classifyFailure(legacyMessage),
    classifyFailure(typedMessage),
    "however worded, both must classify the same or the retry decision changes",
  );
});
