import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import {
  postgresRows,
  postgresScalar,
  RepositorySupport,
} from "../database/repositories/repository-support.js";
import type {
  ClaimTelegramUpdateInput,
  FinishTelegramUpdateInput,
  RecordTelegramUpdateFailureInput,
  TelegramUpdateClaimRow,
  TelegramUpdateFailureRow,
  TelegramUpdatesPersistence,
} from "./telegram-persistence.contracts.js";
import {
  mapTelegramUpdateClaimRow,
  mapTelegramUpdateFailureRow,
  type TelegramUpdateClaimDatabaseRow,
  type TelegramUpdateFailureDatabaseRow,
} from "./telegram-row-mappers.js";

const claimTelegramUpdateFunction =
  postgresRows<TelegramUpdateClaimDatabaseRow>(
    "public.claim_telegram_update",
    3,
  );
const finishTelegramUpdateFunction = postgresScalar<boolean>(
  "public.finish_telegram_update",
  4,
);
const recordTelegramUpdateFailureFunction =
  postgresRows<TelegramUpdateFailureDatabaseRow>(
    "public.record_telegram_update_failure",
    6,
  );

@Injectable()
export class TelegramUpdatesRepository
  extends RepositorySupport
  implements TelegramUpdatesPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async claimTelegramUpdate({
    updateId,
    updateKind,
    staleAfterSeconds = 120,
  }: ClaimTelegramUpdateInput): Promise<TelegramUpdateClaimRow> {
    const rows = await this.functionRows(
      "Claim Telegram update",
      claimTelegramUpdateFunction,
      [updateId, updateKind, staleAfterSeconds],
    );
    return mapTelegramUpdateClaimRow(
      this.one(rows, "Claim Telegram update"),
    );
  }

  finishTelegramUpdate({
    updateId,
    claimToken,
    status,
    errorCode = null,
  }: FinishTelegramUpdateInput): Promise<boolean> {
    return this.functionScalar(
      "Finish Telegram update",
      finishTelegramUpdateFunction,
      [updateId, claimToken, status, errorCode],
    );
  }

  async recordTelegramUpdateFailure({
    updateId,
    updateKind,
    errorCode,
    maxAttempts = 3,
    terminal = false,
    claimToken = null,
  }: RecordTelegramUpdateFailureInput): Promise<TelegramUpdateFailureRow> {
    const rows = await this.functionRows(
      "Record Telegram update failure",
      recordTelegramUpdateFailureFunction,
      [updateId, updateKind, errorCode, maxAttempts, terminal, claimToken],
    );
    return mapTelegramUpdateFailureRow(
      this.one(rows, "Record Telegram update failure"),
    );
  }
}
