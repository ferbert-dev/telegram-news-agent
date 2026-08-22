import type { PgTable } from "drizzle-orm/pg-core";

import {
  sourceDiscoveryState,
  sources,
  sourceTopics,
  topics,
  topicTranslations,
} from "./catalog.js";
import { drafts, publishedPosts } from "./editorial.js";
import {
  notionAuditOutbox,
  pipelineLeases,
  schemaMigrations,
} from "./operations.js";
import { publicationMilestones } from "./publication-milestones.js";
import { publicationPolicyBlocks } from "./publication-policy.js";
import {
  aiUsageEvents,
  articles,
  articleTopics,
  rawContents,
  searchRuns,
} from "./research.js";
import {
  newsBotSettings,
  newsFeatureFlags,
  telegramSettingsInputs,
} from "./settings.js";
import {
  articleStoryDecisions,
  storyPublicationClaims,
} from "./story-deduplication.js";
import {
  telegramNewsRequestCheckpoints,
  telegramNewsJobs,
  telegramReviewSessions,
  telegramUpdates,
} from "./telegram.js";

export const databaseTables = [
  aiUsageEvents,
  articleStoryDecisions,
  articles,
  articleTopics,
  drafts,
  newsBotSettings,
  newsFeatureFlags,
  notionAuditOutbox,
  pipelineLeases,
  publicationMilestones,
  publicationPolicyBlocks,
  publishedPosts,
  rawContents,
  schemaMigrations,
  searchRuns,
  sourceDiscoveryState,
  sources,
  sourceTopics,
  storyPublicationClaims,
  telegramNewsRequestCheckpoints,
  telegramNewsJobs,
  telegramReviewSessions,
  telegramSettingsInputs,
  telegramUpdates,
  topics,
  topicTranslations,
] satisfies readonly PgTable[];
