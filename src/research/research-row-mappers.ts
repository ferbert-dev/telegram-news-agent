import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type {
  ArticleRow,
  ArticleStatus,
  ArticleTopicAssignmentSource,
  ArticleTopicRow,
  RawContentType,
  RawContentRow,
  SearchRunStatus,
  SearchRunRow,
} from "./research-persistence.contracts.js";

type DatabaseTimestamp = string | Date;

export type SearchRunDatabaseRow = Omit<
  SearchRunRow,
  "status" | "started_at" | "finished_at"
> & {
  status: string;
  started_at: DatabaseTimestamp;
  finished_at: DatabaseTimestamp | null;
};

export type ArticleDatabaseRow = Omit<
  ArticleRow,
  | "status"
  | "published_at"
  | "discovered_at"
  | "created_at"
  | "updated_at"
> & {
  status: string;
  published_at: DatabaseTimestamp | null;
  discovered_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

export type RawContentDatabaseRow = Omit<
  RawContentRow,
  "content_type" | "fetched_at" | "created_at"
> & {
  content_type: string;
  fetched_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
};

export type ArticleTopicDatabaseRow = Omit<
  ArticleTopicRow,
  "assignment_source" | "created_at"
> & {
  assignment_source: string;
  created_at: DatabaseTimestamp;
};

function searchRunStatus(value: string): SearchRunStatus {
  if (value !== "running" && value !== "completed" && value !== "failed") {
    throw new Error("Invalid search run status");
  }
  return value;
}

function articleStatus(value: string): ArticleStatus {
  if (
    value !== "discovered" &&
    value !== "extracted" &&
    value !== "reviewed" &&
    value !== "drafted" &&
    value !== "approved" &&
    value !== "published" &&
    value !== "rejected" &&
    value !== "failed"
  ) {
    throw new Error("Invalid article status");
  }
  return value;
}

function rawContentType(value: string): RawContentType {
  if (
    value !== "text" &&
    value !== "html" &&
    value !== "markdown" &&
    value !== "json"
  ) {
    throw new Error("Invalid raw content type");
  }
  return value;
}

function articleTopicAssignmentSource(
  value: string,
): ArticleTopicAssignmentSource {
  if (value !== "ai" && value !== "manual" && value !== "rule") {
    throw new Error("Invalid article topic assignment source");
  }
  return value;
}

export function mapSearchRunRow(row: SearchRunDatabaseRow): SearchRunRow {
  return {
    ...row,
    status: searchRunStatus(row.status),
    started_at: toIsoTimestamp(row.started_at),
    finished_at: toNullableIsoTimestamp(row.finished_at),
  };
}

export function mapArticleRow(row: ArticleDatabaseRow): ArticleRow {
  return {
    ...row,
    status: articleStatus(row.status),
    published_at: toNullableIsoTimestamp(row.published_at),
    discovered_at: toIsoTimestamp(row.discovered_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

export function mapRawContentRow(
  row: RawContentDatabaseRow,
): RawContentRow {
  return {
    ...row,
    content_type: rawContentType(row.content_type),
    fetched_at: toIsoTimestamp(row.fetched_at),
    created_at: toIsoTimestamp(row.created_at),
  };
}

export function mapArticleTopicRow(
  row: ArticleTopicDatabaseRow,
): ArticleTopicRow {
  return {
    ...row,
    assignment_source: articleTopicAssignmentSource(row.assignment_source),
    created_at: toIsoTimestamp(row.created_at),
  };
}
