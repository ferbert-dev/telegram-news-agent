import type {
  TelegramControlApplicationPort,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import {
  parseTelegramControlUpdate,
  type TelegramControlRawUpdate,
} from "./telegram-control-update.parser.js";

export interface TelegramControlOutcomeRenderer {
  render(
    request: TelegramControlRequest,
    outcome: TelegramControlOutcome,
  ): Promise<void>;
}

/** Thin adapter: raw Telegram parsing and rendering never enter application use cases. */
export class TelegramControlTransportHandler {
  constructor(
    private readonly application: TelegramControlApplicationPort,
    private readonly renderer: TelegramControlOutcomeRenderer,
    private readonly identity: {
      botUsername: string;
      botId: number;
      channelId: string;
    },
  ) {}

  async handle(
    update: TelegramControlRawUpdate,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    handled: boolean;
    outcome?: TelegramControlOutcome;
  }> {
    const request = parseTelegramControlUpdate(update, this.identity);
    if (!request) return { handled: false };
    const outcome = await this.application.handle(
      request,
      (semanticOutcome) => this.renderer.render(request, semanticOutcome),
      options.signal,
    );
    return { handled: true, outcome };
  }
}
