import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import { TELEGRAM_STATS_CONTROL } from "../telegram-application.tokens.js";

@Injectable()
export class GetTelegramStatsUseCase {
  constructor(
    @Inject(TELEGRAM_STATS_CONTROL)
    private readonly stats: TelegramControlFeatureGateway,
  ) {}

  execute(request: TelegramControlRequest, signal?: AbortSignal): Promise<TelegramControlOutcome> {
    signal?.throwIfAborted();
    if (request.route.kind !== "stats") {
      throw new TelegramControlError("malformed_command", "Expected stats route");
    }
    return this.stats.execute(request, signal);
  }
}
