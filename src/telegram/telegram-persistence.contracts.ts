import type { JsonObject } from "../database/schema/common.js";

export type TelegramUpdateClaimStatus = "claimed" | "busy" | "terminal";
export type TelegramUpdateTerminalStatus = "completed" | "failed";
export type TelegramUpdateFailureStatus =
  | "completed"
  | "failed"
  | "processing"
  | "quarantined";
export type TelegramReviewDecision = "publish" | "reject";
export type TelegramNewsCheckpointStatus =
  | "review_ready"
  | "published"
  | "blocked_by_policy"
  | "no_candidates";

export type TelegramUpdateClaimRow = {
  claimed: boolean;
  claim_token: string | null;
  claim_status: TelegramUpdateClaimStatus;
};

export type TelegramUpdateFailureRow = {
  attempt_count: number;
  terminal: boolean;
  failure_status: TelegramUpdateFailureStatus;
  recorded: boolean;
};

export type TelegramNewsCheckpointRow = {
  update_id: number;
  status: TelegramNewsCheckpointStatus;
  draft_id: string | null;
  preview: string | null;
  window_hours: number | null;
  created_at: string;
  updated_at: string;
  publication_message_id: number | null;
  settings_snapshot: JsonObject;
};

export type TelegramReviewSessionRow = {
  id: string;
  draft_id: string;
  telegram_channel_id: string | null;
  control_chat_id: number;
  preview_message_id: number;
  requested_by: number;
  decision: TelegramReviewDecision | null;
  decided_by: number | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
};

export type TelegramReviewDecisionRow = {
  session_id: string;
  draft_id: string;
  decision: TelegramReviewDecision;
  decision_won: boolean;
  expires_at: string;
};

export type ClaimTelegramUpdateInput = {
  updateId: number;
  updateKind: string;
  staleAfterSeconds?: number;
};

export type FinishTelegramUpdateInput = {
  updateId: number;
  claimToken: string;
  status: TelegramUpdateTerminalStatus;
  errorCode?: string | null;
};

export type RecordTelegramUpdateFailureInput = {
  updateId: number;
  updateKind: string;
  errorCode: string;
  maxAttempts?: number;
  terminal?: boolean;
  claimToken?: string | null;
};

export type SaveTelegramNewsCheckpointInput = {
  update_id: number;
  status?: TelegramNewsCheckpointStatus;
  draft_id?: string | null;
  preview?: string | null;
  window_hours?: number | null;
  publication_message_id?: number | null;
  settings_snapshot?: JsonObject;
  updated_at?: string | Date;
};

export type CreateTelegramReviewSessionInput = {
  id: string;
  draft_id: string;
  telegram_channel_id?: string | null;
  control_chat_id: number;
  preview_message_id: number;
  requested_by: number;
  decision?: TelegramReviewDecision | null;
  decided_by?: number | null;
  decided_at?: string | Date | null;
  expires_at: string | Date;
};

export type RenewTelegramReviewSessionInput = {
  draftId: string;
  expiresAt: string | Date;
};

export type RebindTelegramReviewSessionInput = {
  draftId: string;
  controlChatId: number;
  expectedPreviewMessageId: number;
  previewMessageId: number;
  expiresAt: string | Date;
};

export type DecideTelegramReviewSessionInput = {
  sessionId: string;
  action: TelegramReviewDecision;
  chatId: number;
  messageId: number;
  actorId: number;
};

export interface TelegramUpdatesPersistence {
  claimTelegramUpdate(
    input: ClaimTelegramUpdateInput,
  ): Promise<TelegramUpdateClaimRow>;
  finishTelegramUpdate(input: FinishTelegramUpdateInput): Promise<boolean>;
  recordTelegramUpdateFailure(
    input: RecordTelegramUpdateFailureInput,
  ): Promise<TelegramUpdateFailureRow>;
}

export interface TelegramCheckpointsPersistence {
  getTelegramNewsCheckpoint(
    updateId: number,
  ): Promise<TelegramNewsCheckpointRow | null>;
  saveTelegramNewsCheckpoint(
    input: SaveTelegramNewsCheckpointInput,
  ): Promise<TelegramNewsCheckpointRow>;
}

export interface TelegramReviewSessionsPersistence {
  hasPendingTelegramReview(channelId: string): Promise<boolean>;
  createTelegramReviewSession(
    input: CreateTelegramReviewSessionInput,
  ): Promise<TelegramReviewSessionRow>;
  findTelegramReviewSessionByDraft(
    draftId: string,
  ): Promise<TelegramReviewSessionRow | null>;
  renewTelegramReviewSession(
    input: RenewTelegramReviewSessionInput,
  ): Promise<TelegramReviewSessionRow | null>;
  rebindTelegramReviewSession(
    input: RebindTelegramReviewSessionInput,
  ): Promise<TelegramReviewSessionRow | null>;
  decideTelegramReviewSession(
    input: DecideTelegramReviewSessionInput,
  ): Promise<TelegramReviewDecisionRow>;
}
