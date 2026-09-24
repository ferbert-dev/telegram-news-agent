import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";

import { assertTransition } from "../../operations/domain/pipeline-states.js";
import type {
  ArticleRow,
  ArticleStatus,
  ArticleTopicRow,
  ArticleTransitionChanges,
  CreateOrResumeArticleCandidateInput,
  FinishSearchRunInput,
  RawContentRow,
  ReplaceArticleTopicsInput,
  ResearchIngestionPersistence,
  SaveRawContentInput,
  SearchRunRow,
  StartSearchRunInput,
} from "../../research/research-persistence.contracts.js";
import {
  mapArticleRow,
  mapArticleTopicRow,
  mapRawContentRow,
  mapSearchRunRow,
  type ArticleDatabaseRow,
  type ArticleTopicDatabaseRow,
} from "../../research/research-row-mappers.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import {
  articleTopics,
  articles,
  rawContents,
  searchRuns,
} from "../schema/research.js";
import {
  postgresRows,
  RepositorySupport,
  timestamp,
  toIsoTimestamp,
} from "./repository-support.js";

const searchRunSelection = {
  id: searchRuns.id,
  query: searchRuns.query,
  status: searchRuns.status,
  source_id: searchRuns.sourceId,
  started_at: searchRuns.startedAt,
  finished_at: searchRuns.finishedAt,
  result_count: searchRuns.resultCount,
  error: searchRuns.error,
  metadata: searchRuns.metadata,
};

const articleSelection = {
  id: articles.id,
  source_id: articles.sourceId,
  search_run_id: articles.searchRunId,
  canonical_url: articles.canonicalUrl,
  title: articles.title,
  author: articles.author,
  published_at: articles.publishedAt,
  discovered_at: articles.discoveredAt,
  content_hash: articles.contentHash,
  status: articles.status,
  metadata: articles.metadata,
  created_at: articles.createdAt,
  updated_at: articles.updatedAt,
};

const rawContentSelection = {
  id: rawContents.id,
  article_id: rawContents.articleId,
  content: rawContents.content,
  content_type: rawContents.contentType,
  language_code: rawContents.languageCode,
  fetched_at: rawContents.fetchedAt,
  extractor: rawContents.extractor,
  content_hash: rawContents.contentHash,
  metadata: rawContents.metadata,
  created_at: rawContents.createdAt,
};

const createOrResumeArticleCandidateFunction =
  postgresRows<ArticleDatabaseRow>(
    "public.create_or_resume_article_candidate",
    8,
  );
const replaceArticleTopicsFunction = postgresRows<ArticleTopicDatabaseRow>(
  "public.replace_article_topics",
  4,
);

