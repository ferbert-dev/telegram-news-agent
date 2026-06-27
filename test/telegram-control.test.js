import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyControlUpdate,
  createReviewCallback,
  handleControlUpdate,
  parseNewsCommand,
  parseReviewCallback,
} from "../src/telegram-control.js";
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

test("/news requires private admin and persists a bound 24h session", async () => {
  const { calls, dependencies } = fixture();
  const result = await handleControlUpdate(commandUpdate(), dependencies);

  assert.equal(result.handled, true);
  const session = calls.find(([name]) => name === "session")[1];
  assert.equal(session.control_chat_id, 9);
  assert.equal(session.preview_message_id, 77);
  assert.equal(session.draft_id, "draft-1");
  assert.equal(session.expires_at, "2026-06-28T12:00:00.000Z");
  const keyboard = calls.find(([name]) => name === "editMessageReplyMarkup")[1]
    .reply_markup.inline_keyboard;
  assert.match(keyboard[0][0].callback_data, /^news:p:[a-f0-9]+$/);
});

test("/news denial performs no pipeline mutation", async () => {
  let ran = false;
  const { dependencies } = fixture({
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
      async claimDraftForPublication() {
        if (draftStatus !== "approved") {
          throw new Error("Draft is not approved or is already being published");
        }
        draftStatus = "publishing";
        return { id: "draft-1", body: "Approved article" };
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
    updateStatus: "failed",
    draftStatus: "publishing",
    publication: null,
    sends: 1,
  });

  await assert.rejects(
    handleControlUpdate(callbackUpdate(), flow.dependencies),
    /already being published/,
  );
  assert.deepEqual(flow.state(), {
    updateStatus: "failed",
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
