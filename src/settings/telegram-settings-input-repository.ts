import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import {
  postgresRows,
  RepositorySupport,
} from "../database/repositories/repository-support.js";
import type {
  BeginTelegramSettingsInput,
  ConsumeTelegramSettingsInput,
  TelegramSettingsInputPersistence,
  TelegramSettingsInputRow,
} from "./settings.contracts.js";
import {
  mapTelegramSettingsInputRow,
  type TelegramSettingsInputDatabaseRow,
} from "./settings-row-mappers.js";

const beginTelegramSettingsInputFunction =
  postgresRows<TelegramSettingsInputDatabaseRow>(
    "public.begin_telegram_settings_input",
    4,
  );
const consumeTelegramSettingsInputFunction =
  postgresRows<TelegramSettingsInputDatabaseRow>(
    "public.consume_telegram_settings_input",
    3,
  );

@Injectable()
export class TelegramSettingsInputRepository
  extends RepositorySupport
  implements TelegramSettingsInputPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async beginTelegramSettingsInput({
    controlChatId,
    requestedBy,
    promptMessageId,
    expiresAt,
  }: BeginTelegramSettingsInput): Promise<TelegramSettingsInputRow | null> {
    const rows = await this.functionRows(
      "Begin Telegram settings input",
      beginTelegramSettingsInputFunction,
      [controlChatId, requestedBy, promptMessageId, expiresAt],
    );
    const row = this.optionalOne(rows, "Begin Telegram settings input");
    return row === null ? null : mapTelegramSettingsInputRow(row);
  }

  async consumeTelegramSettingsInput({
    controlChatId,
    requestedBy,
    promptMessageId,
  }: ConsumeTelegramSettingsInput): Promise<TelegramSettingsInputRow | null> {
    const rows = await this.functionRows(
      "Consume Telegram settings input",
      consumeTelegramSettingsInputFunction,
      [controlChatId, requestedBy, promptMessageId],
    );
    const row = this.optionalOne(rows, "Consume Telegram settings input");
    return row === null ? null : mapTelegramSettingsInputRow(row);
  }
}
