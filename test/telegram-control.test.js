import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyControlUpdate,
  createReviewCallback,
  deliverReviewDraft,
  editorialReviewComparison,
  handleControlUpdate,
  parseNewsCommand,
  parseStatsCommand,
  parseReviewCallback,
} from "../src/telegram-control.js";
import { createLabsCallback } from "../src/telegram-labs.js";
import { publishApprovedDraft } from "../src/publish.js";
import { TelegramError } from "../src/telegram.js";

const SESSION_ID = "a".repeat(48);

function fixture(overrides = {}) {
  const calls = [];
  const repository = {
    async claimTelegramUpdate() {
      return {
        claimed: true,
        claim_token: "claim-1",
        claim_status: "claimed",
      };
    },
    async finishTelegramUpdate(...args) {
      calls.push(["finishUpdate", ...args]);
      return true;
    },
    async createTelegramReviewSession(value) {
      calls.push(["session", value]);
      return value;
    },
    async decideTelegramReviewSession() {
      return {
        draft_id: "draft-1",
        decision: "publish",
        decision_won: true,
      };
    },
    async findPublicationByDraft() {
      return null;
    },
    async enqueueNotionAuditFinalization() {},
    ...overrides.repository,
  };
  const telegram = async (_token, method, body) => {
    calls.push([method, body]);
    if (method === "getChatMember") {
      return { status: "administrator" };
    }
    if (method === "sendMessage") {
      return { message_id: 77 };
    }
    return true;
  };
  const auditLogger = {
    async start() {
      return {
        pageId: "audit-1",
        pageUrl: "https://notion.test/audit-1",
        startedAt: new Date("2026-06-27T12:00:00Z"),
      };
    },
    async finish() {},
  };
  return {
    calls,
    dependencies: {
      botUsername: "mhonest_bot",
      token: "token",
      channelId: "@channel",
      repository,
      auditLogger,
      callTelegram: overrides.callTelegram ?? telegram,
      runNews: async () => ({ draftId: "draft-1", preview: "Preview" }),
      newSessionId: () => SESSION_ID,
      now: () => new Date("2026-06-27T12:00:00Z"),
      publishDraft: async () => ({
        publication: { telegram_message_id: 42 },
      }),
      ...overrides.dependencies,
    },
  };
}

function commandUpdate(overrides = {}) {
  return {
    update_id: 10,
    message: {
      text: "/news",
      from: { id: 5 },
      chat: { id: 9, type: "private" },
      ...overrides,
    },
  };
}

function callbackUpdate(data = createReviewCallback("publish", SESSION_ID)) {
  return {
    update_id: 11,
    callback_query: {
      id: "callback-1",
      data,
      from: { id: 5 },
      message: { message_id: 77, chat: { id: 9, type: "private" } },
    },
  };
}

test("command and opaque callbacks are strictly parsed and bounded", () => {
  assert.deepEqual(parseNewsCommand("/news@mhonest_bot"), {
    botUsername: "mhonest_bot",
    malformed: false,
  });
  assert.equal(parseNewsCommand("hello"), null);
  assert.equal(parseNewsCommand("/newsletter"), null);
  assert.equal(parseNewsCommand("/news extra").malformed, true);
  assert.deepEqual(parseStatsCommand("/stats@mhonest_bot"), {
    botUsername: "mhonest_bot",
    malformed: false,
  });
  assert.equal(parseStatsCommand("/stats today").malformed, true);
  const callback = createReviewCallback("publish", SESSION_ID);
  assert.ok(Buffer.byteLength(callback) <= 64);
  assert.deepEqual(parseReviewCallback(callback), {
    action: "publish",
    sessionId: SESSION_ID,
  });
  assert.equal(parseReviewCallback("news:p:draft-id"), null);
  assert.equal(
    classifyControlUpdate(commandUpdate({ text: "/news@other_bot" }), "mhonest_bot"),
    null,
  );
});

test("/stats is private, admin-only, and does not start research", async () => {
  let ran = false;
  const { calls, dependencies } = fixture({
    repository: {
      async getDailyUsageDashboard() {
        return {
          summary: {
            request_count: "1",
            input_tokens: "100",
            cached_input_tokens: "0",
            output_tokens: "20",
            reasoning_tokens: "5",
            web_search_calls: "1",
            priced_request_count: "1",
            estimated_cost_usd: "0.01055000",
          },
          posts: [],
        };
      },
    },
    dependencies: {
      runNews: async () => {
        ran = true;
      },
    },
  });
  const result = await handleControlUpdate(
    commandUpdate({ text: "/stats" }),
    dependencies,
  );

  assert.equal(result.handled, true);
  assert.equal(ran, false);
  assert.match(
    calls.find(
      ([name, body]) => name === "sendMessage" && /AI usage today/.test(body.text),
    )[1].text,
    /Estimated list cost/,
  );
});

