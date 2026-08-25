import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { TelegramControlService } from "../../src/telegram/application/telegram-control.service.js";
import type { TelegramControlRequest } from "../../src/telegram/telegram-application.contracts.js";
import { TelegramControlError } from "../../src/telegram/telegram-application.contracts.js";
import { TelegramControlApplicationModule } from "../../src/telegram/telegram-control-application.module.js";
import { TELEGRAM_CONTROL_APPLICATION } from "../../src/telegram/telegram-application.tokens.js";
import {
  TelegramBotApiGateway,
  TelegramBotApiOutcomeRenderer,
} from "../../src/telegram/transport/telegram-bot-api.gateway.js";
import {
  TelegramLegacyLabsGateway,
  TelegramLegacySettingsGateway,
  TelegramLegacyStatsGateway,
  TelegramLegacyStatusGateway,
} from "../../src/telegram/transport/telegram-legacy-feature.gateways.js";
import { TelegramControlTransportHandler } from "../../src/telegram/transport/telegram-control-transport.handler.js";
import { parseTelegramControlUpdate } from "../../src/telegram/transport/telegram-control-update.parser.js";

const IDENTITY = { botUsername: "honest_bot", botId: 77, channelId: "@channel" };

test("transport parser keeps strict command addressing, opaque feature callbacks, review bindings and settings replies outside application logic", () => {
  const news = parseTelegramControlUpdate(
    {
      update_id: 1,
      message: {
        text: "/news@honest_bot",
        from: { id: 9 },
        chat: { id: 10, type: "private" },
      },
    },
    IDENTITY,
  );
  assert.deepEqual(news, {
    updateId: 1,
    updateKind: "news_command",
    channelId: "@channel",
    actorId: 9,
    chatId: 10,
    chatType: "private",
    route: { kind: "news", malformed: false },
  });
  assert.equal(
    parseTelegramControlUpdate(
      {
        update_id: 2,
        message: {
          text: "/news@other_bot",
          from: { id: 9 },
          chat: { id: 10, type: "private" },
        },
      },
      IDENTITY,
    ),
    null,
  );

  const review = parseTelegramControlUpdate(
    {
      update_id: 3,
      callback_query: {
        id: "cb-1",
        data: `news:p:${"a".repeat(48)}`,
        from: { id: 9 },
        message: { message_id: 12, chat: { id: 10, type: "private" } },
      },
    },
    IDENTITY,
  );
  assert.deepEqual(review?.route, {
    kind: "review",
    action: "publish",
    sessionId: "a".repeat(48),
    messageId: 12,
    callbackId: "cb-1",
  });
  assert.equal(review?.updateKind, "news_callback");

  for (const [updateId, data, target] of [
    [31, "news:broken", "review"],
    [32, `cfg:${"x".repeat(70)}`, "settings"],
    [33, "lab:s:unknown", "labs"],
    [34, "status:unknown", "status"],
  ] as const) {
    const malformed = parseTelegramControlUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        data,
        from: { id: 9 },
        message: { message_id: 12, chat: { id: 10, type: "private" } },
      },
    }, IDENTITY);
    assert.deepEqual(malformed?.route, {
      kind: "malformed",
      target,
      errorCode: "malformed_callback",
    });
  }

  const labs = parseTelegramControlUpdate(
    {
      update_id: 4,
      callback_query: {
        id: "cb-2",
        data: "lab:s:edit:e:7",
        from: { id: 9 },
        message: { message_id: 13, chat: { id: 10, type: "private" } },
      },
    },
    IDENTITY,
  );
  assert.deepEqual(labs?.route, {
    kind: "labs",
    action: "callback",
    payload: {
      callbackId: "cb-2",
      messageId: 13,
      action: {
        action: "state",
        value: "enabled",
        version: 7,
        featureKey: "editorial_enrichment",
      },
    },
  });

  const status = parseTelegramControlUpdate(
    {
      update_id: 41,
      callback_query: {
        id: "cb-status",
        data: "status:test:exa",
        from: { id: 9 },
        message: { message_id: 14, chat: { id: 10, type: "private" } },
      },
    },
    IDENTITY,
  );
  assert.equal(status?.updateKind, "status_callback");
  assert.deepEqual(status?.route, {
    kind: "status",
    action: "callback",
    payload: {
      callbackId: "cb-status",
      messageId: 14,
      action: { action: "test_exa" },
    },
  });

  const input = parseTelegramControlUpdate(
    {
      update_id: 5,
      message: {
        text: "Quantum computing",
        from: { id: 9 },
        chat: { id: 10, type: "private" },
        reply_to_message: { message_id: 99, from: { id: 77, is_bot: true } },
      },
    },
    IDENTITY,
  );
  assert.equal(input?.updateKind, "settings_input");
  assert.deepEqual(input?.route, {
    kind: "settings",
    action: "input",
    payload: { text: "Quantum computing", replyToMessageId: 99 },
  });
});

