import type { NewsLanguageCode } from "../settings/settings.contracts.js";
import type {
  PublicationMilestoneRow,
  PublicationMilestoneState,
} from "./publication-milestones.contracts.js";

export type PublicationMilestoneDatabaseRow = {
  id: string;
  telegram_channel_id: string;
  ordinal: number;
  published_post_id: string;
  language_code: string;
  editor_name: string;
  state: string;
  claim_token: string | null;
  telegram_message_id: string | number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  claimed_at: string | Date | null;
  sent_at: string | Date | null;
  failed_at: string | Date | null;
  uncertain_at: string | Date | null;
};

function asLanguageCode(value: string): NewsLanguageCode {
  if (value === "en" || value === "uk" || value === "de") return value;
  throw new Error("Invalid publication milestone language code");
}

function asState(value: string): PublicationMilestoneState {
  if (
    value === "pending" ||
    value === "sending" ||
    value === "sent" ||
    value === "failed" ||
    value === "uncertain"
  ) {
    return value;
  }
  throw new Error("Invalid publication milestone state");
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid publication milestone timestamp");
  }
  return parsed.toISOString();
}

function toSafeInteger(
  value: string | number | null,
  field: string,
): number | null {
  if (value === null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return numeric;
}

export function mapPublicationMilestoneRow(
  row: PublicationMilestoneDatabaseRow,
): PublicationMilestoneRow {
  return {
    id: row.id,
    telegram_channel_id: row.telegram_channel_id,
    ordinal: row.ordinal,
    published_post_id: row.published_post_id,
    language_code: asLanguageCode(row.language_code),
    editor_name: row.editor_name,
    state: asState(row.state),
    claim_token: row.claim_token,
    telegram_message_id: toSafeInteger(
      row.telegram_message_id,
      "telegram_message_id",
    ),
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    created_at: toIso(row.created_at) ?? "",
    updated_at: toIso(row.updated_at) ?? "",
    claimed_at: toIso(row.claimed_at),
    sent_at: toIso(row.sent_at),
    failed_at: toIso(row.failed_at),
    uncertain_at: toIso(row.uncertain_at),
  };
}
