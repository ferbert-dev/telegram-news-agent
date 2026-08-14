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
  ClaimNextTelegramNewsJobInput,
  EnqueueTelegramNewsJobInput,
  RecordTelegramNewsJobOutcomeInput,
  RetryTelegramNewsJobDeliveryInput,
  RetryTelegramNewsJobInput,
  TelegramNewsJobClaimIdentity,
  TelegramNewsJobClaimRow,
  TelegramNewsJobEnqueueRow,
  TelegramNewsJobsPersistence,
  TelegramNewsJobStateRow,
} from "./telegram-persistence.contracts.js";
import {
  mapTelegramNewsJobClaimRow,
  mapTelegramNewsJobEnqueueRow,
  mapTelegramNewsJobStateRow,
  type TelegramNewsJobClaimDatabaseRow,
  type TelegramNewsJobEnqueueDatabaseRow,
  type TelegramNewsJobStateDatabaseRow,
} from "./telegram-row-mappers.js";

const enqueueFunction = postgresRows<TelegramNewsJobEnqueueDatabaseRow>(
  "public.enqueue_telegram_news_job",
  6,
);
const claimFunction = postgresRows<TelegramNewsJobClaimDatabaseRow>(
  "public.claim_next_telegram_news_job",
  4,
);
const renewFunction = postgresScalar<boolean>(
  "public.renew_telegram_news_job_claim",
  2,
);
const outcomeFunction = postgresRows<TelegramNewsJobStateDatabaseRow>(
  "public.record_telegram_news_job_outcome",
  6,
);
const retryFunction = postgresRows<TelegramNewsJobStateDatabaseRow>(
  "public.retry_telegram_news_job",
  5,
);
const retryDeliveryFunction = postgresRows<TelegramNewsJobStateDatabaseRow>(
  "public.retry_telegram_news_job_delivery",
  4,
);
const completeFunction = postgresScalar<boolean>(
  "public.complete_telegram_news_job",
  2,
);

@Injectable()
export class TelegramNewsJobsRepository
  extends RepositorySupport
  implements TelegramNewsJobsPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async enqueueTelegramNewsJob({
    updateId,
    updateClaimToken,
    channelId,
    controlChatId,
    requestedBy,
    settingsSnapshot,
  }: EnqueueTelegramNewsJobInput): Promise<TelegramNewsJobEnqueueRow> {
    const rows = await this.functionRows(
      "Enqueue Telegram news job",
      enqueueFunction,
      [
        updateId,
        updateClaimToken,
        channelId,
        controlChatId,
        requestedBy,
        settingsSnapshot,
      ],
    );
    return mapTelegramNewsJobEnqueueRow(
      this.one(rows, "Enqueue Telegram news job"),
    );
  }

  async claimNextTelegramNewsJob({
    claimToken,
    staleAfterSeconds = 1800,
    maxExecutionAttempts = 3,
    maxDeliveryAttempts = 10,
  }: ClaimNextTelegramNewsJobInput): Promise<TelegramNewsJobClaimRow | null> {
    const rows = await this.functionRows(
      "Claim next Telegram news job",
      claimFunction,
      [
        claimToken,
        staleAfterSeconds,
        maxExecutionAttempts,
        maxDeliveryAttempts,
      ],
    );
    const row = this.optionalOne(rows, "Claim next Telegram news job");
    return row === null ? null : mapTelegramNewsJobClaimRow(row);
  }

  renewTelegramNewsJobClaim({
    jobId,
    claimToken,
  }: TelegramNewsJobClaimIdentity): Promise<boolean> {
    return this.functionScalar("Renew Telegram news job claim", renewFunction, [
      jobId,
      claimToken,
    ]);
  }

  async recordTelegramNewsJobOutcome({
    jobId,
    claimToken,
    outcomeStatus,
    draftId = null,
    publicationMessageId = null,
    errorCode = null,
  }: RecordTelegramNewsJobOutcomeInput): Promise<TelegramNewsJobStateRow | null> {
    const rows = await this.functionRows(
      "Record Telegram news job outcome",
      outcomeFunction,
      [
        jobId,
        claimToken,
        outcomeStatus,
        draftId,
        publicationMessageId,
        errorCode,
      ],
    );
    const row = this.optionalOne(rows, "Record Telegram news job outcome");
    return row === null ? null : mapTelegramNewsJobStateRow(row);
  }

  async retryTelegramNewsJob({
    jobId,
    claimToken,
    errorCode,
    maxAttempts = 3,
    terminal = false,
  }: RetryTelegramNewsJobInput): Promise<TelegramNewsJobStateRow | null> {
    const rows = await this.functionRows(
      "Retry Telegram news job",
      retryFunction,
      [jobId, claimToken, errorCode, maxAttempts, terminal],
    );
    const row = this.optionalOne(rows, "Retry Telegram news job");
    return row === null ? null : mapTelegramNewsJobStateRow(row);
  }

  async retryTelegramNewsJobDelivery({
    jobId,
    claimToken,
    errorCode,
    maxAttempts = 10,
  }: RetryTelegramNewsJobDeliveryInput): Promise<TelegramNewsJobStateRow | null> {
    const rows = await this.functionRows(
      "Retry Telegram news job delivery",
      retryDeliveryFunction,
      [jobId, claimToken, errorCode, maxAttempts],
    );
    const row = this.optionalOne(rows, "Retry Telegram news job delivery");
    return row === null ? null : mapTelegramNewsJobStateRow(row);
  }

  completeTelegramNewsJob({
    jobId,
    claimToken,
  }: TelegramNewsJobClaimIdentity): Promise<boolean> {
    return this.functionScalar("Complete Telegram news job", completeFunction, [
      jobId,
      claimToken,
    ]);
  }
}
