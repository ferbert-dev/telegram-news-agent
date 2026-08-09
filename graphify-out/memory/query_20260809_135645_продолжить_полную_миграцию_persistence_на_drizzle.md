---
type: "query"
date: "2026-08-09T13:56:45.438895+00:00"
question: "Продолжить полную миграцию persistence на Drizzle и затем спланировать NestJS"
contributor: "graphify"
outcome: "useful"
source_nodes: ["src/database.js", "src/database/drizzle-client.ts", "src/database/repositories/sources-repository.ts", "src/news-repository.js", "src/database/schema/registry.ts"]
---

# Q: Продолжить полную миграцию persistence на Drizzle и затем спланировать NestJS

## Answer

Graphify located database.js, Drizzle client, SourcesRepository, NewsRepository, schema registry and runtime consumers. Source and SQL verification confirmed a gated DatabaseModule followed by dependency-ordered repository slices; the foundation now owns one Pool, one Drizzle instance, lifecycle and shared repository support.

## Outcome

- Signal: useful

## Source Nodes

- src/database.js
- src/database/drizzle-client.ts
- src/database/repositories/sources-repository.ts
- src/news-repository.js
- src/database/schema/registry.ts