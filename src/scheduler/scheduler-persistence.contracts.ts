import type { NewsSettingsRow } from "../settings/settings.contracts.js";

export type ClaimDueNewsScheduleInput = {
  claimToken: string;
  staleAfterSeconds?: number;
};

export type SaveNewsScheduleDraftInput = {
  channelId: string;
  claimToken: string;
  draftId: string;
  preview: string;
  windowHours: number;
};

export type SaveNewsSchedulePublicationInput = {
  channelId: string;
  claimToken: string;
  draftId: string;
  publicationMessageId: number;
};

export type RenewNewsScheduleClaimInput = {
  channelId: string;
  claimToken: string;
};

export type DeferNewsScheduleForQuietHoursInput = {
  channelId: string;
  claimToken: string;
};

export type PauseNewsScheduleUnresolvedInput = {
  channelId: string;
  claimToken: string;
  errorCode: string;
};

export type FinishNewsScheduleInput = {
  channelId: string;
  claimToken: string;
  status: string;
  errorCode?: string | null;
};

/**
 * Scheduler persistence boundary. All seven paths retain their PostgreSQL
 * functions because they fence claims, checkpoints, recurrence and recovery.
 */
export interface SchedulerPersistence {
  claimDueNewsSchedule(
    input: ClaimDueNewsScheduleInput,
  ): Promise<NewsSettingsRow | null>;
  saveNewsScheduleDraft(
    input: SaveNewsScheduleDraftInput,
  ): Promise<boolean>;
  saveNewsSchedulePublication(
    input: SaveNewsSchedulePublicationInput,
  ): Promise<boolean>;
  renewNewsScheduleClaim(
    input: RenewNewsScheduleClaimInput,
  ): Promise<boolean>;
  deferNewsScheduleForQuietHours(
    input: DeferNewsScheduleForQuietHoursInput,
  ): Promise<boolean>;
  pauseNewsScheduleUnresolved(
    input: PauseNewsScheduleUnresolvedInput,
  ): Promise<boolean>;
  finishNewsSchedule(input: FinishNewsScheduleInput): Promise<boolean>;
}
