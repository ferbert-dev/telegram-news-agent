import type { SchedulerNotificationApplicationPort } from "./scheduler-application.contracts.js";
import type { TelegramCall } from "../telegram/transport/telegram-call.adapter.js";

/**
 * Sends the scheduler's operator-facing messages (publication confirmations,
 * unresolved-publication warnings) to a Telegram chat.
 *
 * Lives outside `application/` on purpose: it is an outbound adapter, not
 * application logic, and application-layer files are forbidden from importing
 * transport.
 *
 * Note the caller's contract: RunScheduledNewsOnceUseCase always invokes
 * `notify(...).catch(() => undefined)` — these notifications are best effort
 * and must never turn a successful scheduled run into a failure. This adapter
 * therefore does not swallow errors itself; doing so would hide delivery
 * failures from tests and from any future caller that does care, while adding
 * nothing for the current one.
 */
export class TelegramSchedulerNotificationAdapter
  implements SchedulerNotificationApplicationPort
{
  constructor(
    private readonly token: string,
    private readonly callTelegram: TelegramCall,
  ) {}

  async notify(input: {
    chatId: number;
    text: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.callTelegram(
      this.token,
      "sendMessage",
      { chat_id: input.chatId, text: input.text },
      input.signal ? { signal: input.signal } : undefined,
    );
  }
}
