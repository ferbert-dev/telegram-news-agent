import type { JsonObject } from "../database/schema/common.js";

export type TelegramUpdateClaimStatus = "claimed" | "busy" | "terminal";
export type TelegramUpdateTerminalStatus = "completed" | "failed";
export type TelegramUpdateFailureStatus =
  "completed" | "failed" | "processing" | "quarantined";
export type TelegramReviewDecision = "publish" | "reject";
export type TelegramNewsCheckpointStatus =
  "review_ready" | "published" | "blocked_by_policy" | "no_candidates";
export type TelegramNewsJobStatus =
  | "queued"
  | "processing"
  | "outcome_ready"
  | "delivering"
  | "completed"
  | "failed"
  | "suppressed";
export type TelegramNewsJobOutcomeStatus =
  | "review_ready"
  | "published"
  | "no_candidates"
  | "blocked_by_policy"
  | "failed"
  | "already_running";

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

export type TelegramNewsJobEnqueueRow = {
  id: string;
  enqueue_outcome: "queued" | "already_running";
  job_status: TelegramNewsJobStatus;
  active_job_id: string | null;
};

export type TelegramNewsJobClaimRow = {
  id: string;
  request_update_id: number;
  telegram_channel_id: string;
  control_chat_id: number;
  requested_by: number;
  settings_snapshot: JsonObject;
  claim_phase: "execute" | "deliver";
  claim_token: string;
  outcome_status: TelegramNewsJobOutcomeStatus | null;
  draft_id: string | null;
  publication_message_id: number | null;
  error_code: string | null;
  execution_attempt_count: number;
  delivery_attempt_count: number;
};

export type TelegramNewsJobStateRow = {
  id: string;
  status: TelegramNewsJobStatus;
  outcome_status: TelegramNewsJobOutcomeStatus | null;
  draft_id: string | null;
  publication_message_id: number | null;
  error_code: string | null;
  execution_attempt_count: number;
  delivery_attempt_count: number;
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

export type EnqueueTelegramNewsJobInput = {
  updateId: number;
  updateClaimToken: string;
  channelId: string;
  controlChatId: number;
  requestedBy: number;
  settingsSnapshot: JsonObject;
};

export type ClaimNextTelegramNewsJobInput = {
  claimToken: string;
  staleAfterSeconds?: number;
  maxExecutionAttempts?: number;
  maxDeliveryAttempts?: number;
};

export type TelegramNewsJobClaimIdentity = {
  jobId: string;
  claimToken: string;
};

export type RecordTelegramNewsJobOutcomeInput = TelegramNewsJobClaimIdentity & {
  outcomeStatus: Exclude<
    TelegramNewsJobOutcomeStatus,
    "already_running" | "failed"
  >;
  draftId?: string | null;
  publicationMessageId?: number | null;
  errorCode?: string | null;
};

export type RetryTelegramNewsJobInput = TelegramNewsJobClaimIdentity & {
  errorCode: string;
  maxAttempts?: number;
  terminal?: boolean;
};

export type RetryTelegramNewsJobDeliveryInput = TelegramNewsJobClaimIdentity & {
  errorCode: string;
  maxAttempts?: number;
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

export interface TelegramNewsJobsPersistence {
  enqueueTelegramNewsJob(
    input: EnqueueTelegramNewsJobInput,
  ): Promise<TelegramNewsJobEnqueueRow>;
  claimNextTelegramNewsJob(
    input: ClaimNextTelegramNewsJobInput,
  ): Promise<TelegramNewsJobClaimRow | null>;
  renewTelegramNewsJobClaim(
    input: TelegramNewsJobClaimIdentity,
  ): Promise<boolean>;
  recordTelegramNewsJobOutcome(
    input: RecordTelegramNewsJobOutcomeInput,
  ): Promise<TelegramNewsJobStateRow | null>;
  retryTelegramNewsJob(
    input: RetryTelegramNewsJobInput,
  ): Promise<TelegramNewsJobStateRow | null>;
  retryTelegramNewsJobDelivery(
    input: RetryTelegramNewsJobDeliveryInput,
  ): Promise<TelegramNewsJobStateRow | null>;
  completeTelegramNewsJob(
    input: TelegramNewsJobClaimIdentity,
  ): Promise<boolean>;
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
