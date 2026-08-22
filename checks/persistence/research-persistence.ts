import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import type { ResearchIngestionPersistence } from "../../src/research/research-persistence.contracts.js";
import { ResearchPersistenceModule } from "../../src/research/research-persistence.module.js";
import { AI_PROVIDER_ATTEMPTS_PERSISTENCE } from "../../src/ai-provider-attempts-persistence.tokens.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../../src/research/research-persistence.tokens.js";
import {
  mapArticleRow,
  mapArticleTopicRow,
  mapRawContentRow,
  mapSearchRunRow,
  type ArticleDatabaseRow,
  type ArticleTopicDatabaseRow,
  type RawContentDatabaseRow,
  type SearchRunDatabaseRow,
} from "../../src/research/research-row-mappers.js";

const postgresTimestamp = "2026-08-09 14:34:56.123456+02";
const canonicalTimestamp = "2026-08-09T12:34:56.123Z";

const searchRunRow: SearchRunDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  query: "research query",
  status: "running",
  source_id: null,
  started_at: postgresTimestamp,
  finished_at: null,
  result_count: 0,
  error: null,
  metadata: { window_hours: 48 },
};

const articleRow: ArticleDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000002",
  source_id: null,
  search_run_id: searchRunRow.id,
  canonical_url: "https://example.test/research",
  title: "Research article",
  author: null,
  published_at: postgresTimestamp,
  discovered_at: new Date(canonicalTimestamp),
  content_hash: "article-hash",
  status: "discovered",
  metadata: { publisher: "Example" },
  created_at: postgresTimestamp,
  updated_at: new Date(canonicalTimestamp),
};

const rawContentRow: RawContentDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000003",
  article_id: articleRow.id,
  content: "Verified article evidence",
  content_type: "text",
  language_code: "en",
  fetched_at: postgresTimestamp,
  extractor: "primary-html",
  content_hash: "raw-hash",
  metadata: { extraction_kind: "primary_article_text" },
  created_at: new Date(canonicalTimestamp),
};

const articleTopicRow: ArticleTopicDatabaseRow = {
  article_id: articleRow.id,
  topic_id: "00000000-0000-4000-8000-000000000004",
  relevance_score: "0.9500",
  created_at: postgresTimestamp,
  assignment_source: "ai",
  assigned_model: "tagger-1",
};

