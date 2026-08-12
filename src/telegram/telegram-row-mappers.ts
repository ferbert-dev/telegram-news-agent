import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type {
  TelegramNewsCheckpointRow,
  TelegramNewsCheckpointStatus,
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
    value !== "no_candidates"
  ) {
    throw new Error("Invalid Telegram news checkpoint status");
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
