import assert from "node:assert/strict";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { databaseTables } from "../src/database/schema/registry.js";

test("Drizzle snapshot covers every current PostgreSQL table", () => {
  const configs = databaseTables.map((table) => getTableConfig(table));
  const names = configs.map((config) => config.name).sort();

  assert.deepEqual(names, [
    "ai_usage_events",
    "article_story_decisions",
    "article_topics",
    "articles",
    "drafts",
    "news_bot_settings",
    "news_feature_flags",
    "notion_audit_outbox",
    "pipeline_leases",
    "published_posts",
    "raw_contents",
    "schema_migrations",
    "search_runs",
    "source_discovery_state",
    "source_topics",
    "sources",
    "story_publication_claims",
    "telegram_news_request_checkpoints",
    "telegram_review_sessions",
    "telegram_settings_inputs",
    "telegram_updates",
    "topic_translations",
    "topics",
  ]);
  assert.equal(new Set(names).size, names.length);
});

test("Drizzle snapshot preserves RLS and foreign-key coverage", () => {
  const configs = databaseTables.map((table) => getTableConfig(table));
  const infrastructureTable = configs.find(
    (config) => config.name === "schema_migrations",
  );

  assert.equal(infrastructureTable?.enableRLS, false);
  assert.ok(
    configs
      .filter((config) => config.name !== "schema_migrations")
      .every((config) => config.enableRLS),
  );
  assert.equal(
    configs.reduce(
      (count, config) => count + config.foreignKeys.length,
      0,
    ),
    23,
  );
});

test("every declared non-constraint index has a stable unique name", () => {
  const names = databaseTables.flatMap((table) =>
    getTableConfig(table).indexes.map((entry) => entry.config.name),
  );

  assert.ok(names.every(Boolean));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("news_bot_settings_schedule_draft_id_idx"));
  assert.ok(
    names.includes("telegram_news_request_checkpoints_draft_id_idx"),
  );
});