test("transport handler only parses, invokes the application port, then renders its semantic outcome", async () => {
  const calls: unknown[] = [];
  const handler = new TelegramControlTransportHandler(
    {
      async handle(request, present) {
        calls.push(["application", request]);
        const outcome = { status: "no_candidates" };
        await present(outcome);
        return outcome;
      },
    },
    {
      async render(request, outcome) {
        calls.push(["renderer", request, outcome]);
      },
    },
    IDENTITY,
  );
  const result = await handler.handle({
    update_id: 6,
    message: {
      text: "/stats",
      from: { id: 9 },
      chat: { id: 10, type: "private" },
    },
  });
  assert.equal(result.handled, true);
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), [
    "application",
    "renderer",
  ]);
});

test("real handler and outcome renderer do not start a Telegram call after lease-loss cancellation", async () => {
  const controller = new AbortController();
  controller.abort("lease-lost");
  let calls = 0;
  const renderer = new TelegramBotApiOutcomeRenderer("token", async () => {
    calls += 1;
    return { message_id: 1 };
  });
  const handler = new TelegramControlTransportHandler(
    {
      async handle(_request, present) {
        const outcome = { status: "no_candidates" };
        await present(outcome);
        return outcome;
      },
    },
    renderer,
    IDENTITY,
  );

  await assert.rejects(handler.handle({
    update_id: 61,
    message: { text: "/news", from: { id: 9 }, chat: { id: 10, type: "private" } },
  }, { signal: controller.signal }));
  assert.equal(calls, 0);
});

test("real legacy feature adapter forwards cancellation into its Telegram call wrapper", async () => {
  let receivedSignal: AbortSignal | undefined;
  const gateway = new TelegramLegacySettingsGateway(
    "token", "@channel", {},
    async (_token, _method, _payload, options) => {
      receivedSignal = options?.signal;
      options?.signal?.throwIfAborted();
      return { message_id: 1 };
    },
    { show: async ({ callTelegram }) => callTelegram("token", "sendMessage", {}), callback: async () => ({ auditResult: "ok" }), input: async () => ({ auditResult: "ok" }) },
  );
  const controller = new AbortController();
  await gateway.execute({
    updateId: 62, updateKind: "settings_command", channelId: "@channel", actorId: 9,
    chatId: 10, chatType: "private", route: { kind: "settings", action: "open" },
  }, controller.signal);
  assert.strictEqual(receivedSignal, controller.signal);
  controller.abort("lease-lost");
  await assert.rejects(gateway.execute({
    updateId: 63, updateKind: "settings_command", channelId: "@channel", actorId: 9,
    chatId: 10, chatType: "private", route: { kind: "settings", action: "open" },
  }, controller.signal));
});

