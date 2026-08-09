import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import { RepositorySupport, toIsoTimestamp } from "../database/repositories/repository-support.js";
import { telegramNewsRequestCheckpoints } from "../database/schema/telegram.js";
import type {
  SaveTelegramNewsCheckpointInput,
  TelegramCheckpointsPersistence,
  TelegramNewsCheckpointRow,
} from "./telegram-persistence.contracts.js";
import {
  mapTelegramNewsCheckpointRow,
  type TelegramNewsCheckpointDatabaseRow,
} from "./telegram-row-mappers.js";

const checkpointSelection = {
  update_id: telegramNewsRequestCheckpoints.updateId,
  status: telegramNewsRequestCheckpoints.status,
  draft_id: telegramNewsRequestCheckpoints.draftId,
  preview: telegramNewsRequestCheckpoints.preview,
  window_hours: telegramNewsRequestCheckpoints.windowHours,
  created_at: telegramNewsRequestCheckpoints.createdAt,
  updated_at: telegramNewsRequestCheckpoints.updatedAt,
  publication_message_id:
    telegramNewsRequestCheckpoints.publicationMessageId,
  settings_snapshot: telegramNewsRequestCheckpoints.settingsSnapshot,
};

@Injectable()
export class TelegramCheckpointsRepository
  extends RepositorySupport
  implements TelegramCheckpointsPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async getTelegramNewsCheckpoint(
    updateId: number,
  ): Promise<TelegramNewsCheckpointRow | null> {
    const operation = "Get Telegram news checkpoint";
    const rows = await this.operation(operation, () =>
      this.database
        .select(checkpointSelection)
        .from(telegramNewsRequestCheckpoints)
        .where(eq(telegramNewsRequestCheckpoints.updateId, updateId))
        .limit(2),
    );
    const row = this.optionalOne(rows, operation);
    return row === null
      ? null
      : mapTelegramNewsCheckpointRow(
          row as TelegramNewsCheckpointDatabaseRow,
        );
  }

  async saveTelegramNewsCheckpoint(
    input: SaveTelegramNewsCheckpointInput,
  ): Promise<TelegramNewsCheckpointRow> {
    const values: Partial<typeof telegramNewsRequestCheckpoints.$inferInsert> & {
      updateId: number;
    } = {
      updateId: input.update_id,
    };
    const updates: Partial<
      typeof telegramNewsRequestCheckpoints.$inferInsert
    > = {};

    if (input.status !== undefined) {
      values.status = input.status;
      updates.status = input.status;
    }
    if (input.draft_id !== undefined) {
      values.draftId = input.draft_id;
      updates.draftId = input.draft_id;
    }
    if (input.preview !== undefined) {
      values.preview = input.preview;
      updates.preview = input.preview;
    }
    if (input.window_hours !== undefined) {
      values.windowHours = input.window_hours;
      updates.windowHours = input.window_hours;
    }
    if (input.publication_message_id !== undefined) {
      values.publicationMessageId = input.publication_message_id;
      updates.publicationMessageId = input.publication_message_id;
    }
    if (input.settings_snapshot !== undefined) {
      values.settingsSnapshot = input.settings_snapshot;
      updates.settingsSnapshot = input.settings_snapshot;
    }
    if (input.updated_at !== undefined) {
      const updatedAt = toIsoTimestamp(input.updated_at);
      values.updatedAt = updatedAt;
      updates.updatedAt = updatedAt;
    }

    const updateEntries = Object.entries(updates);
    if (updateEntries.length === 0) {
      throw new Error(
        "Save Telegram news checkpoint failed: insufficient values were provided",
      );
    }

    const rows = await this.operation("Save Telegram news checkpoint", () =>
      this.database
        .insert(telegramNewsRequestCheckpoints)
        .values(
          values as typeof telegramNewsRequestCheckpoints.$inferInsert,
        )
        .onConflictDoUpdate({
          target: telegramNewsRequestCheckpoints.updateId,
          set: updates,
        })
        .returning(checkpointSelection),
    );
    return mapTelegramNewsCheckpointRow(
      this.one(rows, "Save Telegram news checkpoint") as TelegramNewsCheckpointDatabaseRow,
    );
  }
}
