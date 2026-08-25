import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import { TELEGRAM_LABS_CONTROL } from "../telegram-application.tokens.js";

@Injectable()
export class HandleTelegramLabsUseCase {
  constructor(
    @Inject(TELEGRAM_LABS_CONTROL)
    private readonly labs: TelegramControlFeatureGateway,
  ) {}

  execute(request: TelegramControlRequest, signal?: AbortSignal): Promise<TelegramControlOutcome> {
    signal?.throwIfAborted();
    if (request.route.kind !== "labs") {
      throw new TelegramControlError("malformed_command", "Expected labs route");
    }
    return this.labs.execute(request, signal);
  }
}