test("/labs is claimed, audited, private-admin routed, and does not start research", async () => {
  let ran = false;
  let claimedKind;
  const { calls, dependencies } = fixture({
    repository: {
      async claimTelegramUpdate(_updateId, updateKind) {
        claimedKind = updateKind;
        return {
          claimed: true,
          claim_token: "claim-labs",
          claim_status: "claimed",
        };
      },
      async getNewsSettings() {
        return null;
      },
      async getOrCreateNewsSettings(payload) {
        calls.push(["getOrCreateSettings", payload]);
        return { telegram_channel_id: payload.channelId };
      },
      async getOrCreateNewsFeatureFlags(payload) {
        calls.push(["getOrCreateFlags", payload]);
        return [
          {
            telegram_channel_id: "@channel",
            feature_key: "article_tags",
            state: "off",
            config: {},
            version: 1,
            updated_by: payload.updatedBy,
          },
          {
            telegram_channel_id: "@channel",
            feature_key: "editorial_enrichment",
            state: "off",
            config: {},
            version: 1,
            updated_by: payload.updatedBy,
          },
        ];
      },
    },
    dependencies: {
      runNews: async () => {
        ran = true;
      },
    },
  });

  const result = await handleControlUpdate(
    commandUpdate({ text: "/labs@mhonest_bot" }),
    dependencies,
  );

  assert.equal(result.handled, true);
  assert.equal(claimedKind, "labs_command");
  assert.equal(ran, false);
  assert.deepEqual(calls.find(([name]) => name === "getOrCreateFlags")[1], {
    channelId: "@channel",
    updatedBy: 5,
  });
  assert.match(
    calls.find(
      ([name, body]) => name === "sendMessage" && /Experimental Labs/.test(body.text),
    )[1].text,
    /Article tags: Off/,
  );
  assert.match(
    calls.find(
      ([name, body]) => name === "sendMessage" && /Experimental Labs/.test(body.text),
    )[1].text,
    /Editorial enrichment: Off/,
  );
});

test("/labs command and callbacks reject non-private or non-admin actors", async () => {
  for (const update of [
    commandUpdate({ text: "/labs", chat: { id: 9, type: "group" } }),
    commandUpdate({ text: "/labs extra" }),
  ]) {
    const { dependencies } = fixture();
    await assert.rejects(handleControlUpdate(update, dependencies));
  }

  let mutated = false;
  const { dependencies } = fixture({
    repository: {
      async getNewsFeatureFlags() {
        throw new Error("must not read flags before authorization");
      },
      async updateNewsFeatureFlag() {
        mutated = true;
      },
    },
    callTelegram: async (_token, method) => {
      if (method === "getChatMember") return { status: "member" };
      return true;
    },
  });
  await assert.rejects(
    handleControlUpdate(
      callbackUpdate(createLabsCallback("state", "enabled", 1)),
      dependencies,
    ),
    (error) => error.code === "forbidden",
  );
  assert.equal(mutated, false);
});

test("Labs callback is claimed and routes the authorized versioned mutation", async () => {
  let claimedKind;
  let updatedPayload;
  const current = {
    telegram_channel_id: "@channel",
    feature_key: "article_tags",
    state: "off",
    config: {},
    version: 4,
    updated_by: 5,
  };
  const { dependencies } = fixture({
    repository: {
      async claimTelegramUpdate(_updateId, updateKind) {
        claimedKind = updateKind;
        return {
          claimed: true,
          claim_token: "claim-labs-callback",
          claim_status: "claimed",
        };
      },
      async getNewsFeatureFlags() {
        return [current];
      },
      async updateNewsFeatureFlag(payload) {
        updatedPayload = payload;
        return { ...current, state: payload.state, version: 5 };
      },
    },
  });

  const result = await handleControlUpdate(
    callbackUpdate(createLabsCallback("state", "collect", 4)),
    dependencies,
  );

  assert.equal(result.handled, true);
  assert.equal(claimedKind, "labs_callback");
  assert.deepEqual(updatedPayload, {
    channelId: "@channel",
    featureKey: "article_tags",
    state: "collect",
    updatedBy: 5,
    expectedVersion: 4,
  });
});

