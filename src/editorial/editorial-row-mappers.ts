import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type { ArticleDatabaseRow } from "../research/research-row-mappers.js";
import { mapArticleRow } from "../research/research-row-mappers.js";
import type {
  DraftListRow,
  DraftRow,
  DraftStatus,
  DraftWithArticleRow,
  PublishedPostRow,
} from "./editorial-persistence.contracts.js";

type DatabaseTimestamp = string | Date;
type DatabaseBigint = string | number;

export type DraftDatabaseRow = Omit<
  DraftRow,
  "status" | "approved_at" | "created_at" | "updated_at"
> & {
  status: string;
  approved_at: DatabaseTimestamp | null;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

export type DraftWithArticleDatabaseRow = DraftDatabaseRow & {
  articles: ArticleDatabaseRow;
};

export type DraftListDatabaseRow = Omit<
  DraftListRow,
  "status" | "created_at"
> & {
  status: string;
  created_at: DatabaseTimestamp;
};

export type PublishedPostDatabaseRow = Omit<
  PublishedPostRow,
  "telegram_message_id" | "published_at" | "created_at"
> & {
  telegram_message_id: DatabaseBigint;
  published_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
};

function draftStatus(value: string): DraftStatus {
  if (
    value !== "draft" &&
    value !== "review" &&
    value !== "approved" &&
    value !== "publishing" &&
    value !== "rejected" &&
    value !== "published"
  ) {
    throw new Error("Invalid draft status");
  }
  return value;
}

function safeBigint(value: DatabaseBigint, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return parsed;
}

export function mapDraftRow(row: DraftDatabaseRow): DraftRow {
  return {
    ...row,
    status: draftStatus(row.status),
    approved_at: toNullableIsoTimestamp(row.approved_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

export function mapDraftWithArticleRow(
  row: DraftWithArticleDatabaseRow,
): DraftWithArticleRow {
  return {
    ...mapDraftRow(row),
    articles: mapArticleRow(row.articles),
  };
}

export function mapDraftListRow(
  row: DraftListDatabaseRow,
): DraftListRow {
  return {
    id: row.id,
    article_id: row.article_id,
    body: row.body,
    status: draftStatus(row.status),
    created_at: toIsoTimestamp(row.created_at),
    articles: row.articles,
  };
}

export function mapPublishedPostRow(
  row: PublishedPostDatabaseRow,
): PublishedPostRow {
  return {
    ...row,
    telegram_message_id: safeBigint(
      row.telegram_message_id,
      "telegram_message_id",
    ),
    published_at: toIsoTimestamp(row.published_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}
