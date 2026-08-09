import { Inject, Injectable } from "@nestjs/common";
import { and, eq, exists, gt, isNull, or, sql } from "drizzle-orm";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import {
  postgresRows,
  RepositorySupport,
  toIsoTimestamp,
} from "../database/repositories/repository-support.js";
import { drafts } from "../database/schema/editorial.js";
import { newsBotSettings } from "../database/schema/settings.js";
import { telegramReviewSessions } from "../database/schema/telegram.js";
import type {
  CreateTelegramReviewSessionInput,
  DecideTelegramReviewSessionInput,
  RebindTelegramReviewSessionInput,
  RenewTelegramReviewSessionInput,
  TelegramReviewDecisionRow,
  TelegramReviewSessionRow,
  TelegramReviewSessionsPersistence,
} from "./telegram-persistence.contracts.js";
import {
  mapTelegramReviewDecisionRow,
  mapTelegramReviewSessionRow,
  type TelegramReviewDecisionDatabaseRow,
  type TelegramReviewSessionDatabaseRow,
} from "./telegram-row-mappers.js";

const reviewSessionSelection = {
  id: telegramReviewSessions.id,
  draft_id: telegramReviewSessions.draftId,
  telegram_channel_id: telegramReviewSessions.telegramChannelId,
  control_chat_id: telegramReviewSessions.controlChatId,
  preview_message_id: telegramReviewSessions.previewMessageId,
  requested_by: telegramReviewSessions.requestedBy,
  decision: telegramReviewSessions.decision,
  decided_by: telegramReviewSessions.decidedBy,
  decided_at: telegramReviewSessions.decidedAt,
  expires_at: telegramReviewSessions.expiresAt,
  created_at: telegramReviewSessions.createdAt,
};

const renewTelegramReviewSessionFunction =
  postgresRows<TelegramReviewSessionDatabaseRow>(
    "public.renew_telegram_review_session",
    2,
  );
const rebindTelegramReviewSessionFunction =
  postgresRows<TelegramReviewSessionDatabaseRow>(
    "public.rebind_telegram_review_session",
    5,
  );
const decideTelegramReviewSessionFunction =
  postgresRows<TelegramReviewDecisionDatabaseRow>(
    "public.decide_telegram_review_session",
    5,
  );

function optionalSession(
  row: TelegramReviewSessionDatabaseRow | null,
): TelegramReviewSessionRow | null {
  return row === null ? null : mapTelegramReviewSessionRow(row);
}

@Injectable()
export class TelegramReviewSessionsRepository
  extends RepositorySupport
  implements TelegramReviewSessionsPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async hasPendingTelegramReview(channelId: string): Promise<boolean> {
    const normalizedChannelId = sql<string>`btrim(${channelId})`;
    const legacySettingsFallback = exists(
      this.database
        .select({ one: sql<number>`1` })
        .from(newsBotSettings)
        .where(
          and(
            eq(newsBotSettings.telegramChannelId, normalizedChannelId),
            eq(
              newsBotSettings.reviewChatId,
              telegramReviewSessions.controlChatId,
            ),
          ),
        ),
    );
    const rows = await this.operation("Check pending Telegram review", () =>
      this.database
        .select({ id: telegramReviewSessions.id })
        .from(telegramReviewSessions)
        .innerJoin(drafts, eq(drafts.id, telegramReviewSessions.draftId))
        .where(
          and(
            or(
              eq(
                telegramReviewSessions.telegramChannelId,
                normalizedChannelId,
              ),
              and(
                isNull(telegramReviewSessions.telegramChannelId),
                legacySettingsFallback,
              ),
            ),
            isNull(telegramReviewSessions.decision),
            gt(telegramReviewSessions.expiresAt, sql`now()`),
            eq(drafts.status, "review"),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  async createTelegramReviewSession(
    input: CreateTelegramReviewSessionInput,
  ): Promise<TelegramReviewSessionRow> {
    const values: typeof telegramReviewSessions.$inferInsert = {
      id: input.id,
      draftId: input.draft_id,
      controlChatId: input.control_chat_id,
      previewMessageId: input.preview_message_id,
      requestedBy: input.requested_by,
      expiresAt: toIsoTimestamp(input.expires_at),
    };
    if (input.telegram_channel_id !== undefined) {
      values.telegramChannelId = input.telegram_channel_id;
    }
    if (input.decision !== undefined) values.decision = input.decision;
    if (input.decided_by !== undefined) values.decidedBy = input.decided_by;
    if (input.decided_at !== undefined) {
      values.decidedAt =
        input.decided_at === null
          ? null
          : toIsoTimestamp(input.decided_at);
    }

    const rows = await this.operation("Create Telegram review session", () =>
      this.database
        .insert(telegramReviewSessions)
        .values(values)
        .returning(reviewSessionSelection),
    );
    return mapTelegramReviewSessionRow(
      this.one(rows, "Create Telegram review session") as TelegramReviewSessionDatabaseRow,
    );
  }

  async findTelegramReviewSessionByDraft(
    draftId: string,
  ): Promise<TelegramReviewSessionRow | null> {
    const operation = "Find Telegram review session by draft";
    const rows = await this.operation(operation, () =>
      this.database
        .select(reviewSessionSelection)
        .from(telegramReviewSessions)
        .where(eq(telegramReviewSessions.draftId, draftId))
        .limit(2),
    );
    return optionalSession(
      this.optionalOne(
        rows as TelegramReviewSessionDatabaseRow[],
        operation,
      ),
    );
  }

  async renewTelegramReviewSession({
    draftId,
    expiresAt,
  }: RenewTelegramReviewSessionInput): Promise<TelegramReviewSessionRow | null> {
    const rows = await this.functionRows(
      "Renew Telegram review session",
      renewTelegramReviewSessionFunction,
      [draftId, expiresAt],
    );
    return optionalSession(
      this.optionalOne(rows, "Renew Telegram review session"),
    );
  }

  async rebindTelegramReviewSession({
    draftId,
    controlChatId,
    expectedPreviewMessageId,
    previewMessageId,
    expiresAt,
  }: RebindTelegramReviewSessionInput): Promise<TelegramReviewSessionRow | null> {
    const rows = await this.functionRows(
      "Rebind Telegram review session",
      rebindTelegramReviewSessionFunction,
      [
        draftId,
        controlChatId,
        expectedPreviewMessageId,
        previewMessageId,
        expiresAt,
      ],
    );
    return optionalSession(
      this.optionalOne(rows, "Rebind Telegram review session"),
    );
  }

  async decideTelegramReviewSession({
    sessionId,
    action,
    chatId,
    messageId,
    actorId,
  }: DecideTelegramReviewSessionInput): Promise<TelegramReviewDecisionRow> {
    const rows = await this.functionRows(
      "Decide Telegram review session",
      decideTelegramReviewSessionFunction,
      [sessionId, action, chatId, messageId, actorId],
    );
    return mapTelegramReviewDecisionRow(
      this.one(rows, "Decide Telegram review session"),
    );
  }
}
