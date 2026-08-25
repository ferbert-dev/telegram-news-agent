import test from "node:test";
import assert from "node:assert/strict";
import {
  boldArticleTitleEntities,
  callTelegram,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TelegramError,
  validateMessage,
} from "../src/telegram.js";

test("boldArticleTitleEntities bolds the first line using Telegram UTF-16 offsets", () => {
  const title = "🚀 Новина, яку варто прочитати";
  assert.deepEqual(
    boldArticleTitleEntities(`${title}\n\nОсновний текст.`),
    [{ type: "bold", offset: 0, length: title.length }],
  );
});

test("validateMessage trims valid text", () => {
  assert.equal(validateMessage("  AI news update  "), "AI news update");
});

test("validateMessage rejects empty text", () => {
  assert.throws(() => validateMessage("   "), /Message text is required/);
});

test("validateMessage rejects messages over Telegram's limit", () => {
  const message = "a".repeat(TELEGRAM_MESSAGE_MAX_LENGTH + 1);

  assert.throws(() => validateMessage(message), /4096-character limit/);
});

test("callTelegram preserves Telegram 409 as a typed conflict", async () => {
  await assert.rejects(
    callTelegram("token", "getUpdates", {}, {
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        async json() {
          return {
            ok: false,
            error_code: 409,
            description: "Conflict: terminated by other getUpdates request",
          };
        },
      }),
    }),
    (error) =>
      error instanceof TelegramError &&
      error.status === 409 &&
      error.errorCode === 409,
  );
});
