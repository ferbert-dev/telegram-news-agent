import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import type {
  ClaimDueNewsScheduleInput,
  DeferNewsScheduleForQuietHoursInput,
  FinishNewsScheduleInput,
  PauseNewsScheduleUnresolvedInput,
  RenewNewsScheduleClaimInput,
  SaveNewsScheduleDraftInput,
  SaveNewsSchedulePublicationInput,
  SchedulerPersistence,
} from "../../scheduler/scheduler-persistence.contracts.js";
import {
  mapNewsSettingsRow,
  type NewsSettingsDatabaseRow,
} from "../../settings/settings-row-mappers.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import {
  postgresRows,
  postgresScalar,
  RepositorySupport,
} from "./repository-support.js";

const claimDueNewsScheduleFunction =
  postgresRows<NewsSettingsDatabaseRow>(
    "public.claim_due_news_schedule",
    2,
  );
const saveNewsScheduleDraftFunction = postgresScalar<boolean>(
  "public.save_news_schedule_draft",
  5,
);
const saveNewsSchedulePublicationFunction = postgresScalar<boolean>(
  "public.save_news_schedule_publication",
  4,
);
const renewNewsScheduleClaimFunction = postgresScalar<boolean>(
  "public.renew_news_schedule_claim",
  2,
);
const deferNewsScheduleForQuietHoursFunction = postgresScalar<boolean>(
  "public.defer_news_schedule_for_quiet_hours",
  2,
);
const pauseNewsScheduleUnresolvedFunction = postgresScalar<boolean>(
  "public.pause_news_schedule_unresolved",
  3,
);
const finishNewsScheduleFunction = postgresScalar<boolean>(
  "public.finish_news_schedule",
  4,
);

@Injectable()
export class SchedulerRepository
  extends RepositorySupport
  implements SchedulerPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async claimDueNewsSchedule({
    claimToken,
    staleAfterSeconds = 1800,
  }: ClaimDueNewsScheduleInput) {
    const rows = await this.functionRows(
      "Claim due news schedule",
      claimDueNewsScheduleFunction,
      [claimToken, staleAfterSeconds],
    );
    const row = this.optionalOne(rows, "Claim due news schedule");
    return row === null ? null : mapNewsSettingsRow(row);
  }

  saveNewsScheduleDraft({
    channelId,
    claimToken,
    draftId,
    preview,
    windowHours,
  }: SaveNewsScheduleDraftInput): Promise<boolean> {
    return this.functionScalar(
      "Save news schedule draft",
      saveNewsScheduleDraftFunction,
      [channelId, claimToken, draftId, preview, windowHours],
    );
  }

  saveNewsSchedulePublication({
    channelId,
    claimToken,
    draftId,
    publicationMessageId,
  }: SaveNewsSchedulePublicationInput): Promise<boolean> {
    return this.functionScalar(
      "Save news schedule publication",
      saveNewsSchedulePublicationFunction,
      [channelId, claimToken, draftId, publicationMessageId],
    );
  }

  renewNewsScheduleClaim({
    channelId,
    claimToken,
  }: RenewNewsScheduleClaimInput): Promise<boolean> {
    return this.functionScalar(
      "Renew news schedule claim",
      renewNewsScheduleClaimFunction,
      [channelId, claimToken],
    );
  }

  deferNewsScheduleForQuietHours({
    channelId,
    claimToken,
  }: DeferNewsScheduleForQuietHoursInput): Promise<boolean> {
    return this.functionScalar(
      "Defer news schedule for quiet hours",
      deferNewsScheduleForQuietHoursFunction,
      [channelId, claimToken],
    );
  }

  pauseNewsScheduleUnresolved({
    channelId,
    claimToken,
    errorCode,
  }: PauseNewsScheduleUnresolvedInput): Promise<boolean> {
    return this.functionScalar(
      "Pause unresolved news schedule",
      pauseNewsScheduleUnresolvedFunction,
      [channelId, claimToken, errorCode],
    );
  }

  finishNewsSchedule({
    channelId,
    claimToken,
    status,
    errorCode = null,
  }: FinishNewsScheduleInput): Promise<boolean> {
    return this.functionScalar(
      "Finish news schedule",
      finishNewsScheduleFunction,
      [channelId, claimToken, status, errorCode],
    );
  }
}
