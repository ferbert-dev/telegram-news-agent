import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import { TELEGRAM_STATUS_CONTROL } from "../telegram-application.tokens.js";

@Injectable()
export class HandleTelegramStatusUseCase {
  constructor(
    @Inject(TELEGRAM_STATUS_CONTROL)
    private readonly status: TelegramControlFeatureGateway,
  ) {}

  execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "status") {
      throw new TelegramControlError("malformed_command", "Expected status route");
    }
    return this.status.execute(request);
  }
}
