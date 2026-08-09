import type { JsonObject } from "../database/schema/common.js";

export type SearchRunStatus = "running" | "completed" | "failed";

export type ArticleStatus =
  | "discovered"
  | "extracted"
  | "reviewed"
  | "drafted"
  | "approved"
  | "published"
  | "rejected"
  | "failed";

export type RawContentType = "text" | "html" | "markdown" | "json";

export type ArticleTopicAssignmentSource = "ai" | "manual" | "rule";

export type SearchRunRow = {
  id: string;
  query: string;
  status: SearchRunStatus;
  source_id: string | null;
  started_at: string;
  finished_at: string | null;
  result_count: number;
  error: string | null;
  metadata: JsonObject;
};

export type ArticleRow = {
  id: string;
  source_id: string | null;
  search_run_id: string | null;
  canonical_url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  content_hash: string | null;
  status: ArticleStatus;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
};

export type RawContentRow = {
  id: string;
  article_id: string;
  content: string;
  content_type: RawContentType;
  language_code: string | null;
  fetched_at: string;
  extractor: string | null;
  content_hash: string;
  metadata: JsonObject;
  created_at: string;
};

export type ArticleTopicRow = {
  article_id: string;
  topic_id: string;
  relevance_score: string | null;
  created_at: string;
  assignment_source: ArticleTopicAssignmentSource;
  assigned_model: string | null;
};

export type StartSearchRunInput = {
  query: string;
  sourceId?: string | null;
  metadata?: JsonObject;
};

export type FinishSearchRunInput = {
  resultCount: number;
  metadata?: JsonObject;
};

export type CreateOrResumeArticleCandidateInput = {
  source_id: string | null;
  search_run_id: string | null;
  canonical_url: string;
  title: string;
  author: string | null;
  published_at: string | Date | null;
  content_hash: string | null;
  status?: ArticleStatus;
  metadata?: JsonObject | null;
};

export type SaveRawContentInput = {
  article_id: string;
  content: string;
  content_type?: RawContentType;
  language_code?: string | null;
  fetched_at?: string | Date;
  extractor?: string | null;
  content_hash: string;
  metadata?: JsonObject;
};

type ArticleTransitionStringChanges = Partial<
  Pick<
    ArticleRow,
    | "source_id"
    | "search_run_id"
    | "canonical_url"
    | "title"
    | "author"
    | "content_hash"
    | "status"
    | "metadata"
    | "updated_at"
  >
>;

export type ArticleTransitionChanges = ArticleTransitionStringChanges & {
  published_at?: string | Date | null;
};

export type ArticleTopicAssignment = {
  code: string;
  confidence: number;
};

export type ReplaceArticleTopicsInput = {
  articleId: string;
  assignments: ArticleTopicAssignment[];
  assignmentSource?: ArticleTopicAssignmentSource;
  assignedModel?: string | null;
};

/**
 * Research ingestion persistence boundary. Candidate deduplication/resume and
 * topic replacement retain their atomic PostgreSQL functions; the other five
 * paths are ordinary typed Drizzle mutations with legacy DTO adapters.
 */
export interface ResearchIngestionPersistence {
  startSearchRun(input: StartSearchRunInput): Promise<SearchRunRow>;
  finishSearchRun(
    id: string,
    input: FinishSearchRunInput,
  ): Promise<SearchRunRow>;
  failSearchRun(id: string, error: unknown): Promise<SearchRunRow>;
  createOrResumeArticleCandidate(
    input: CreateOrResumeArticleCandidateInput,
  ): Promise<ArticleRow | null>;
  saveRawContent(input: SaveRawContentInput): Promise<RawContentRow>;
  transitionArticle(
    id: string,
    from: ArticleStatus,
    to: ArticleStatus,
    changes?: ArticleTransitionChanges,
  ): Promise<ArticleRow>;
  replaceArticleTopics(
    input: ReplaceArticleTopicsInput,
  ): Promise<ArticleTopicRow[]>;
}
