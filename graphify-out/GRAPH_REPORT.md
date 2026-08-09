# Graph Report - .  (2026-08-09)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 874 nodes · 1738 edges · 60 communities (45 shown, 15 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `68a4020d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- This project keeps a code-only graph. Run `graphify extract . --code-only`
  after code changes (no API cost); see `docs/graphify-evaluation.md`.

## Community Hubs (Navigation)
- telegram-control.js
- NewsRepository
- Community 2
- telegram-bot.js
- registry.ts
- ai-provider.js
- draft.js
- telegram.js
- telegram-settings.js
- Community 9
- Community 10
- scripts
- compilerOptions
- Community 13
- Community 14
- Community 15
- dependencies
- Community 17
- Community 18
- 20260626175510_create_news_memory_schema.sql
- news-curation.js
- telegram-stats.js
- 20260807190000_add_article_tags_labs.sql
- devDependencies
- gdelt.js
- 20260807181000_add_source_health_and_discovery.sql
- 20260807210000_add_news_night_pause.sql
- article-extractor.js
- package.json
- migrate.mjs
- migration-status.mjs
- 20260627211631_harden_telegram_control_recovery.sql
- new-migration.mjs
- 20260627023000_add_notion_audit_backfill_rpcs.sql
- 20260627120000_add_telegram_admin_control.sql
- 20260627012000_add_pipeline_leases.sql
- telegram-rpc.integration.test.js
- rollback
- public.sources
- public.drafts
- public.notion_audit_outbox
- public.telegram_news_request_checkpoints
- public.ai_usage_events
- public.news_bot_settings
- bootstrap-oracle.sh
- configure-db-observer.sh
- 00-create-app-role.sh

