import type {
  AiProviderFailureAlert,
  AiProviderFailureNotifier,
} from "../ai/ai-provider.contracts.js";
import type { NewsSettingsPersistence } from "../settings/settings.contracts.js";
import type { TelegramCall } from "./transport/telegram-call.adapter.js";

type SettingsReader = Pick<NewsSettingsPersistence, "getNewsSettings">;

const CONTINUATION_TEXT: Record<AiProviderFailureAlert["continuation"], string> = {
  retrying_same_provider: "retrying the same provider",
  trying_next_provider: "trying the next provider",
  request_failed: "AI request failed; application fallback may use the baseline",
};

function singleLine(value: unknown, maximum: number): string {
  return String(value ?? "unknown")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum) || "unknown";
}

export function renderAiProviderFailureAlert(input: AiProviderFailureAlert): string {
  const seconds = (Math.max(0, input.latencyMs) / 1_000).toFixed(1);
  return [
    "🚨 AI provider request failed",
    `Operation: ${singleLine(input.operation, 96)}`,
    `Provider: ${singleLine(input.provider, 48)}`,
    `Model: ${singleLine(input.model, 96)}`,
    `Failure: ${singleLine(input.errorCode, 64)}`,
    `Attempt: ${input.attemptNumber}`,
    `Latency: ${seconds}s`,
    `Next: ${CONTINUATION_TEXT[input.continuation]}`,
    `Trace: ${singleLine(input.correlationId, 96)}`,
  ].join("\n");
}

/**
 * Delivers sanitized AI incident notices to the private operator chat stored in
 * news settings. The chat is resolved for every alert so a settings change does
 * not leave incidents going to an old administrator.
 */
export class TelegramAiProviderFailureNotificationAdapter
  implements AiProviderFailureNotifier
{
  constructor(
    private readonly options: {
      token: string;
      channelId: string;
      settings: SettingsReader;
      callTelegram: TelegramCall;
      deliveryDeadlineMs?: number;
    },
  ) {}

  async notify(input: AiProviderFailureAlert): Promise<void> {
    const deadlineMs = this.options.deliveryDeadlineMs ?? 5_000;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(
          `AI provider failure alert exceeded ${deadlineMs}ms`,
        );
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });

    try {
      await Promise.race([this.deliver(input, controller.signal), deadline]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async deliver(
    input: AiProviderFailureAlert,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = await this.options.settings.getNewsSettings(
      this.options.channelId,
    );
    const chatId = settings?.review_chat_id;
    if (!Number.isSafeInteger(chatId) || Number(chatId) <= 0) {
      throw new Error("AI provider failure alert has no operator chat");
    }
    await this.options.callTelegram(
      this.options.token,
      "sendMessage",
      {
        chat_id: chatId,
        text: renderAiProviderFailureAlert(input),
        disable_web_page_preview: true,
      },
      { signal },
    );
  }
}
