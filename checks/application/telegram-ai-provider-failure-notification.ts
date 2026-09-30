import assert from "node:assert/strict";
import test from "node:test";

import {
  renderAiProviderFailureAlert,
  TelegramAiProviderFailureNotificationAdapter,
} from "../../src/telegram/telegram-ai-provider-failure-notification.adapter.js";
import type { AiProviderFailureAlert } from "../../src/ai/ai-provider.contracts.js";
import { createFallbackAiProvider } from "../../src/ai/ai-provider-composition.js";

const ALERT: AiProviderFailureAlert = {
  attemptId: "attempt-1",
  correlationId: "trace-1",
  operation: "editorial_enrichment",
  provider: "openai",
  model: "gpt-5.4-2026-03-05",
  attemptNumber: 2,
  latencyMs: 61_250,
  errorCode: "timeout",
  continuation: "trying_next_provider",
};

test("Telegram AI incident adapter resolves the current private operator chat", async () => {
  const calls: unknown[] = [];
  const adapter = new TelegramAiProviderFailureNotificationAdapter({
    token: "bot-token",
    channelId: "@channel",
    settings: {
      async getNewsSettings(channelId) {
        calls.push(["settings", channelId]);
        return { review_chat_id: 4242 } as never;
      },
    },
    async callTelegram(token, method, body, options) {
      calls.push([token, method, body, options]);
      return {};
    },
  });

  await adapter.notify(ALERT);

  assert.deepEqual(calls[0], ["settings", "@channel"]);
  const telegramCall = calls[1] as unknown[];
  assert.equal(telegramCall[0], "bot-token");
  assert.equal(telegramCall[1], "sendMessage");
  assert.deepEqual(telegramCall[2], {
    chat_id: 4242,
    text: renderAiProviderFailureAlert(ALERT),
    disable_web_page_preview: true,
  });
  assert.ok((telegramCall[3] as { signal?: AbortSignal }).signal instanceof AbortSignal);
  assert.match(renderAiProviderFailureAlert(ALERT), /AI provider request failed/);
  assert.match(renderAiProviderFailureAlert(ALERT), /Next: trying the next provider/);
  assert.equal(renderAiProviderFailureAlert(ALERT).includes("attempt-1"), false);
});

test("Telegram AI incident adapter fails closed when no operator chat exists", async () => {
  let telegramCalls = 0;
  const adapter = new TelegramAiProviderFailureNotificationAdapter({
    token: "bot-token",
    channelId: "@channel",
    settings: {
      async getNewsSettings() {
        return null;
      },
    },
    async callTelegram() {
      telegramCalls += 1;
      return {};
    },
  });

  await assert.rejects(adapter.notify(ALERT), /no operator chat/);
  assert.equal(telegramCalls, 0);
});

test("Telegram AI incident text collapses line breaks from model and operation labels", () => {
  const text = renderAiProviderFailureAlert({
    ...ALERT,
    operation: "editorial\nspoof",
    model: "model\nspoof",
  });
  assert.match(text, /Operation: editorial spoof/);
  assert.match(text, /Model: model spoof/);
});

test("a hanging settings lookup is bounded and cannot block provider fallback", async () => {
  const adapter = new TelegramAiProviderFailureNotificationAdapter({
    token: "bot-token",
    channelId: "@channel",
    deliveryDeadlineMs: 5,
    settings: {
      async getNewsSettings() {
        return new Promise<never>(() => {});
      },
    },
    async callTelegram() {
      throw new Error("must not reach Telegram while settings are pending");
    },
  });
  const provider = createFallbackAiProvider([
    {
      name: "openai",
      async generateStructured() {
        throw Object.assign(new Error("rejected"), { status: 401 });
      },
    },
    {
      name: "gemini",
      async generateStructured() {
        return { provider: "gemini" };
      },
    },
  ], {
    log: { warn() {} },
    failureNotifier: adapter,
  });

  const result = await Promise.race([
    provider.generateStructured({ usageOperation: "editorial_enrichment" }),
    new Promise<{ provider: string }>((resolve) => {
      setTimeout(() => resolve({ provider: "test_timeout" }), 250);
    }),
  ]);

  assert.equal(result.provider, "gemini");
});
