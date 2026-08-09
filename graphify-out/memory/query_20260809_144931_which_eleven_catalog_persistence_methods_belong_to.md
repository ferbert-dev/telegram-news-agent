---
type: "architecture"
date: "2026-08-09T14:49:31.856074+00:00"
question: "Which eleven Catalog persistence methods belong to sources and topic translations, and which stay atomic?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["SourcesRepository", "topics", "sourceTopics", "topicTranslations", "sourceDiscoveryState"]
---

# Q: Which eleven Catalog persistence methods belong to sources and topic translations, and which stay atomic?

## Answer

Typed Drizzle: listEnabledSources, listEnabledArticleTags, listSourceHealth, upsertSource, setSourceEnabled, markSourceChecked. Retained PostgreSQL functions: markSourceFetchSuccess, markSourceFetchFailure, claimSourceDiscovery, completeSourceDiscovery, upsertDiscoveredSource.

## Outcome

- Signal: useful

## Source Nodes

- SourcesRepository
- topics
- sourceTopics
- topicTranslations
- sourceDiscoveryState