## God Nodes (most connected - your core abstractions)
1. `NewsRepository` - 84 edges
2. `runResearch()` - 24 edges
3. `scripts` - 22 edges
4. `normalizeNewsSettings()` - 20 edges
5. `SourcesRepository` - 19 edges
6. `handleControlUpdate()` - 19 edges
7. `error()` - 19 edges
8. `withNotionAudit()` - 16 edges
9. `assertPublicHttpUrl()` - 15 edges
10. `publishApprovedDraft()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `query()` --indirect_call--> `text()`  [INFERRED]
  checks/sources-repository.ts → test/article-extractor.test.js
- `createFallbackAiProvider()` --indirect_call--> `error()`  [INFERRED]
  src/ai-provider.js → test/telegram-polling.test.js
- `createGeminiProvider()` --indirect_call--> `response()`  [INFERRED]
  src/gemini-provider.js → test/notion-audit.test.js
- `backfillNotionAudits()` --indirect_call--> `error()`  [INFERRED]
  src/notion-audit.js → test/telegram-polling.test.js
- `withNotionAudit()` --indirect_call--> `error()`  [INFERRED]
  src/notion-audit.js → test/telegram-polling.test.js

## Import Cycles
- None detected.

## Communities (60 total, 15 thin omitted)

### Community 0 - "telegram-control.js"
Cohesion: 0.05
Nodes (57): addressedElsewhere(), ADMIN_STATUSES, answerCallback(), auditDetails(), classifyControlUpdate(), createReviewCallback(), decisionText(), deliverReviewDraft() (+49 more)

### Community 1 - "NewsRepository"
Cohesion: 0.06
Nodes (5): NewsRepository, now(), placeholders(), selectedEntries(), assertTransition()

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (42): logger, repository, databaseClient, repository, closeDatabaseClient(), createDatabaseClient(), getDatabaseConfig(), positiveInteger() (+34 more)

### Community 3 - "telegram-bot.js"
Cohesion: 0.06
Nodes (38): publishCheckpointedDraft(), runCheckpointedNewsSearch(), runTieredNewsSearch(), APPROVAL_POLICIES, buildSearchPlan(), DEFAULT_TOPIC_CODES, firstDefined(), LANGUAGE_OPTIONS (+30 more)

### Community 4 - "registry.ts"
Cohesion: 0.10
Nodes (29): ActualColumnRow, ActualForeignKeyRow, connectionString, ExpectedColumn, expectedTables, pool, sourceDiscoveryState, sources (+21 more)

### Community 5 - "ai-provider.js"
Cohesion: 0.09
Nodes (27): FEED_DISCOVERY_JSON_SCHEMA, FeedDiscovery, HttpUrl, DirectArticleUrl, NEWS_DISCOVERY_JSON_SCHEMA, NewsDiscovery, AiProvidersExhaustedError, classifyProviderError() (+19 more)

### Community 6 - "draft.js"
Cohesion: 0.10
Nodes (31): appendTopicHashtags(), ARTICLE_TAGGING_STATES, hashtagForLanguage(), normalizeArticleTagging(), normalizedCode(), normalizedHashtag(), normalizedHashtags(), normalizedText() (+23 more)

### Community 7 - "telegram.js"
Cohesion: 0.10
Nodes (18): editorFromDraft(), main(), parseArguments(), callTelegram(), { token, channelId }, getTelegramConfig(), acquirePollingLease(), ensurePollingMode() (+10 more)

### Community 8 - "telegram-settings.js"
Cohesion: 0.11
Nodes (25): button(), callbackData(), createSettingsCallback(), editSettingsMessage(), formatNextRun(), handleSettingsCallback(), handleSettingsInput(), intervalLabel() (+17 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (17): deferForQuietHours(), deferredDraftResult(), draftForClaim(), errorCode(), executeClaim(), finish(), requireSaved(), runNewsScheduler() (+9 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (12): query(), createDrizzleDatabase(), DrizzleDatabase, CompleteSourceDiscoveryInput, errorMessage(), SourceRow, sourceSelection, SourcesRepository (+4 more)

### Community 11 - "scripts"
Cohesion: 0.09
Nodes (22): scripts, audit:flush, database:check, database:drift, database:migrate, database:new, database:status, drafts (+14 more)

### Community 12 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, checkJs, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noEmit (+9 more)

### Community 13 - "Community 13"
Cohesion: 0.18
Nodes (12): recordAiUsageEvents(), value(), classifySourceFetchError(), discoverNewFeedSources(), discoveryHomepage(), markSourceFetchFailure(), normalizedFeedUrl(), normalizedLabels() (+4 more)

### Community 15 - "Community 15"
Cohesion: 0.23
Nodes (13): keywordScore(), mapSettledWithConcurrency(), matchPrimarySource(), newestFeedEntries(), rankCandidates(), runResearch(), scoreCandidate(), sourceHostname() (+5 more)

### Community 16 - "dependencies"
Cohesion: 0.13
Nodes (15): cheerio, drizzle-orm, fast-xml-parser, @google/genai, openai, pg, dependencies, cheerio (+7 more)

### Community 17 - "Community 17"
Cohesion: 0.32
Nodes (11): asArray(), atomLink(), canonicalizeUrl(), fetchFeed(), hashText(), parseFeed(), textValue(), TRACKING_PARAMS (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.40
Nodes (9): assertPublicHttpUrl(), assertPublicIpAddress(), blockedIpv4, blockedIpv6, fetchPublicHttp(), mappedIpv4(), normalizedHostname(), REDIRECT_STATUSES (+1 more)

### Community 19 - "20260626175510_create_news_memory_schema.sql"
Cohesion: 0.44
Nodes (9): public.article_topics, public.articles, public.drafts, public.published_posts, public.raw_contents, public.search_runs, public.source_topics, public.sources (+1 more)

### Community 20 - "news-curation.js"
Cohesion: 0.31
Nodes (6): curateNewsCandidates(), NEWS_CANDIDATE_CURATION_JSON_SCHEMA, NewsCandidateCuration, plainText(), publisherKey(), selectCurationSample()

### Community 21 - "telegram-stats.js"
Cohesion: 0.40
Nodes (7): localTime(), numeric(), renderUsageDashboard(), showUsageDashboard(), tokens(), usd(), DASHBOARD

### Community 22 - "20260807190000_add_article_tags_labs.sql"
Cohesion: 0.25
Nodes (3): public.get_news_feature_flags(), public.news_feature_flags, public.topic_translations

### Community 23 - "devDependencies"
Cohesion: 0.22
Nodes (9): devDependencies, tsx, @types/node, @types/pg, typescript, tsx, @types/node, @types/pg (+1 more)

### Community 24 - "gdelt.js"
Cohesion: 0.39
Nodes (6): buildGdeltQuery(), cleanTerm(), fetchGdeltDiscoveries(), gdeltTimespan(), parseSeenDate(), TOPIC_TERMS

### Community 26 - "20260807210000_add_news_night_pause.sql"
Cohesion: 0.32
Nodes (3): public.claim_due_news_schedule(), public.news_bot_settings, public.update_news_settings()

### Community 27 - "article-extractor.js"
Cohesion: 0.43
Nodes (6): CONTENT_SELECTORS, extractArticleText(), fetchArticle(), normalizeText(), REMOVE_SELECTOR, text()

### Community 28 - "package.json"
Cohesion: 0.29
Nodes (6): engines, node, name, private, type, version

### Community 29 - "migrate.mjs"
Cohesion: 0.29
Nodes (4): connectionString, migrationDirectories, pool, root

### Community 30 - "migration-status.mjs"
Cohesion: 0.29
Nodes (6): connectionString, filenames, local, migrationDirectory, pool, root

### Community 32 - "new-migration.mjs"
Cohesion: 0.33
Nodes (5): migrationName, migrationPath, rawName, root, timestamp

### Community 34 - "20260627120000_add_telegram_admin_control.sql"
Cohesion: 0.50
Nodes (3): public.decide_telegram_review_session(), public.telegram_review_sessions, public.telegram_updates

### Community 38 - "telegram-rpc.integration.test.js"
Cohesion: 0.83
Nodes (3): createReviewFixture(), one(), scalar()

## Knowledge Gaps
- **159 isolated node(s):** `public.sources`, `public.drafts`, `public.pipeline_leases`, `public.notion_audit_outbox`, `public.telegram_updates` (+154 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `error()` connect `Community 9` to `telegram-control.js`, `NewsRepository`, `Community 2`, `telegram-bot.js`, `ai-provider.js`, `telegram.js`, `Community 10`, `Community 13`, `Community 15`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Why does `NewsRepository` connect `NewsRepository` to `Community 2`, `telegram-bot.js`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **What connects `public.sources`, `public.drafts`, `public.pipeline_leases` to the rest of the system?**
  _159 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `telegram-control.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05269497139415839 - nodes in this community are weakly interconnected._
- **Should `NewsRepository` be split into smaller, more focused modules?**
  _Cohesion score 0.05679974034404414 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.053208137715179966 - nodes in this community are weakly interconnected._
- **Should `telegram-bot.js` be split into smaller, more focused modules?**
  _Cohesion score 0.060515873015873016 - nodes in this community are weakly interconnected._
