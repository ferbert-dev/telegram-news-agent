import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type {
  TelegramNewsCheckpointRow,
  TelegramNewsCheckpointStatus,
  TelegramNewsJobClaimRow,
  TelegramNewsJobEnqueueRow,
  TelegramNewsJobOutcomeStatus,
  TelegramNewsJobStateRow,
  TelegramNewsJobStatus,
  TelegramReviewDecision,
  TelegramReviewDecisionRow,
  TelegramReviewSessionRow,
  TelegramUpdateClaimRow,
  TelegramUpdateClaimStatus,
  TelegramUpdateFailureRow,
  TelegramUpdateFailureStatus,
} from "./telegram-persistence.contracts.js";

type DatabaseBigint = string | number;
type DatabaseTimestamp = string | Date;

export type TelegramUpdateClaimDatabaseRow = Omit<
  TelegramUpdateClaimRow,
  "claim_status"
> & { claim_status: string };

export type TelegramUpdateFailureDatabaseRow = Omit<
  TelegramUpdateFailureRow,
  "attempt_count" | "failure_status"
> & {
  attempt_count: string | number;
  failure_status: string;
};

export type TelegramNewsCheckpointDatabaseRow = Omit<
  TelegramNewsCheckpointRow,
  | "update_id"
  | "status"
  | "created_at"
  | "updated_at"
  | "publication_message_id"
> & {
  update_id: DatabaseBigint;
  status: string;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  publication_message_id: DatabaseBigint | null;
};

export type TelegramNewsJobEnqueueDatabaseRow = Omit<
  TelegramNewsJobEnqueueRow,
  "enqueue_outcome" | "job_status"
> & {
  enqueue_outcome: string;
  job_status: string;
};

export type TelegramNewsJobClaimDatabaseRow = Omit<
  TelegramNewsJobClaimRow,
  | "request_update_id"
  | "control_chat_id"
  | "requested_by"
  | "claim_phase"
  | "outcome_status"
  | "publication_message_id"
  | "execution_attempt_count"
  | "delivery_attempt_count"
> & {
  request_update_id: DatabaseBigint;
  control_chat_id: DatabaseBigint;
  requested_by: DatabaseBigint;
  claim_phase: string;
  outcome_status: string | null;
  publication_message_id: DatabaseBigint | null;
  execution_attempt_count: string | number;
  delivery_attempt_count: string | number;
};

export type TelegramNewsJobStateDatabaseRow = Omit<
  TelegramNewsJobStateRow,
  | "status"
  | "outcome_status"
  | "publication_message_id"
  | "execution_attempt_count"
  | "delivery_attempt_count"
> & {
  status: string;
  outcome_status: string | null;
  publication_message_id: DatabaseBigint | null;
  execution_attempt_count: string | number;
  delivery_attempt_count: string | number;
};

export type TelegramReviewSessionDatabaseRow = Omit<
  TelegramReviewSessionRow,
  | "control_chat_id"
  | "preview_message_id"
  | "requested_by"
  | "decision"
  | "decided_by"
  | "decided_at"
  | "expires_at"
  | "created_at"
> & {
  control_chat_id: DatabaseBigint;
  preview_message_id: DatabaseBigint;
  requested_by: DatabaseBigint;
  decision: string | null;
  decided_by: DatabaseBigint | null;
  decided_at: DatabaseTimestamp | null;
  expires_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
};

export type TelegramReviewDecisionDatabaseRow = Omit<
  TelegramReviewDecisionRow,
  "decision" | "expires_at"
> & {
  decision: string;
  expires_at: DatabaseTimestamp;
};

function safeBigint(value: DatabaseBigint, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return parsed;
}

function optionalSafeBigint(
  value: DatabaseBigint | null,
  field: string,
): number | null {
  return value === null ? null : safeBigint(value, field);
}

function claimStatus(value: string): TelegramUpdateClaimStatus {
  if (value !== "claimed" && value !== "busy" && value !== "terminal") {
    throw new Error("Invalid Telegram update claim status");
  }
  return value;
}

function failureStatus(value: string): TelegramUpdateFailureStatus {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "processing" &&
    value !== "quarantined"
  ) {
    throw new Error("Invalid Telegram update failure status");
  }
  return value;
}

function checkpointStatus(value: string): TelegramNewsCheckpointStatus {
  if (
    value !== "review_ready" &&
    value !== "published" &&
    value !== "blocked_by_policy" &&
    value !== "no_candidates"
  ) {
    throw new Error("Invalid Telegram news checkpoint status");
  }
  return value;
}

function jobStatus(value: string): TelegramNewsJobStatus {
  if (
    value !== "queued" &&
    value !== "processing" &&
    value !== "outcome_ready" &&
    value !== "delivering" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "suppressed"
  ) {
    throw new Error("Invalid Telegram news job status");
  }
  return value;
}

