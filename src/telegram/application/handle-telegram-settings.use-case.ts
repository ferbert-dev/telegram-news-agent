import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import { TELEGRAM_SETTINGS_CONTROL } from "../telegram-application.tokens.js";

@Injectable()
export class HandleTelegramSettingsUseCase {
  constructor(
    @Inject(TELEGRAM_SETTINGS_CONTROL)
    private readonly settings: TelegramControlFeatureGateway,
  ) {}

  execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "settings") {
      throw new TelegramControlError("malformed_command", "Expected settings route");
    }
    return this.settings.execute(request);
  }
}
