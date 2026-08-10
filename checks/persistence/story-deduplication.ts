import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { StoryDeduplicationRepository } from "../../src/database/repositories/story-deduplication-repository.js";
import { StoryDeduplicationPersistenceModule } from "../../src/story-deduplication/story-deduplication-persistence.module.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../../src/story-deduplication/story-deduplication.tokens.js";

type QueryCall = { text: string; values: unknown[] };

const RECENT_ROW = {
  article_id: "article-prior",
  title: "Prior story",
  feed_summary: "Prior summary",
  message_text: "Prior publication",
  telegram_channel_id: "@channel",
  telegram_message_id: "42",
  published_at: "2026-08-09 10:00:00+00",
  story_fingerprint: null,
};

const DECISION_ROW = {
  article_id: "article-new",
  story_fingerprint: "fingerprint",
  relation: "duplicate",
  duplicate_of_article_id: "article-prior",
  confidence: "0.9500",
  reason: "Same event",
  decision_source: "ai",
  metadata: { shortlist: [] },
  decided_at: "2026-08-10 10:00:00+00",
  updated_at: "2026-08-10 10:00:00+00",
};

class StoryPool extends EventEmitter {
  calls: QueryCall[] = [];

  async query(
    config: string | { text: string; values?: unknown[]; rowMode?: string },
  ) {
    const text = typeof config === "string" ? config : config.text;
    const values = typeof config === "string" ? [] : (config.values ?? []);
    this.calls.push({ text, values });
    if (text.includes('from "published_posts"')) {
      const row = [
        RECENT_ROW.article_id,
        RECENT_ROW.title,
        RECENT_ROW.feed_summary,
        RECENT_ROW.message_text,
        RECENT_ROW.telegram_channel_id,
        RECENT_ROW.telegram_message_id,
        RECENT_ROW.published_at,
        RECENT_ROW.story_fingerprint,
      ];
      return {
        rows:
          typeof config !== "string" && config.rowMode === "array"
            ? [row]
            : [RECENT_ROW],
        rowCount: 1,
      } as QueryResult;
    }
    if (text.includes('insert into "article_story_decisions"')) {
      const row = [
        DECISION_ROW.article_id,
        DECISION_ROW.story_fingerprint,
        DECISION_ROW.relation,
        DECISION_ROW.duplicate_of_article_id,
        DECISION_ROW.confidence,
        DECISION_ROW.reason,
        DECISION_ROW.decision_source,
        DECISION_ROW.metadata,
        DECISION_ROW.decided_at,
        DECISION_ROW.updated_at,
      ];
      return {
        rows:
          typeof config !== "string" && config.rowMode === "array"
            ? [row]
            : [DECISION_ROW],
        rowCount: 1,
      } as QueryResult;
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  end() {
    return Promise.resolve();
  }
}

test("story persistence uses bounded parameterized history and canonical DTOs", async () => {
  const pool = new StoryPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const repository = new StoryDeduplicationRepository(
    pool as unknown as Pool,
    database,
  );
  const rows = await repository.listRecentPublishedStories({
    channelId: "@channel",
    since: "2026-08-01T00:00:00.000Z",
    limit: 999,
  });
  assert.deepEqual(rows, [
    {
      ...RECENT_ROW,
      telegram_message_id: 42,
      published_at: "2026-08-09T10:00:00.000Z",
    },
  ]);
  assert.ok(pool.calls[0].text.includes("limit"));
  assert.equal(pool.calls[0].text.includes("999"), false);
});

test("story decisions upsert one article without interpolating untrusted values", async () => {
  const pool = new StoryPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const repository = new StoryDeduplicationRepository(
    pool as unknown as Pool,
    database,
  );
  const maliciousReason = "same'); select pg_sleep(10); --";
  const row = await repository.recordStoryDedupDecision({
    articleId: "article-new",
    storyFingerprint: "fingerprint",
    relation: "duplicate",
    duplicateOfArticleId: "article-prior",
    confidence: 0.95,
    reason: maliciousReason,
    decisionSource: "ai",
    metadata: { shortlist: [] },
  });
  assert.equal(row.relation, "duplicate");
  assert.equal(row.decided_at, "2026-08-10T10:00:00.000Z");
  assert.equal(pool.calls[0].text.includes(maliciousReason), false);
});

test("StoryDeduplicationPersistenceModule exports one Symbol useExisting instance", async () => {
  const pool = new StoryPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const module = await Test.createTestingModule({
    imports: [StoryDeduplicationPersistenceModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(database)
    .compile();
  assert.equal(typeof STORY_DEDUPLICATION_PERSISTENCE, "symbol");
  assert.strictEqual(
    module.get(STORY_DEDUPLICATION_PERSISTENCE),
    module.get(StoryDeduplicationRepository),
  );
  await module.close();
});