test("research row mappers preserve snake_case DTOs, ISO UTC timestamps, nulls, and numeric strings", () => {
  const run = mapSearchRunRow(searchRunRow);
  assert.equal(run.started_at, canonicalTimestamp);
  assert.equal(run.finished_at, null);
  assert.equal(run.metadata, searchRunRow.metadata);

  const article = mapArticleRow(articleRow);
  assert.equal(article.published_at, canonicalTimestamp);
  assert.equal(article.discovered_at, canonicalTimestamp);
  assert.equal(article.author, null);

  const raw = mapRawContentRow(rawContentRow);
  assert.equal(raw.fetched_at, canonicalTimestamp);
  assert.equal(raw.created_at, canonicalTimestamp);

  const topic = mapArticleTopicRow(articleTopicRow);
  assert.equal(topic.relevance_score, "0.9500");
  assert.equal(typeof topic.relevance_score, "string");
  assert.equal(topic.created_at, canonicalTimestamp);

  assert.throws(
    () => mapSearchRunRow({ ...searchRunRow, status: "unknown" }),
    /Invalid search run status/,
  );
  assert.throws(
    () => mapArticleRow({ ...articleRow, status: "unknown" }),
    /Invalid article status/,
  );
  assert.throws(
    () => mapRawContentRow({ ...rawContentRow, content_type: "binary" }),
    /Invalid raw content type/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class ResearchPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];
  candidateRows: ArticleDatabaseRow[] = [articleRow];

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    let rows: unknown[];
    if (text.includes('insert into "search_runs"')) {
      rows = [
        [
          searchRunRow.id,
          searchRunRow.query,
          searchRunRow.status,
          searchRunRow.source_id,
          searchRunRow.started_at,
          searchRunRow.finished_at,
          searchRunRow.result_count,
          searchRunRow.error,
          searchRunRow.metadata,
        ],
      ];
    } else if (text.includes('update "search_runs"')) {
      const status = values.includes("completed") ? "completed" : "failed";
      rows = [
        [
          searchRunRow.id,
          searchRunRow.query,
          status,
          searchRunRow.source_id,
          searchRunRow.started_at,
          postgresTimestamp,
          status === "completed" ? 2 : 0,
          status === "failed" ? "provider unavailable" : null,
          searchRunRow.metadata,
        ],
      ];
    } else if (text.includes("create_or_resume_article_candidate")) {
      rows = this.candidateRows;
    } else if (text.includes('insert into "raw_contents"')) {
      rows = [
        [
          rawContentRow.id,
          rawContentRow.article_id,
          rawContentRow.content,
          rawContentRow.content_type,
          rawContentRow.language_code,
          rawContentRow.fetched_at,
          rawContentRow.extractor,
          rawContentRow.content_hash,
          rawContentRow.metadata,
          rawContentRow.created_at,
        ],
      ];
    } else if (text.includes('update "articles"')) {
      rows = [
        [
          articleRow.id,
          articleRow.source_id,
          articleRow.search_run_id,
          articleRow.canonical_url,
          articleRow.title,
          articleRow.author,
          articleRow.published_at,
          articleRow.discovered_at,
          articleRow.content_hash,
          "extracted",
          articleRow.metadata,
          articleRow.created_at,
          articleRow.updated_at,
        ],
      ];
    } else if (text.includes("replace_article_topics")) {
      rows = [articleTopicRow];
    } else {
      throw new Error(`Unexpected test query: ${text}`);
    }

    return { rows } as QueryResult;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

test("five ordinary research paths use typed Drizzle mutations with status CAS and stable error values", async () => {
  const pool = new ResearchPool();
  const repository = new ResearchIngestionRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );

  assert.equal(
    (await repository.startSearchRun({ query: "research query" })).status,
    "running",
  );
  assert.equal(
    (
      await repository.finishSearchRun(searchRunRow.id, {
        resultCount: 2,
        metadata: { selected_article_id: articleRow.id },
      })
    ).status,
    "completed",
  );
  assert.equal(
    (
      await repository.failSearchRun(
        searchRunRow.id,
        new Error("provider unavailable"),
      )
    ).error,
    "provider unavailable",
  );
  assert.equal(
    (
      await repository.saveRawContent({
        article_id: articleRow.id,
        content: rawContentRow.content,
        content_type: "text",
        language_code: "en",
        extractor: "primary-html",
        content_hash: rawContentRow.content_hash,
        metadata: rawContentRow.metadata,
      })
    ).content_hash,
    rawContentRow.content_hash,
  );
  assert.equal(
    (
      await repository.transitionArticle(
        articleRow.id,
        "discovered",
        "extracted",
        { metadata: { extracted: true } },
      )
    ).status,
    "extracted",
  );

  const typedCalls = pool.calls;
  assert.equal(typedCalls.length, 5);
  assert.ok(typedCalls[0].text.includes('insert into "search_runs"'));
  assert.ok(typedCalls[1].text.includes('update "search_runs"'));
  assert.ok(typedCalls[1].text.includes('"status" = $'));
  assert.ok(typedCalls[2].values.includes("provider unavailable"));
  assert.match(
    typedCalls[3].text,
    /on conflict \("article_id","content_hash"\) do update/,
  );
  assert.ok(typedCalls[4].text.includes('update "articles"'));
  assert.ok(typedCalls[4].text.includes('"id" = $'));
  assert.ok(typedCalls[4].text.includes('"status" = $'));
  assert.ok(typedCalls.every((call) => !call.text.includes('"public".')));

  await assert.rejects(
    repository.transitionArticle(
      articleRow.id,
      "discovered",
      "published",
    ),
    /Invalid article transition: discovered -> published/,
  );
});

test("candidate and topic mutations retain exactly two parameterized PostgreSQL function boundaries", async () => {
  const pool = new ResearchPool();
  const repository = new ResearchIngestionRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );
  const assignments = [{ code: "science", confidence: 0.95 }];

  assert.equal(
    (
      await repository.createOrResumeArticleCandidate({
        source_id: null,
        search_run_id: searchRunRow.id,
        canonical_url: articleRow.canonical_url,
        title: articleRow.title,
        author: null,
        published_at: articleRow.published_at,
        content_hash: articleRow.content_hash,
        metadata: null,
      })
    )?.id,
    articleRow.id,
  );
  assert.equal(
    (
      await repository.replaceArticleTopics({
        articleId: articleRow.id,
        assignments,
        assignedModel: "tagger-1",
      })
    )[0].relevance_score,
    "0.9500",
  );

  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."create_or_resume_article_candidate"($1, $2, $3, $4, $5, $6, $7, $8)',
      values: [
        null,
        searchRunRow.id,
        articleRow.canonical_url,
        articleRow.title,
        null,
        articleRow.published_at,
        articleRow.content_hash,
        {},
      ],
    },
    {
      text: 'select * from "public"."replace_article_topics"($1, $2, $3, $4)',
      values: [
        articleRow.id,
        JSON.stringify(assignments),
        "ai",
        "tagger-1",
      ],
    },
  ]);

  pool.candidateRows = [];
  assert.equal(
    await repository.createOrResumeArticleCandidate({
      source_id: null,
      search_run_id: searchRunRow.id,
      canonical_url: "https://example.test/non-resumable",
      title: "Non-resumable",
      author: null,
      published_at: null,
      content_hash: null,
    }),
    null,
  );
});

