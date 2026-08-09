import { Inject, Injectable } from "@nestjs/common";

import type {
  BeginTelegramSettingsInput,
  ConsumeTelegramSettingsInput,
  TelegramSettingsInputPersistence,
  TelegramSettingsInputRow,
} from "../settings.contracts.js";
import { TELEGRAM_SETTINGS_INPUT_REPOSITORY } from "../settings.tokens.js";

/** Transport-neutral lifecycle for a bound custom-topic reply prompt. */
@Injectable()
export class TelegramSettingsInputUseCases {
  constructor(
    @Inject(TELEGRAM_SETTINGS_INPUT_REPOSITORY)
    private readonly settingsInput: TelegramSettingsInputPersistence,
  ) {}

  begin(
    input: BeginTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null> {
    return this.settingsInput.beginTelegramSettingsInput(input);
  }

  consume(
    input: ConsumeTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null> {
    return this.settingsInput.consumeTelegramSettingsInput(input);
  }
}
