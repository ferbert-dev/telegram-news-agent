import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Pool } from "pg";

import type {
  ListRecentPublishedStoriesInput,
  RecentPublishedStoryRow,
  RecordStoryDecisionInput,
  StoryDecisionRow,
  StoryDecisionSource,
  StoryDeduplicationPersistence,
  StoryRelation,
} from "../../story-deduplication/story-deduplication.contracts.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { publishedPosts } from "../schema/editorial.js";
import { articles } from "../schema/research.js";
import { articleStoryDecisions } from "../schema/story-deduplication.js";
import {
  RepositorySupport,
  timestamp,
  toIsoTimestamp,
} from "./repository-support.js";

type RecentPublishedStoryDatabaseRow = Omit<
  RecentPublishedStoryRow,
  "telegram_message_id" | "published_at"
> & {
  telegram_message_id: string | number;
  published_at: string | Date;
};

type StoryDecisionDatabaseRow = Omit<
  StoryDecisionRow,
  "relation" | "decision_source" | "decided_at" | "updated_at"
> & {
  relation: string;
  decision_source: string;
  decided_at: string | Date;
  updated_at: string | Date;
};

function safeBigint(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return parsed;
}

function relation(value: string): StoryRelation {
  if (
    value !== "distinct" &&
    value !== "duplicate" &&
    value !== "follow_up" &&
    value !== "uncertain"
  ) {
    throw new Error("Invalid story relation");
  }
  return value;
}

function decisionSource(value: string): StoryDecisionSource {
  if (value !== "deterministic" && value !== "ai" && value !== "fallback") {
    throw new Error("Invalid story decision source");
  }
  return value;
}

function mapRecentPublishedStory(
  row: RecentPublishedStoryDatabaseRow,
): RecentPublishedStoryRow {
  return {
    ...row,
    telegram_message_id: safeBigint(
      row.telegram_message_id,
      "telegram_message_id",
    ),
    published_at: toIsoTimestamp(row.published_at),
  };
}

function mapStoryDecision(
  row: StoryDecisionDatabaseRow,
): StoryDecisionRow {
  return {
    ...row,
    relation: relation(row.relation),
    decision_source: decisionSource(row.decision_source),
    decided_at: toIsoTimestamp(row.decided_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

const recentStorySelection = {
  article_id: articles.id,
  title: articles.title,
  feed_summary: sql<string | null>`${articles.metadata} ->> 'feed_summary'`,
  message_text: publishedPosts.messageText,
  telegram_channel_id: publishedPosts.telegramChannelId,
  telegram_message_id: publishedPosts.telegramMessageId,
  published_at: publishedPosts.publishedAt,
  story_fingerprint: articleStoryDecisions.storyFingerprint,
};

const decisionSelection = {
  article_id: articleStoryDecisions.articleId,
  story_fingerprint: articleStoryDecisions.storyFingerprint,
  relation: articleStoryDecisions.relation,
  duplicate_of_article_id: articleStoryDecisions.duplicateOfArticleId,
  confidence: articleStoryDecisions.confidence,
  reason: articleStoryDecisions.reason,
  decision_source: articleStoryDecisions.decisionSource,
  metadata: articleStoryDecisions.metadata,
  decided_at: articleStoryDecisions.decidedAt,
  updated_at: articleStoryDecisions.updatedAt,
};

@Injectable()
export class StoryDeduplicationRepository
  extends RepositorySupport
  implements StoryDeduplicationPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async listRecentPublishedStories({
    channelId = null,
    since,
    limit = 100,
  }: ListRecentPublishedStoriesInput): Promise<RecentPublishedStoryRow[]> {
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const boundedLimit = Math.max(1, Math.min(200, requestedLimit));
    const sinceIso = toIsoTimestamp(since);
    const condition = channelId
      ? and(
          gte(publishedPosts.publishedAt, sinceIso),
          eq(publishedPosts.telegramChannelId, channelId),
        )
      : gte(publishedPosts.publishedAt, sinceIso);
    const rows = await this.operation("List recent published stories", () =>
      this.database
        .select(recentStorySelection)
        .from(publishedPosts)
        .innerJoin(articles, eq(articles.id, publishedPosts.articleId))
        .leftJoin(
          articleStoryDecisions,
          eq(articleStoryDecisions.articleId, articles.id),
        )
        .where(condition)
        .orderBy(desc(publishedPosts.publishedAt))
        .limit(boundedLimit),
    );
    return (rows as RecentPublishedStoryDatabaseRow[]).map(
      mapRecentPublishedStory,
    );
  }

  async recordStoryDedupDecision({
    articleId,
    storyFingerprint,
    relation: storyRelation,
    duplicateOfArticleId = null,
    confidence = null,
    reason = null,
    decisionSource: source,
    metadata = {},
  }: RecordStoryDecisionInput): Promise<StoryDecisionRow> {
    const values: typeof articleStoryDecisions.$inferInsert = {
      articleId,
      storyFingerprint,
      relation: storyRelation,
      duplicateOfArticleId,
      confidence: confidence === null ? null : String(confidence),
      reason,
      decisionSource: source,
      metadata,
    };
    const rows = await this.operation("Record story deduplication decision", () =>
      this.database
        .insert(articleStoryDecisions)
        .values(values)
        .onConflictDoUpdate({
          target: articleStoryDecisions.articleId,
          set: {
            storyFingerprint,
            relation: storyRelation,
            duplicateOfArticleId,
            confidence: confidence === null ? null : String(confidence),
            reason,
            decisionSource: source,
            metadata,
            updatedAt: timestamp(),
          },
        })
        .returning(decisionSelection),
    );
    return mapStoryDecision(
      this.one(rows, "Record story deduplication decision") as StoryDecisionDatabaseRow,
    );
  }
}