test("legacy feature adapters fence repository and provider calls between awaits", async () => {
  const request: TelegramControlRequest = {
    updateId: 64, updateKind: "settings_input", channelId: "@channel", actorId: 9,
    chatId: 10, chatType: "private", route: {
      kind: "settings", action: "input", payload: { text: "AI", replyToMessageId: 13 },
    },
  };
  const settingsController = new AbortController();
  const settingsCalls: string[] = [];
  const settings = new TelegramLegacySettingsGateway("token", "@channel", {
    async beginTelegramSettingsInput() { settingsCalls.push("begin"); },
    async consumeTelegramSettingsInput() {
      settingsCalls.push("consume");
      settingsController.abort("lease-lost");
      return { id: "binding" };
    },
    async updateNewsSettings() { settingsCalls.push("update"); },
  }, async () => { settingsCalls.push("telegram"); return {}; }, {
    async show() { throw new Error("unused"); },
    async callback() { throw new Error("unused"); },
    async input(_message, { repository }) {
      await (repository as { beginTelegramSettingsInput(): Promise<void> }).beginTelegramSettingsInput();
      await (repository as { consumeTelegramSettingsInput(): Promise<unknown> }).consumeTelegramSettingsInput();
      await (repository as { updateNewsSettings(): Promise<void> }).updateNewsSettings();
      return { auditResult: "ok" };
    },
  });
  await assert.rejects(settings.execute(request, settingsController.signal));
  assert.deepEqual(settingsCalls, ["begin", "consume"]);

  const statusController = new AbortController();
  const statusCalls: string[] = [];
  const status = new TelegramLegacyStatusGateway("token", "@channel", {
    async getDailyUsageDashboard() {
      statusCalls.push("dashboard");
      statusController.abort("lease-lost");
      return {};
    },
  }, async () => { statusCalls.push("telegram"); return {}; }, {
    async testExaConnection() { statusCalls.push("exa"); return {}; },
  }, ["exa"], "test", {
    async show() { throw new Error("unused"); },
    async callback(_callback, _action, { repository, aiProvider }) {
      await (repository as { getDailyUsageDashboard(): Promise<unknown> }).getDailyUsageDashboard();
      await (aiProvider as { testExaConnection(): Promise<unknown> }).testExaConnection();
      return { auditResult: "ok" };
    },
  });
  await assert.rejects(status.execute({
    ...request,
    updateKind: "status_callback",
    route: { kind: "status", action: "callback", payload: { callbackId: "cb", messageId: 12, action: {} } },
  }, statusController.signal));
  assert.deepEqual(statusCalls, ["dashboard"]);
});

test("parser and application enforce positive ids, nonblank channel, and complete callback bindings", () => {
  assert.throws(
    () => parseTelegramControlUpdate({
      update_id: 0,
      message: { text: "/news", from: { id: 9 }, chat: { id: 10, type: "private" } },
    }, IDENTITY),
    (error) => error instanceof TelegramControlError && error.code === "malformed_update",
  );
  assert.deepEqual(
    parseTelegramControlUpdate({
      update_id: 8,
      callback_query: {
        id: "",
        data: `news:p:${"a".repeat(48)}`,
        from: { id: 9 },
        message: { message_id: 12, chat: { id: 10, type: "private" } },
      },
    }, IDENTITY)?.route,
    { kind: "malformed", target: "review", errorCode: "malformed_callback" },
  );
  assert.throws(
    () => parseTelegramControlUpdate({
      update_id: 9,
      message: { text: "/news", from: { id: 9 }, chat: { id: 10, type: "private" } },
    }, { ...IDENTITY, channelId: " " }),
    (error) => error instanceof TelegramControlError && error.code === "malformed_update",
  );
});

