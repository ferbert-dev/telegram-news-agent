import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_MESSAGE_MAX_LENGTH,
  validateMessage,
} from "../src/telegram.js";

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