function jobOutcomeStatus(value: string): TelegramNewsJobOutcomeStatus {
  if (
    value !== "review_ready" &&
    value !== "published" &&
    value !== "no_candidates" &&
    value !== "blocked_by_policy" &&
    value !== "failed" &&
    value !== "already_running"
  ) {
    throw new Error("Invalid Telegram news job outcome status");
  }
  return value;
}

function reviewDecision(value: string): TelegramReviewDecision {
  if (value !== "publish" && value !== "reject") {
    throw new Error("Invalid Telegram review decision");
  }
  return value;
}

export function mapTelegramUpdateClaimRow(
  row: TelegramUpdateClaimDatabaseRow,
): TelegramUpdateClaimRow {
  return { ...row, claim_status: claimStatus(row.claim_status) };
}

export function mapTelegramUpdateFailureRow(
  row: TelegramUpdateFailureDatabaseRow,
): TelegramUpdateFailureRow {
  return {
    ...row,
    attempt_count: safeBigint(row.attempt_count, "attempt_count"),
    failure_status: failureStatus(row.failure_status),
  };
}

export function mapTelegramNewsCheckpointRow(
  row: TelegramNewsCheckpointDatabaseRow,
): TelegramNewsCheckpointRow {
  return {
    ...row,
    update_id: safeBigint(row.update_id, "update_id"),
    status: checkpointStatus(row.status),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    publication_message_id: optionalSafeBigint(
      row.publication_message_id,
      "publication_message_id",
    ),
  };
}

export function mapTelegramNewsJobEnqueueRow(
  row: TelegramNewsJobEnqueueDatabaseRow,
): TelegramNewsJobEnqueueRow {
  if (
    row.enqueue_outcome !== "queued" &&
    row.enqueue_outcome !== "already_running"
  ) {
    throw new Error("Invalid Telegram news job enqueue outcome");
  }
  return {
    ...row,
    enqueue_outcome: row.enqueue_outcome,
    job_status: jobStatus(row.job_status),
  };
}

export function mapTelegramNewsJobClaimRow(
  row: TelegramNewsJobClaimDatabaseRow,
): TelegramNewsJobClaimRow {
  if (row.claim_phase !== "execute" && row.claim_phase !== "deliver") {
    throw new Error("Invalid Telegram news job claim phase");
  }
  return {
    ...row,
    request_update_id: safeBigint(row.request_update_id, "request_update_id"),
    control_chat_id: safeBigint(row.control_chat_id, "control_chat_id"),
    requested_by: safeBigint(row.requested_by, "requested_by"),
    claim_phase: row.claim_phase,
    outcome_status:
      row.outcome_status === null ? null : jobOutcomeStatus(row.outcome_status),
    publication_message_id: optionalSafeBigint(
      row.publication_message_id,
      "publication_message_id",
    ),
    execution_attempt_count: safeBigint(
      row.execution_attempt_count,
      "execution_attempt_count",
    ),
    delivery_attempt_count: safeBigint(
      row.delivery_attempt_count,
      "delivery_attempt_count",
    ),
  };
}

export function mapTelegramNewsJobStateRow(
  row: TelegramNewsJobStateDatabaseRow,
): TelegramNewsJobStateRow {
  return {
    id: row.id,
    status: jobStatus(row.status),
    outcome_status:
      row.outcome_status === null ? null : jobOutcomeStatus(row.outcome_status),
    draft_id: row.draft_id,
    publication_message_id: optionalSafeBigint(
      row.publication_message_id,
      "publication_message_id",
    ),
    error_code: row.error_code,
    execution_attempt_count: safeBigint(
      row.execution_attempt_count,
      "execution_attempt_count",
    ),
    delivery_attempt_count: safeBigint(
      row.delivery_attempt_count,
      "delivery_attempt_count",
    ),
  };
}

export function mapTelegramReviewSessionRow(
  row: TelegramReviewSessionDatabaseRow,
): TelegramReviewSessionRow {
  return {
    ...row,
    control_chat_id: safeBigint(row.control_chat_id, "control_chat_id"),
    preview_message_id: safeBigint(
      row.preview_message_id,
      "preview_message_id",
    ),
    requested_by: safeBigint(row.requested_by, "requested_by"),
    decision: row.decision === null ? null : reviewDecision(row.decision),
    decided_by: optionalSafeBigint(row.decided_by, "decided_by"),
    decided_at: toNullableIsoTimestamp(row.decided_at),
    expires_at: toIsoTimestamp(row.expires_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

export function mapTelegramReviewDecisionRow(
  row: TelegramReviewDecisionDatabaseRow,
): TelegramReviewDecisionRow {
  return {
    ...row,
    decision: reviewDecision(row.decision),
    expires_at: toIsoTimestamp(row.expires_at),
  };
}