test("/news requires private admin and persists a bound 24h session", async () => {
  const { calls, dependencies } = fixture();
  const result = await handleControlUpdate(commandUpdate(), dependencies);

  assert.equal(result.handled, true);
  const session = calls.find(([name]) => name === "session")[1];
  assert.equal(session.control_chat_id, 9);
  assert.equal(session.telegram_channel_id, "@channel");
  assert.equal(session.preview_message_id, 77);
  assert.equal(session.draft_id, "draft-1");
  assert.equal(session.expires_at, "2026-06-28T12:00:00.000Z");
  const previewCall = calls.find(
    ([name, body]) => name === "sendMessage" && body.text === "Preview",
  );
  const keyboard = previewCall[1].reply_markup.inline_keyboard;
  assert.match(keyboard[0][0].callback_data, /^news:p:[a-f0-9]+$/);
});

test("durable /news enqueues under the update claim before acknowledging and never runs synchronously", async () => {
  const calls = [];
  let ran = false;
  const { dependencies } = fixture({
    repository: {
      async getOrCreateNewsSettings(input) {
        calls.push(["settings", input]);
        return {
          telegram_channel_id: input.channelId,
          review_chat_id: input.reviewChatId,
          updated_by: input.updatedBy,
          language_code: "en",
          topic_codes: ["world"],
          custom_topics: [],
          excluded_topic_codes: [],
          approval_policy: "manual",
          schedule_interval_minutes: null,
          quiet_hours_enabled: true,
          version: 7,
        };
      },
      async enqueueTelegramNewsJob(input) {
        calls.push(["enqueue", input]);
        return { enqueue_outcome: "queued", id: "job-1" };
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      if (method === "getChatMember") return { status: "administrator" };
      return { message_id: 77 };
    },
    dependencies: {
      durableNewsJobsEnabled: true,
      runNews: async () => {
        ran = true;
      },
    },
  });

  const result = await handleControlUpdate(commandUpdate(), dependencies);

  assert.equal(result.handled, true);
  assert.equal(result.jobStatus, "queued");
  assert.equal(ran, false);
  const enqueue = calls.find(([name]) => name === "enqueue")[1];
  assert.equal(enqueue.updateId, 10);
  assert.equal(enqueue.updateClaimToken, "claim-1");
  assert.equal(enqueue.channelId, "@channel");
  assert.equal(enqueue.controlChatId, 9);
  assert.equal(enqueue.requestedBy, 5);
  assert.equal(enqueue.settingsSnapshot.version, 7);
  const enqueueIndex = calls.findIndex(([name]) => name === "enqueue");
  const ackIndex = calls.findIndex(
    ([name, body]) => name === "sendMessage" && /queued/i.test(body.text),
  );
  assert.ok(enqueueIndex >= 0 && ackIndex > enqueueIndex);
});

test("a second durable /news request reports the existing job without starting research", async () => {
  let ran = false;
  const { calls, dependencies } = fixture({
    repository: {
      async getOrCreateNewsSettings(input) {
        return {
          telegram_channel_id: input.channelId,
          review_chat_id: input.reviewChatId,
          updated_by: input.updatedBy,
          language_code: "en",
          topic_codes: ["world"],
          custom_topics: [],
          excluded_topic_codes: [],
          approval_policy: "manual",
          schedule_interval_minutes: null,
          quiet_hours_enabled: true,
          version: 7,
        };
      },
      async enqueueTelegramNewsJob() {
        return { enqueue_outcome: "already_running", id: "request-2" };
      },
    },
    dependencies: {
      durableNewsJobsEnabled: true,
      runNews: async () => {
        ran = true;
      },
    },
  });

  const result = await handleControlUpdate(commandUpdate(), dependencies);

  assert.equal(result.jobStatus, "already_running");
  assert.equal(ran, false);
  assert.ok(
    calls.some(
      ([name, body]) =>
        name === "sendMessage" && /already queued or running/i.test(body.text),
    ),
  );
});

test("durable /news leaves /stats responsive while the queued workflow has not started", async () => {
  let ran = false;
  const { calls, dependencies } = fixture({
    repository: {
      async getOrCreateNewsSettings(input) {
        return {
          telegram_channel_id: input.channelId,
          review_chat_id: input.reviewChatId,
          updated_by: input.updatedBy,
          language_code: "en",
          topic_codes: ["world"],
          custom_topics: [],
          excluded_topic_codes: [],
          approval_policy: "manual",
          schedule_interval_minutes: null,
          quiet_hours_enabled: true,
          version: 7,
        };
      },
      async enqueueTelegramNewsJob() {
        return { enqueue_outcome: "queued", id: "job-1" };
      },
      async getDailyUsageDashboard() {
        return {
          summary: {
            request_count: "0",
            input_tokens: "0",
            cached_input_tokens: "0",
            output_tokens: "0",
            reasoning_tokens: "0",
            web_search_calls: "0",
            priced_request_count: "0",
            estimated_cost_usd: "0",
          },
          posts: [],
        };
      },
    },
    dependencies: {
      durableNewsJobsEnabled: true,
      runNews: async () => {
        ran = true;
        await new Promise(() => {});
      },
    },
  });

  await handleControlUpdate(commandUpdate(), dependencies);
  await handleControlUpdate(
    { ...commandUpdate({ text: "/stats" }), update_id: 12 },
    dependencies,
  );

  assert.equal(ran, false);
  assert.ok(
    calls.some(
      ([name, body]) =>
        name === "sendMessage" && /AI usage today/.test(body.text),
    ),
  );
});

test("/news denial performs no pipeline mutation", async () => {
  let ran = false;
  const { calls, dependencies } = fixture({
    callTelegram: async (_token, method) => {
      if (method === "getChatMember") {
        return { status: "member" };
      }
      return true;
    },
    dependencies: {
      runNews: async () => {
        ran = true;
      },
    },
  });
  await assert.rejects(
    handleControlUpdate(commandUpdate(), dependencies),
    (error) => error.code === "forbidden",
  );
  assert.equal(ran, false);
  assert.equal(
    calls.find(([name]) => name === "finishUpdate")[3],
    "completed",
  );
});

test("/news completes cleanly when research finds no verified candidates", async () => {
  const calls = [];
  const repository = {
    async claimTelegramUpdate() {
      return { claimed: true, claim_token: "claim" };
    },
    async finishTelegramUpdate(_updateId, _claimToken, status) {
      calls.push(["finish", status]);
      return true;
    },
  };
  const auditLogger = {
    async start() {
      return {
        pageId: "run",
        pageUrl: "https://notion.test/run",
        startedAt: new Date(),
      };
    },
    async finish(_run, result) {
      calls.push(["audit", result.status]);
    },
  };
  const callTelegram = async (_token, method, body) => {
    calls.push([method, body]);
    if (method === "getChatMember") {
      return { status: "administrator" };
    }
    return { message_id: 10 };
  };

  const result = await handleControlUpdate(
    {
      update_id: 99,
      message: {
        text: "/news",
        from: { id: 7 },
        chat: { id: 8, type: "private" },
      },
    },
    {
      botUsername: "bot",
      token: "token",
      channelId: "@channel",
      repository,
      auditLogger,
      callTelegram,
      runNews: async () => ({ status: "no_candidates" }),
    },
  );

  assert.equal(result.handled, true);
  assert.ok(
    calls.some(
      ([method, body]) =>
        method === "sendMessage" && /No suitable recent news/.test(body.text),
    ),
  );
  assert.ok(calls.some(([name, status]) => name === "finish" && status === "completed"));
  assert.ok(calls.some(([name, status]) => name === "audit" && status === "Succeeded"));
});

test("/news confirms automatic publication without creating a review session", async () => {
  const { calls, dependencies } = fixture({
    dependencies: {
      runNews: async () => ({
        status: "published",
        draftId: "draft-automatic",
        publication: { telegram_message_id: 501 },
      }),
    },
  });

  const result = await handleControlUpdate(commandUpdate(), dependencies);

  assert.equal(result.draftId, "draft-automatic");
  assert.equal(calls.some(([name]) => name === "session"), false);
  assert.ok(
    calls.some(
      ([name, body]) =>
        name === "sendMessage" && /Published automatically.*501/.test(body.text),
    ),
  );
});

test("/news treats fresh and resumed policy blocks as terminal without creating review controls", async (t) => {
  for (const resumed of [false, true]) {
    await t.test(resumed ? "resumed" : "fresh", async () => {
      const { calls, dependencies } = fixture({
        dependencies: {
          runNews: async () => ({
            status: "blocked_by_policy",
            draftId: "draft-blocked",
            preview: "Must not become reviewable",
            publication: null,
            resumed,
          }),
        },
      });

      const result = await handleControlUpdate(commandUpdate(), dependencies);

      assert.equal(result.draftId, "draft-blocked");
      assert.equal(calls.some(([name]) => name === "session"), false);
      assert.ok(
        calls.some(
          ([name, body]) =>
            name === "sendMessage" &&
            /blocked by the current excluded-topic policy/i.test(body.text),
        ),
      );
      assert.match(result.auditResult, /no publication was sent/i);
    });
  }
});

test("manual review shows the alternate editorial version before approval controls", async () => {
  const calls = [];
  const baseline = "Baseline grounded draft.";
  const enriched = "Enriched memorable draft.";
  const draft = {
    id: "draft-compare",
    body: enriched,
    reviewer_notes: JSON.stringify({
      editorial_enrichment: {
        status: "completed",
        selected_version: "enriched",
        baseline_draft: { telegramText: baseline },
        enriched_draft: { telegramText: enriched },
        quality: {
          reader_angle: "Show why the practical result matters now.",
          final_similarity: 0.31,
          retry_attempted: true,
          retry_status: "selected",
          word_count: 112,
          target_min_words: 90,
          target_max_words: 140,
        },
      },
    }),
  };
  assert.deepEqual(editorialReviewComparison(draft), {
    alternateLabel: "Grounded baseline (for comparison)",
    alternateBody: baseline,
    selectedLabel: "Enriched version (selected for approval)",
    qualitySummary:
      "Reader angle: Show why the practical result matters now.\nLexical similarity to baseline: 31%; rewrite selected\nEditorial length: 112 words (target 90–140)",
  });

  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 9,
    requestedBy: 5,
    draftId: draft.id,
    preview: enriched,
    repository: {
      async getDraft() {
        return draft;
      },
      async findTelegramReviewSessionByDraft() {
        return null;
      },
      async createTelegramReviewSession(input) {
        calls.push(["session", input]);
        return input;
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return { message_id: calls.length + 40 };
    },
    newSessionId: () => SESSION_ID,
    now: () => new Date("2026-06-27T12:00:00Z"),
  });

  const messages = calls.filter(([name]) => name === "sendMessage");
  assert.equal(messages.length, 2);
  assert.match(messages[0][1].text, /Grounded baseline/);
  assert.match(messages[0][1].text, /Baseline grounded draft/);
  assert.match(messages[0][1].text, /Lexical similarity to baseline: 31%/);
  assert.match(messages[0][1].text, /Editorial length: 112 words/);
  assert.equal(messages[0][1].reply_markup, undefined);
  assert.equal(messages[1][1].text, enriched);
  assert.ok(messages[1][1].reply_markup.inline_keyboard.length);
  assert.equal(result.previewMessageId, 42);
});

