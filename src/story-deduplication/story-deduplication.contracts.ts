import type { JsonObject } from "../database/schema/common.js";

export type StoryRelation =
  | "distinct"
  | "duplicate"
  | "follow_up"
  | "uncertain";

export type StoryDecisionSource = "deterministic" | "ai" | "fallback";

export type RecentPublishedStoryRow = {
  article_id: string;
  title: string;
  feed_summary: string | null;
  message_text: string;
  telegram_channel_id: string;
  telegram_message_id: number;
  published_at: string;
  story_fingerprint: string | null;
};

export type StoryDecisionRow = {
  article_id: string;
  story_fingerprint: string;
  relation: StoryRelation;
  duplicate_of_article_id: string | null;
  confidence: string | null;
  reason: string | null;
  decision_source: StoryDecisionSource;
  metadata: JsonObject;
  decided_at: string;
  updated_at: string;
};

export type ListRecentPublishedStoriesInput = {
  channelId?: string | null;
  since: string | Date;
  limit?: number;
};

export type RecordStoryDecisionInput = {
  articleId: string;
  storyFingerprint: string;
  relation: StoryRelation;
  duplicateOfArticleId?: string | null;
  confidence?: number | null;
  reason?: string | null;
  decisionSource: StoryDecisionSource;
  metadata?: JsonObject;
};

export interface StoryDeduplicationPersistence {
  listRecentPublishedStories(
    input: ListRecentPublishedStoriesInput,
  ): Promise<RecentPublishedStoryRow[]>;
  recordStoryDedupDecision(
    input: RecordStoryDecisionInput,
  ): Promise<StoryDecisionRow>;
}