test("research repositories preserve operation error wrapping and zero-row CAS failures", async () => {
  const failingPool = {
    async query() {
      throw new Error("database offline");
    },
  } as unknown as Pool;
  const failingRepository = new ResearchIngestionRepository(
    failingPool,
    createDrizzleDatabase(failingPool),
  );
  await assert.rejects(
    failingRepository.startSearchRun({ query: "offline" }),
    /Start search run failed: database offline/,
  );

  const emptyPool = {
    async query() {
      return { rows: [] };
    },
  } as unknown as Pool;
  const emptyRepository = new ResearchIngestionRepository(
    emptyPool,
    createDrizzleDatabase(emptyPool),
  );
  await assert.rejects(
    emptyRepository.transitionArticle(
      articleRow.id,
      "discovered",
      "extracted",
    ),
    /Transition article discovered -> extracted failed: expected one row, received 0/,
  );
});

const researchMethods = [
  "startSearchRun",
  "finishSearchRun",
  "failSearchRun",
  "createOrResumeArticleCandidate",
  "saveRawContent",
  "transitionArticle",
  "replaceArticleTopics",
] as const satisfies readonly (keyof ResearchIngestionPersistence)[];

@Injectable()
class ResearchConsumer {
  constructor(
    @Inject(RESEARCH_INGESTION_PERSISTENCE)
    readonly persistence: ResearchIngestionPersistence,
  ) {}
}

@Module({
  imports: [ResearchPersistenceModule],
  providers: [ResearchConsumer],
})
class ResearchConsumerModule {}

test("ResearchPersistenceModule exports narrow Symbol aliases for research and provider attempts", async () => {
  const pool = new ResearchPool();
  const moduleRef = await Test.createTestingModule({
    imports: [ResearchConsumerModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .compile();

  try {
    const consumer = moduleRef.get(ResearchConsumer);
    const repository = moduleRef.get(ResearchIngestionRepository);
    const publicPrototypeMethods = Object.getOwnPropertyNames(
      ResearchIngestionRepository.prototype,
    ).filter((name) => name !== "constructor");

    assert.equal(typeof RESEARCH_INGESTION_PERSISTENCE, "symbol");
    assert.equal(consumer.persistence, repository);
    assert.ok(consumer.persistence instanceof ResearchIngestionRepository);
    assert.deepEqual(publicPrototypeMethods.sort(), [...researchMethods].sort());
    assert.deepEqual(
      researchMethods.filter(
        (method) => typeof consumer.persistence[method] !== "function",
      ),
      [],
    );
    assert.deepEqual(Reflect.getMetadata("exports", ResearchPersistenceModule), [
      RESEARCH_INGESTION_PERSISTENCE,
      AI_PROVIDER_ATTEMPTS_PERSISTENCE,
    ]);
  } finally {
    await moduleRef.close();
  }
});