test("deliverReviewDraft creates a bound reusable manual-review session", async () => {
  const calls = [];
  const repository = {
    async createTelegramReviewSession(value) {
      calls.push(["session", value]);
    },
  };
  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 99,
    requestedBy: 7,
    repository,
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return method === "sendMessage" ? { message_id: 123 } : true;
    },
    draftId: "draft-scheduled",
    preview: "Scheduled preview",
    now: () => new Date("2026-08-07T08:00:00Z"),
    newSessionId: () => SESSION_ID,
  });

  assert.deepEqual(result, {
    draftId: "draft-scheduled",
    previewMessageId: 123,
    sessionId: SESSION_ID,
  });
  assert.deepEqual(calls.find(([name]) => name === "session")[1], {
    id: SESSION_ID,
    draft_id: "draft-scheduled",
    telegram_channel_id: "@channel",
    control_chat_id: 99,
    preview_message_id: 123,
    requested_by: 7,
    expires_at: "2026-08-08T08:00:00.000Z",
  });
  assert.equal(calls.some(([name]) => name === "editMessageReplyMarkup"), false);
  assert.match(
    calls.find(([name]) => name === "sendMessage")[1].reply_markup
      .inline_keyboard[0][0].callback_data,
    /^news:p:/,
  );
});

test("deliverReviewDraft resumes a committed session after an ambiguous database response", async () => {
  const calls = [];
  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 99,
    requestedBy: 7,
    repository: {
      async findTelegramReviewSessionByDraft() {
        return {
          id: SESSION_ID,
          control_chat_id: 99,
          preview_message_id: 123,
          decision: null,
          expires_at: "2026-08-09T08:00:00.000Z",
        };
      },
      async createTelegramReviewSession() {
        throw new Error("must not create a duplicate session");
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return true;
    },
    draftId: "draft-scheduled",
    preview: "Scheduled preview",
    now: () => new Date("2026-08-08T08:00:00Z"),
  });

  assert.equal(result.resumed, true);
  assert.equal(result.sessionId, SESSION_ID);
  assert.deepEqual(calls.map(([method]) => method), ["editMessageReplyMarkup"]);
});