test("Telegram Bot API gateway preserves comparison quality, actual newlines, and failure fallback without hiding controls", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const gateway = new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, payload) => {
      calls.push([method, payload]);
      if (method === "getChatMember") return { status: "administrator" };
      if (method === "sendMessage" && String(payload.text).startsWith("Grounded baseline")) {
        throw new Error("optional comparison unavailable");
      }
      return { message_id: 45 };
    },
  );
  assert.equal(await gateway.isChannelAdmin("@channel", 9), true);
  const body = "Enriched selected text";
  const sent = await gateway.sendReview({
    chatId: 10,
    sessionId: "a".repeat(48),
    preview: body,
    draft: {
      id: "draft-1",
      article_id: "article-1",
      body,
      status: "review",
      model: null,
      prompt_version: null,
      reviewer_notes: JSON.stringify({
        editorial_enrichment: {
          status: "completed",
          selected_version: "enriched",
          baseline_draft: { telegramText: "Grounded baseline text" },
          enriched_draft: { telegramText: body },
          quality: {
            reader_angle: "Why this practical result matters now.",
            final_similarity: 0.31,
            retry_attempted: true,
            retry_status: "selected",
            word_count: 112,
            target_min_words: 90,
            target_max_words: 140,
          },
        },
      }),
      approved_at: null,
      created_at: "2026-08-12T10:00:00.000Z",
      updated_at: "2026-08-12T10:00:00.000Z",
    },
  });
  assert.deepEqual(sent, { messageId: 45 });
  const comparisonAttempt = calls.find(([, payload]) =>
    String(payload.text).startsWith("Grounded baseline"));
  assert.equal(
    comparisonAttempt?.[1].text,
    [
      "Grounded baseline (for comparison)",
      "Reader angle: Why this practical result matters now.",
      "Lexical similarity to baseline: 31%; rewrite selected",
      "Editorial length: 112 words (target 90–140)",
      "",
      "Grounded baseline text",
      "",
      "Next: Enriched version (selected for approval), with Publish/Reject controls.",
    ].join("\n"),
  );
  const selected = calls.at(-1);
  assert.equal(selected?.[0], "sendMessage");
  assert.equal(selected?.[1].text, body);
  assert.equal(selected?.[1].reply_markup, undefined);

  const longCalls: Array<[string, Record<string, unknown>]> = [];
  const longGateway = new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, payload) => {
      longCalls.push([method, payload]);
      return { message_id: 46 };
    },
  );
  await longGateway.sendReview({
    chatId: 10,
    sessionId: "b".repeat(48),
    preview: body,
    draft: {
      id: "draft-long",
      article_id: "article-long",
      body,
      status: "review",
      model: null,
      prompt_version: null,
      reviewer_notes: JSON.stringify({
        editorial_enrichment: {
          status: "completed",
          selected_version: "enriched",
          baseline_draft: { telegramText: "B".repeat(4050) },
          enriched_draft: { telegramText: body },
          quality: { readerAngle: "Long-form diagnostic", wordCount: 120, targetMinWords: 90, targetMaxWords: 140 },
        },
      }),
      approved_at: null,
      created_at: "2026-08-12T10:00:00.000Z",
      updated_at: "2026-08-12T10:00:00.000Z",
    },
  });
  assert.equal(longCalls.length, 3);
  assert.equal(
    longCalls[0][1].text,
    [
      "Grounded baseline (for comparison)",
      "Reader angle: Long-form diagnostic",
      "Editorial length: 120 words (target 90–140). The following message is the alternative.",
      "",
      "Next: Enriched version (selected for approval), with Publish/Reject controls.",
    ].join("\n"),
  );
  assert.equal(String(longCalls[1][1].text).length, 4050);
  assert.equal(longCalls[2][1].text, body);

  const baselineCalls: Array<[string, Record<string, unknown>]> = [];
  const baseline = "Grounded baseline selected";
  await new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, payload) => {
      baselineCalls.push([method, payload]);
      return { message_id: 47 };
    },
  ).sendReview({
    chatId: 10,
    sessionId: "c".repeat(48),
    preview: baseline,
    draft: {
      id: "draft-baseline",
      article_id: "article-baseline",
      body: baseline,
      status: "review",
      model: null,
      prompt_version: null,
      reviewer_notes: JSON.stringify({
        editorial_enrichment: {
          status: "completed",
          selected_version: "baseline",
          baseline_draft: { telegramText: baseline },
          enriched_draft: { telegramText: "Enriched candidate body" },
          quality: { reader_angle: "Baseline remains authoritative." },
        },
      }),
      approved_at: null,
      created_at: "2026-08-12T10:00:00.000Z",
      updated_at: "2026-08-12T10:00:00.000Z",
    },
  });
  assert.equal(
    baselineCalls[0][1].text,
    [
      "Enriched candidate (collect-only comparison)",
      "Reader angle: Baseline remains authoritative.",
      "",
      "Enriched candidate body",
      "",
      "Next: Grounded baseline (selected for approval), with Publish/Reject controls.",
    ].join("\n"),
  );
});

test("concrete Bot API outcome renderer keeps required sends retryable and manual policy-block status best effort", async () => {
  const calls: string[] = [];
  const renderer = new TelegramBotApiOutcomeRenderer(
    "token",
    async (_token, method, payload) => {
      calls.push(`${method}:${String(payload.text)}`);
      if (String(payload.text).startsWith("Research queued")) {
        throw new Error("required Telegram delivery failed");
      }
      if (String(payload.text).startsWith("Publication was blocked")) {
        throw new Error("best-effort blocked status failed");
      }
      return { message_id: 1 };
    },
  );
  const newsRequest: TelegramControlRequest = {
    updateId: 71,
    updateKind: "news_command",
    channelId: "@channel",
    actorId: 9,
    chatId: 10,
    chatType: "private",
    route: { kind: "news" },
  };
  await assert.rejects(
    renderer.render(newsRequest, { status: "research_queued" }),
    /required Telegram delivery failed/,
  );
  await renderer.render(newsRequest, {
    status: "blocked_by_policy",
    publicationPath: "manual_review",
  });
  await renderer.render(newsRequest, { status: "already_running" });
  assert.equal(
    calls[2],
    "sendMessage:A news search is already queued or running. The existing request will finish here.",
  );
  assert.equal(calls.length, 3);
});

