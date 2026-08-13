import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type {
  NewsFeatureFlagRow,
  NewsSettingsRow,
  TelegramSettingsInputRow,
} from "./settings.contracts.js";

type DatabaseBigint = number | string;
type DatabaseTimestamp = Date | string;

export type NewsSettingsDatabaseRow = Omit<
  NewsSettingsRow,
  | "review_chat_id"
  | "updated_by"
  | "schedule_publication_message_id"
  | "next_run_at"
  | "schedule_claimed_at"
  | "schedule_run_due_at"
  | "last_run_at"
  | "created_at"
  | "updated_at"
  | "language_code"
  | "approval_policy"
> & {
  review_chat_id: DatabaseBigint;
  updated_by: DatabaseBigint;
  schedule_publication_message_id: DatabaseBigint | null;
  next_run_at: DatabaseTimestamp | null;
  schedule_claimed_at: DatabaseTimestamp | null;
  schedule_run_due_at: DatabaseTimestamp | null;
  last_run_at: DatabaseTimestamp | null;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  language_code: string;
  approval_policy: string;
};

export type NewsFeatureFlagDatabaseRow = Omit<
  NewsFeatureFlagRow,
  | "updated_by"
  | "created_at"
  | "updated_at"
  | "feature_key"
  | "state"
> & {
  updated_by: DatabaseBigint;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  feature_key: string;
  state: string;
};

export type TelegramSettingsInputDatabaseRow = Omit<
  TelegramSettingsInputRow,
  | "control_chat_id"
  | "requested_by"
  | "prompt_message_id"
  | "expires_at"
  | "created_at"
> & {
  control_chat_id: DatabaseBigint;
  requested_by: DatabaseBigint;
  prompt_message_id: DatabaseBigint;
  expires_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
};

function safeBigint(value: DatabaseBigint, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return parsed;
}

function nullableSafeBigint(
  value: DatabaseBigint | null,
  field: string,
): number | null {
  return value === null ? null : safeBigint(value, field);
}

function newsLanguageCode(value: string): NewsSettingsRow["language_code"] {
  if (value !== "en" && value !== "uk" && value !== "de") {
    throw new Error("Invalid news settings language code");
  }
  return value;
}

function newsApprovalPolicy(
  value: string,
): NewsSettingsRow["approval_policy"] {
  if (value !== "manual" && value !== "automatic") {
    throw new Error("Invalid news settings approval policy");
  }
  return value;
}

function newsFeatureKey(value: string): NewsFeatureFlagRow["feature_key"] {
  if (value !== "article_tags" && value !== "editorial_enrichment") {
    throw new Error("Invalid news feature key");
  }
  return value;
}

function newsFeatureState(value: string): NewsFeatureFlagRow["state"] {
  if (value !== "off" && value !== "collect" && value !== "enabled") {
    throw new Error("Invalid news feature state");
  }
  return value;
}

export function mapNewsSettingsRow(
  row: NewsSettingsDatabaseRow,
): NewsSettingsRow {
  return {
    telegram_channel_id: row.telegram_channel_id,
    review_chat_id: safeBigint(row.review_chat_id, "review_chat_id"),
    schedule_interval_minutes: row.schedule_interval_minutes,
    language_code: newsLanguageCode(row.language_code),
    topic_codes: row.topic_codes,
    custom_topics: row.custom_topics,
    excluded_topic_codes: row.excluded_topic_codes,
    approval_policy: newsApprovalPolicy(row.approval_policy),
    next_run_at: toNullableIsoTimestamp(row.next_run_at),
    version: row.version,
    updated_by: safeBigint(row.updated_by, "updated_by"),
    schedule_claim_token: row.schedule_claim_token,
    schedule_claimed_at: toNullableIsoTimestamp(row.schedule_claimed_at),
    schedule_run_id: row.schedule_run_id,
    schedule_run_due_at: toNullableIsoTimestamp(row.schedule_run_due_at),
    schedule_settings_snapshot: row.schedule_settings_snapshot,
    schedule_draft_id: row.schedule_draft_id,
    schedule_preview: row.schedule_preview,
    schedule_window_hours: row.schedule_window_hours,
    schedule_publication_message_id: nullableSafeBigint(
      row.schedule_publication_message_id,
      "schedule_publication_message_id",
    ),
    last_run_at: toNullableIsoTimestamp(row.last_run_at),
    last_run_status: row.last_run_status,
    last_error_code: row.last_error_code,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    quiet_hours_enabled: row.quiet_hours_enabled,
  };
}

export function mapNewsFeatureFlagRow(
  row: NewsFeatureFlagDatabaseRow,
): NewsFeatureFlagRow {
  return {
    telegram_channel_id: row.telegram_channel_id,
    feature_key: newsFeatureKey(row.feature_key),
    state: newsFeatureState(row.state),
    config: row.config,
    version: row.version,
    updated_by: safeBigint(row.updated_by, "updated_by"),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

export function mapTelegramSettingsInputRow(
  row: TelegramSettingsInputDatabaseRow,
): TelegramSettingsInputRow {
  return {
    id: row.id,
    control_chat_id: safeBigint(row.control_chat_id, "control_chat_id"),
    requested_by: safeBigint(row.requested_by, "requested_by"),
    prompt_message_id: safeBigint(row.prompt_message_id, "prompt_message_id"),
    expires_at: toIsoTimestamp(row.expires_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}