test("deliverReviewDraft renews an expired undecided session", async () => {
  const calls = [];
  const expired = {
    id: SESSION_ID,
    control_chat_id: 99,
    preview_message_id: 123,
    decision: null,
    expires_at: "2026-08-06T08:00:00.000Z",
  };
  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 99,
    requestedBy: 7,
    repository: {
      async findTelegramReviewSessionByDraft() {
        return expired;
      },
      async renewTelegramReviewSession(input) {
        calls.push(["renew", input]);
        return { ...expired, expires_at: input.expiresAt };
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return true;
    },
    draftId: "draft-scheduled",
    preview: "Scheduled preview",
    now: () => new Date("2026-08-07T08:00:00Z"),
  });

  assert.equal(result.resumed, true);
  assert.equal(result.unavailable, undefined);
  assert.equal(calls[0][0], "editMessageReplyMarkup");
  assert.equal(calls[1][0], "renew");
  assert.equal(calls[1][1].expiresAt, "2026-08-08T08:00:00.000Z");
});

test("deliverReviewDraft rebinds a session when its preview was deleted", async () => {
  const calls = [];
  const existing = {
    id: SESSION_ID,
    control_chat_id: 99,
    preview_message_id: 123,
    decision: null,
    expires_at: "2026-08-09T08:00:00.000Z",
  };
  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 99,
    requestedBy: 7,
    repository: {
      async findTelegramReviewSessionByDraft() {
        return existing;
      },
      async rebindTelegramReviewSession(input) {
        calls.push(["rebind", input]);
        return { ...existing, preview_message_id: input.previewMessageId };
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      if (method === "editMessageReplyMarkup") {
        throw new Error("message not found");
      }
      return { message_id: 456 };
    },
    draftId: "draft-scheduled",
    preview: "Scheduled preview",
    now: () => new Date("2026-08-07T08:00:00Z"),
  });

  assert.equal(result.rebound, true);
  assert.equal(result.previewMessageId, 456);
  assert.deepEqual(calls.map(([name]) => name), [
    "editMessageReplyMarkup",
    "sendMessage",
    "rebind",
  ]);
  assert.deepEqual(calls[2][1], {
    draftId: "draft-scheduled",
    controlChatId: 99,
    expectedPreviewMessageId: 123,
    previewMessageId: 456,
    expiresAt: "2026-08-08T08:00:00.000Z",
  });
});

