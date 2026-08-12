import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { DeliverTelegramReviewUseCase } from "../../src/telegram/application/deliver-telegram-review.use-case.js";
import type { EditorialPersistence } from "../../src/editorial/editorial-persistence.contracts.js";
import type { TelegramReviewSessionsPersistence } from "../../src/telegram/telegram-persistence.contracts.js";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const SESSION = {
  id: "a".repeat(48),
  draft_id: "draft-1",
  telegram_channel_id: "@channel",
  control_chat_id: 7001,
  preview_message_id: 55,
  requested_by: 9001,
  decision: null,
  decided_by: null,
  decided_at: null,
  expires_at: "2026-08-12T09:00:00.000Z",
  created_at: "2026-08-11T09:00:00.000Z",
} as const;
const DRAFT = {
  id: "draft-1",
  article_id: "article-1",
  body: "Review preview",
  status: "review",
  model: null,
  prompt_version: null,
  reviewer_notes: null,
  approved_at: null,
  created_at: "2026-08-12T08:00:00.000Z",
  updated_at: "2026-08-12T08:00:00.000Z",
};

function reviews(value: object): TelegramReviewSessionsPersistence {
  return value as TelegramReviewSessionsPersistence;
}

function editorial(): EditorialPersistence {
  return {
    async getDraft() { return DRAFT; },
  } as unknown as EditorialPersistence;
}

test("expired undecided review restores controls and renews the same atomic session", async () => {
  const calls: unknown[] = [];
  const renewed = { ...SESSION, expires_at: "2026-08-13T10:00:00.000Z" };
  const useCase = new DeliverTelegramReviewUseCase(
    reviews({
      async findTelegramReviewSessionByDraft() { return SESSION; },
      async renewTelegramReviewSession(input: unknown) {
        calls.push(["renew", input]);
        return renewed;
      },
    }),
    editorial(),
    {
      async restoreControls(input) { calls.push(["restore", input]); return "available"; },
      async disableControls() { calls.push(["disable"]); },
      async answerCallback() { calls.push(["answer"]); },
      async sendReview() { calls.push(["send"]); return { messageId: 56 }; },
    },
    { next: () => "b".repeat(48) },
    { now: () => NOW },
  );

  const result = await useCase.execute({
    draftId: DRAFT.id,
    channelId: "@channel",
    chatId: 7001,
    actorId: 9001,
    preview: DRAFT.body,
  });
  assert.deepEqual(result, {
    status: "review_ready",
    draftId: DRAFT.id,
    sessionId: SESSION.id,
    previewMessageId: SESSION.preview_message_id,
    resumed: true,
  });
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), ["restore", "renew"]);
});

test("deleted review message is replaced and ambiguous rebind response recovers the committed binding", async () => {
  const calls: unknown[] = [];
  let lookups = 0;
  const rebound = { ...SESSION, preview_message_id: 56, expires_at: "2026-08-13T10:00:00.000Z" };
  const useCase = new DeliverTelegramReviewUseCase(
    reviews({
      async findTelegramReviewSessionByDraft() {
        lookups += 1;
        return lookups === 1 ? SESSION : rebound;
      },
      async rebindTelegramReviewSession(input: unknown) {
        calls.push(["rebind", input]);
        throw new Error("database response lost");
      },
    }),
    editorial(),
    {
      async restoreControls() { calls.push(["restore"]); return "missing"; },
      async disableControls() { calls.push(["disable"]); },
      async answerCallback() { calls.push(["answer"]); },
      async sendReview(input) { calls.push(["send", input]); return { messageId: 56 }; },
    },
    { next: () => "b".repeat(48) },
    { now: () => NOW },
  );

  const result = await useCase.execute({
    draftId: DRAFT.id,
    channelId: "@channel",
    chatId: 7001,
    actorId: 9001,
    preview: DRAFT.body,
  });
  assert.deepEqual(result, {
    status: "review_ready",
    draftId: DRAFT.id,
    sessionId: SESSION.id,
    previewMessageId: 56,
    resumed: true,
    rebound: true,
  });
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), [
    "restore",
    "send",
    "rebind",
  ]);
});

test("new review sends the selected preview before persisting the exact bound session", async () => {
  const calls: unknown[] = [];
  const sessionId = "b".repeat(48);
  const useCase = new DeliverTelegramReviewUseCase(
    reviews({
      async findTelegramReviewSessionByDraft() { return null; },
      async createTelegramReviewSession(input: Record<string, unknown>) {
        calls.push(["create", input]);
        return {
          ...SESSION,
          id: sessionId,
          preview_message_id: 56,
          expires_at: input.expires_at,
        };
      },
    }),
    editorial(),
    {
      async restoreControls() { throw new Error("unused"); },
      async disableControls() {},
      async answerCallback() {},
      async sendReview(input) { calls.push(["send", input]); return { messageId: 56 }; },
    },
    { next: () => sessionId },
    { now: () => NOW },
  );

  const result = await useCase.execute({
    draftId: DRAFT.id,
    channelId: "@channel",
    chatId: 7001,
    actorId: 9001,
    preview: DRAFT.body,
  });
  assert.equal(result.status, "review_ready");
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), ["send", "create"]);
  assert.deepEqual((calls[1] as unknown[])[1], {
    id: sessionId,
    draft_id: DRAFT.id,
    telegram_channel_id: "@channel",
    control_chat_id: 7001,
    preview_message_id: 56,
    requested_by: 9001,
    expires_at: "2026-08-13T10:00:00.000Z",
  });
});