test("legacy settings, Labs, stats, and status adapters execute verified transport flows behind neutral ports", async () => {
  const calls: string[] = [];
  const callTelegram = async () => ({ message_id: 1 });
  const base: TelegramControlRequest = {
    updateId: 81,
    updateKind: "settings_command",
    channelId: "@channel",
    actorId: 9,
    chatId: 10,
    chatType: "private",
    route: { kind: "settings", action: "open" },
  };
  const settings = new TelegramLegacySettingsGateway(
    "token",
    "@channel",
    {},
    callTelegram,
    {
      async show() { calls.push("settings:open"); return { settings: {}, messageId: 1 }; },
      async callback() { calls.push("settings:callback"); return { auditResult: "ok" }; },
      async input() { calls.push("settings:input"); return { auditResult: "ok" }; },
    },
  );
  await settings.execute(base);
  await settings.execute({
    ...base,
    updateKind: "settings_callback",
    route: {
      kind: "settings",
      action: "callback",
      payload: { callbackId: "cb", messageId: 12, action: { action: "view", value: "home", version: 1 } },
    },
  });
  await settings.execute({
    ...base,
    updateKind: "settings_input",
    route: { kind: "settings", action: "input", payload: { text: "AI", replyToMessageId: 13 } },
  });
  const labs = new TelegramLegacyLabsGateway(
    "token",
    "@channel",
    {},
    callTelegram,
    {
      async show() { calls.push("labs:open"); return { rows: [], messageId: 1 }; },
      async callback() { calls.push("labs:callback"); return { auditResult: "ok" }; },
    },
  );
  await labs.execute({ ...base, updateKind: "labs_command", route: { kind: "labs", action: "open" } });
  const stats = new TelegramLegacyStatsGateway(
    "token",
    "@channel",
    {},
    callTelegram,
    async () => {
      calls.push("stats:open");
      return { summary: {}, posts: [] };
    },
  );
  await stats.execute({ ...base, updateKind: "stats_command", route: { kind: "stats" } });
  const status = new TelegramLegacyStatusGateway(
    "token",
    "@channel",
    {},
    callTelegram,
    {},
    ["exa"],
    "test-version",
    {
      async show() { calls.push("status:open"); return { providers: [] }; },
      async callback() { calls.push("status:callback"); return { auditResult: "ok" }; },
    },
  );
  await status.execute({ ...base, updateKind: "status_command", route: { kind: "status", action: "open" } });
  await status.execute({
    ...base,
    updateKind: "status_callback",
    route: {
      kind: "status",
      action: "callback",
      payload: { callbackId: "cb-status", messageId: 14, action: { action: "test_exa" } },
    },
  });
  assert.deepEqual(calls, [
    "settings:open",
    "settings:callback",
    "settings:input",
    "labs:open",
    "stats:open",
    "status:open",
    "status:callback",
  ]);
});

test("TelegramControlApplicationModule exposes a real Nest application identity without starting a runtime", async () => {
  const unused = { async execute() { return { status: "unused" }; } };
  const fakePool = {
    on() {},
    async query() { throw new Error("unused pool"); },
    async end() {},
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      TelegramControlApplicationModule.register({
        authorization: { async isChannelAdmin() { return true; } },
        audit: { async run(_context, operation) { return operation(); } },
        editorial: {
          async generateReviewDraft() { throw new Error("unused"); },
          async publishApprovedDraft() { throw new Error("unused"); },
          async reconcilePublication() { throw new Error("unused"); },
        },
        reviewPresentation: {
          async restoreControls() { return "missing"; },
          async disableControls() {},
          async answerCallback() {},
          async sendReview() { return { messageId: 1 }; },
        },
        settings: unused,
        labs: unused,
        stats: unused,
        status: unused,
      }),
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .overrideProvider(DRIZZLE_DB)
    .useValue({
      async execute() { throw new Error("unused drizzle"); },
      async transaction() { throw new Error("unused drizzle transaction"); },
    })
    .compile();

  const application = moduleRef.get(TELEGRAM_CONTROL_APPLICATION);
  assert.ok(application instanceof TelegramControlService);
  assert.equal(moduleRef.get(TelegramControlService), application);
  await moduleRef.close();
});