test("deliverReviewDraft does not reattach buttons to a decided session", async () => {
  const calls = [];
  const result = await deliverReviewDraft({
    token: "token",
    channelId: "@channel",
    chatId: 99,
    requestedBy: 7,
    repository: {
      async findTelegramReviewSessionByDraft() {
        return {
          id: SESSION_ID,
          control_chat_id: 99,
          preview_message_id: 123,
          decision: "reject",
          expires_at: "2026-08-09T08:00:00.000Z",
        };
      },
    },
    callTelegram: async (_token, method) => {
      calls.push(method);
      return true;
    },
    draftId: "draft-scheduled",
    preview: "Scheduled preview",
    now: () => new Date("2026-08-07T08:00:00Z"),
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.decision, "reject");
  assert.deepEqual(calls, []);
});

test("an expired callback answer cannot block idempotent publication resume", async () => {
  let published = false;
  const { dependencies } = fixture({
    repository: {
      async decideTelegramReviewSession() {
        return {
          draft_id: "draft-1",
          decision: "publish",
          decision_won: false,
        };
      },
    },
    callTelegram: async (_token, method) => {
      if (method === "getChatMember") return { status: "administrator" };
      if (method === "answerCallbackQuery") throw new Error("query is too old");
      return { message_id: 77 };
    },
    dependencies: {
      async publishDraft() {
        published = true;
        return { publication: { telegram_message_id: 42 } };
      },
    },
  });

  await handleControlUpdate(callbackUpdate(), dependencies);
  assert.equal(published, true);
});

test("/news rejects group chat and malformed or missing sender", async () => {
  for (const update of [
    commandUpdate({ chat: { id: 9, type: "group" } }),
    commandUpdate({ text: "/news extra" }),
    commandUpdate({ from: undefined }),
  ]) {
    const { dependencies } = fixture();
    await assert.rejects(handleControlUpdate(update, dependencies));
  }
});

test("callback reauthorizes and passes chat/message binding to atomic decision", async () => {
  let decisionInput;
  let adminChecks = 0;
  const { dependencies } = fixture({
    repository: {
      async decideTelegramReviewSession(input) {
        decisionInput = input;
        return {
          draft_id: "draft-1",
          decision: "reject",
          decision_won: true,
        };
      },
    },
    callTelegram: async (_token, method) => {
      if (method === "getChatMember") {
        adminChecks += 1;
        return { status: "creator" };
      }
      return true;
    },
  });
  await handleControlUpdate(
    callbackUpdate(createReviewCallback("reject", SESSION_ID)),
    dependencies,
  );

  assert.equal(adminChecks, 1);
  assert.deepEqual(decisionInput, {
    sessionId: SESSION_ID,
    action: "reject",
    chatId: 9,
    messageId: 77,
    actorId: 5,
  });
});

test("duplicate publish with a receipt resumes through the idempotent publisher", async () => {
  let published = false;
  const { calls, dependencies } = fixture({
    repository: {
      async decideTelegramReviewSession() {
        return {
          draft_id: "draft-1",
          decision: "publish",
          decision_won: false,
        };
      },
      async findPublicationByDraft() {
        return { telegram_message_id: 88 };
      },
    },
    dependencies: {
      publishDraft: async () => {
        published = true;
        return {
          publication: { telegram_message_id: 88 },
          alreadyPublished: true,
        };
      },
    },
  });
  await handleControlUpdate(callbackUpdate(), dependencies);

  assert.equal(published, true);
  assert.match(
    calls.find(([name]) => name === "answerCallbackQuery")[1].text,
    /Resuming/,
  );
  assert.match(calls.find(([name, body]) =>
    name === "sendMessage" && /Published/.test(body.text),
  )[1].text, /88/);
});

test("duplicate publish without a receipt calls the idempotent publisher", async () => {
  let published = 0;
  const { dependencies } = fixture({
    repository: {
      async decideTelegramReviewSession() {
        return {
          draft_id: "draft-1",
          decision: "publish",
          decision_won: false,
        };
      },
      async findPublicationByDraft() {
        return null;
      },
    },
    dependencies: {
      publishDraft: async () => {
        published += 1;
        return { publication: { telegram_message_id: 89 } };
      },
    },
  });

  await handleControlUpdate(callbackUpdate(), dependencies);
  assert.equal(published, 1);
});

function publicationStateFixture({ ambiguous = false } = {}) {
  let updateStatus;
  let draftStatus = "review";
  let publication = null;
  let sends = 0;
  const base = fixture({
    repository: {
      async claimTelegramUpdate() {
        if (updateStatus === "completed") {
          return { claimed: false, claim_token: null, claim_status: "terminal" };
        }
        updateStatus = "processing";
        return {
          claimed: true,
          claim_token: `claim-${sends + 1}`,
          claim_status: "claimed",
        };
      },
      async finishTelegramUpdate(_id, _token, status) {
        updateStatus = status;
        return true;
      },
      async decideTelegramReviewSession() {
        if (draftStatus === "review") {
          draftStatus = "approved";
          return {
            draft_id: "draft-1",
            decision: "publish",
            decision_won: true,
          };
        }
        return {
          draft_id: "draft-1",
          decision: "publish",
          decision_won: false,
        };
      },
      async findPublicationByDraft() {
        return publication;
      },
      async findPublicationPolicyBlockByDraft() {
        return null;
      },
      async getDraft() {
        return {
          id: "draft-1",
          article_id: "article-1",
          body: "Approved article",
          status: draftStatus,
          reviewer_notes: null,
          articles: { id: "article-1", title: "Article" },
        };
      },
      async getNewsSettings() {
        return { version: 1, excluded_topic_codes: [] };
      },
      async claimDraftForPublication() {
        if (draftStatus !== "approved") {
          throw new Error("Draft is not approved or is already being published");
        }
        draftStatus = "publishing";
        return { id: "draft-1", body: "Approved article" };
      },
      async claimDraftForPublicationWithPolicy() {
        return {
          outcome: "claimed",
          draft: await this.claimDraftForPublication(),
        };
      },
      async releaseRejectedDraftPublication() {
        assert.equal(draftStatus, "publishing");
        draftStatus = "approved";
        return { id: "draft-1", status: draftStatus };
      },
      async finalizeDraftPublication({ messageId }) {
        assert.equal(draftStatus, "publishing");
        draftStatus = "published";
        publication = { telegram_message_id: messageId };
        return publication;
      },
    },
  });
  base.dependencies.publishDraft = (options) =>
    publishApprovedDraft({
      ...options,
      sendMessage: async () => {
        sends += 1;
        if (sends === 1) {
          if (ambiguous) {
            throw new Error("connection reset");
          }
          throw new TelegramError("sendMessage", 400, 400, "message rejected");
        }
        return { message_id: 90 };
      },
    });
  return {
    ...base,
    state: () => ({ updateStatus, draftStatus, publication, sends }),
  };
}

test("failed callback redelivery retries a definitive rejection through the real publisher", async () => {
  const flow = publicationStateFixture();
  await assert.rejects(
    handleControlUpdate(callbackUpdate(), flow.dependencies),
    /released for retry/,
  );
  assert.deepEqual(flow.state(), {
    updateStatus: "failed",
    draftStatus: "approved",
    publication: null,
    sends: 1,
  });

  const result = await handleControlUpdate(callbackUpdate(), flow.dependencies);
  assert.equal(result.handled, true);
  assert.deepEqual(flow.state(), {
    updateStatus: "completed",
    draftStatus: "published",
    publication: { telegram_message_id: 90 },
    sends: 2,
  });
});

test("ambiguous send remains publishing and callback redelivery never resends", async () => {
  const flow = publicationStateFixture({ ambiguous: true });
  await assert.rejects(
    handleControlUpdate(callbackUpdate(), flow.dependencies),
    /manual reconciliation/,
  );
  assert.deepEqual(flow.state(), {
    updateStatus: "completed",
    draftStatus: "publishing",
    publication: null,
    sends: 1,
  });

  const duplicate = await handleControlUpdate(
    callbackUpdate(),
    flow.dependencies,
  );
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(flow.state(), {
    updateStatus: "completed",
    draftStatus: "publishing",
    publication: null,
    sends: 1,
  });
});

test("deduplicated update performs no command or callback mutation", async () => {
  let ran = false;
  const { dependencies } = fixture({
    repository: {
      async claimTelegramUpdate() {
        return { claimed: false, claim_token: null, claim_status: "terminal" };
      },
    },
    dependencies: {
      runNews: async () => {
        ran = true;
      },
    },
  });
  const result = await handleControlUpdate(commandUpdate(), dependencies);
  assert.equal(result.duplicate, true);
  assert.equal(ran, false);
});

test("audit start failure is fail-closed before update claim", async () => {
  let claimed = false;
  const { dependencies } = fixture({
    repository: {
      async claimTelegramUpdate() {
        claimed = true;
      },
    },
    dependencies: {
      auditLogger: {
        async start() {
          throw new Error("Notion unavailable");
        },
      },
    },
  });
  await assert.rejects(handleControlUpdate(commandUpdate(), dependencies));
  assert.equal(claimed, false);
});

test("operation failures are audited with sanitized codes", async () => {
  let auditError;
  const { dependencies } = fixture({
    dependencies: {
      auditLogger: {
        async start() {
          return {
            pageId: "audit-1",
            pageUrl: "https://notion.test/audit-1",
            startedAt: new Date(),
          };
        },
        async finish(_run, details) {
          auditError = details.error;
        },
      },
      runNews: async () => {
        throw new Error("provider leaked article body and token");
      },
    },
  });
  await assert.rejects(handleControlUpdate(commandUpdate(), dependencies));
  assert.equal(auditError, "internal_error");
});

test("lost update claim prevents successful acknowledgement", async () => {
  const { dependencies } = fixture({
    repository: {
      async finishTelegramUpdate() {
        return false;
      },
    },
  });
  await assert.rejects(
    handleControlUpdate(commandUpdate(), dependencies),
    (error) => error.code === "update_claim_lost",
  );
});

test("fresh processing duplicate is redelivered instead of acknowledged", async () => {
  const { dependencies } = fixture({
    repository: {
      async claimTelegramUpdate() {
        return { claimed: false, claim_token: null, claim_status: "busy" };
      },
    },
  });
  await assert.rejects(
    handleControlUpdate(commandUpdate(), dependencies),
    (error) => error.code === "update_in_progress",
  );
});