@Injectable()
export class ResearchIngestionRepository
  extends RepositorySupport
  implements ResearchIngestionPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async startSearchRun({
    query,
    sourceId = null,
    metadata = {},
  }: StartSearchRunInput): Promise<SearchRunRow> {
    const rows = await this.operation("Start search run", () =>
      this.database
        .insert(searchRuns)
        .values({
          query,
          sourceId,
          metadata,
          status: "running",
        })
        .returning(searchRunSelection),
    );
    return mapSearchRunRow(this.one(rows, "Start search run"));
  }

  async finishSearchRun(
    id: string,
    { resultCount, metadata = {} }: FinishSearchRunInput,
  ): Promise<SearchRunRow> {
    const rows = await this.operation("Complete search run", () =>
      this.database
        .update(searchRuns)
        .set({
          status: "completed",
          resultCount,
          finishedAt: timestamp(),
          metadata,
        })
        .where(and(eq(searchRuns.id, id), eq(searchRuns.status, "running")))
        .returning(searchRunSelection),
    );
    return mapSearchRunRow(this.one(rows, "Complete search run"));
  }

  async failSearchRun(id: string, error: unknown): Promise<SearchRunRow> {
    const rows = await this.operation("Fail search run", () =>
      this.database
        .update(searchRuns)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: timestamp(),
        })
        .where(and(eq(searchRuns.id, id), eq(searchRuns.status, "running")))
        .returning(searchRunSelection),
    );
    return mapSearchRunRow(this.one(rows, "Fail search run"));
  }

  async createOrResumeArticleCandidate({
    source_id,
    search_run_id,
    canonical_url,
    title,
    author,
    published_at,
    content_hash,
    metadata,
  }: CreateOrResumeArticleCandidateInput): Promise<ArticleRow | null> {
    const rows = await this.functionRows(
      "Create or resume article candidate",
      createOrResumeArticleCandidateFunction,
      [
        source_id,
        search_run_id,
        canonical_url,
        title,
        author,
        published_at,
        content_hash,
        metadata ?? {},
      ],
    );
    const row = this.optionalOne(rows, "Create or resume article candidate");
    return row === null ? null : mapArticleRow(row);
  }

  async saveRawContent({
    article_id,
    content,
    content_type,
    language_code,
    fetched_at,
    extractor,
    content_hash,
    metadata,
  }: SaveRawContentInput): Promise<RawContentRow> {
    const values: typeof rawContents.$inferInsert = {
      articleId: article_id,
      content,
      contentHash: content_hash,
    };
    const updates: Partial<typeof rawContents.$inferInsert> = { content };

    if (content_type !== undefined) {
      values.contentType = content_type;
      updates.contentType = content_type;
    }
    if (language_code !== undefined) {
      values.languageCode = language_code;
      updates.languageCode = language_code;
    }
    if (fetched_at !== undefined) {
      const fetchedAt = toIsoTimestamp(fetched_at);
      values.fetchedAt = fetchedAt;
      updates.fetchedAt = fetchedAt;
    }
    if (extractor !== undefined) {
      values.extractor = extractor;
      updates.extractor = extractor;
    }
    if (metadata !== undefined) {
      values.metadata = metadata;
      updates.metadata = metadata;
    }

    const rows = await this.operation("Save raw content", () =>
      this.database
        .insert(rawContents)
        .values(values)
        .onConflictDoUpdate({
          target: [rawContents.articleId, rawContents.contentHash],
          set: updates,
        })
        .returning(rawContentSelection),
    );
    return mapRawContentRow(this.one(rows, "Save raw content"));
  }

  async transitionArticle(
    id: string,
    from: ArticleStatus,
    to: ArticleStatus,
    changes: ArticleTransitionChanges = {},
  ): Promise<ArticleRow> {
    assertTransition("article", from, to);

    const updates: Partial<typeof articles.$inferInsert> = {
      status: to,
      updatedAt: timestamp(),
    };
    if (changes.source_id !== undefined) updates.sourceId = changes.source_id;
    if (changes.search_run_id !== undefined) {
      updates.searchRunId = changes.search_run_id;
    }
    if (changes.canonical_url !== undefined) {
      updates.canonicalUrl = changes.canonical_url;
    }
    if (changes.title !== undefined) updates.title = changes.title;
    if (changes.author !== undefined) updates.author = changes.author;
    if (changes.published_at !== undefined) {
      updates.publishedAt =
        changes.published_at === null
          ? null
          : toIsoTimestamp(changes.published_at);
    }
    if (changes.content_hash !== undefined) {
      updates.contentHash = changes.content_hash;
    }
    if (changes.metadata !== undefined) updates.metadata = changes.metadata;

    const operation = `Transition article ${from} -> ${to}`;
    const rows = await this.operation(operation, () =>
      this.database
        .update(articles)
        .set(updates)
        .where(and(eq(articles.id, id), eq(articles.status, from)))
        .returning(articleSelection),
    );
    return mapArticleRow(this.one(rows, operation));
  }

  async replaceArticleTopics({
    articleId,
    assignments,
    assignmentSource = "ai",
    assignedModel = null,
  }: ReplaceArticleTopicsInput): Promise<ArticleTopicRow[]> {
    const rows = await this.functionRows(
      "Replace article topics",
      replaceArticleTopicsFunction,
      [
        articleId,
        JSON.stringify(assignments),
        assignmentSource,
        assignedModel,
      ],
    );
    return rows.map(mapArticleTopicRow);
  }
}
