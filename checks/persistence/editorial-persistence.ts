import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EditorialRepository } from "../../src/database/repositories/editorial-repository.js";
import type { EditorialPersistence } from "../../src/editorial/editorial-persistence.contracts.js";
import { EditorialPersistenceModule } from "../../src/editorial/editorial-persistence.module.js";
import { EDITORIAL_PERSISTENCE } from "../../src/editorial/editorial-persistence.tokens.js";
import {
  mapDraftRow,
  mapPublishedPostRow,
  type DraftDatabaseRow,
  type DraftListDatabaseRow,
  type DraftWithArticleDatabaseRow,
  type PublishedPostDatabaseRow,
} from "../../src/editorial/editorial-row-mappers.js";
import type { ArticleDatabaseRow } from "../../src/research/research-row-mappers.js";

const postgresTimestamp = "2026-08-09 14:34:56.123456+02";
const canonicalTimestamp = "2026-08-09T12:34:56.123Z";

const articleRow: ArticleDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  source_id: null,
  search_run_id: null,
  canonical_url: "https://example.test/editorial",
  title: "Editorial article",
  author: null,
  published_at: null,
  discovered_at: postgresTimestamp,
  content_hash: "article-hash",
  status: "drafted",
  metadata: { publisher: "Example" },
  created_at: postgresTimestamp,
  updated_at: postgresTimestamp,
};

const draftRow: DraftDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000002",
  article_id: articleRow.id,
  body: "Grounded editorial draft.",
  status: "review",
  model: "model-1",
  prompt_version: "v1",
  reviewer_notes: null,
  approved_at: null,
  created_at: postgresTimestamp,
  updated_at: postgresTimestamp,
};

const publicationRow: PublishedPostDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000003",
  draft_id: draftRow.id,
  article_id: articleRow.id,
  telegram_channel_id: "@editorial_test",
  telegram_message_id: "9001",
  published_at: postgresTimestamp,
  message_text: "Published message",
  metadata: { delivery: "confirmed" },
  created_at: postgresTimestamp,
};

const draftTuple = (row: DraftDatabaseRow = draftRow) => [
  row.id,
  row.article_id,
  row.body,
  row.status,
  row.model,
  row.prompt_version,
  row.reviewer_notes,
  row.approved_at,
  row.created_at,
  row.updated_at,
];

const articleTuple = (row: ArticleDatabaseRow = articleRow) => [
  row.id,
  row.source_id,
  row.search_run_id,
  row.canonical_url,
  row.title,
  row.author,
  row.published_at,
  row.discovered_at,
  row.content_hash,
  row.status,
  row.metadata,
  row.created_at,
  row.updated_at,
];

const publicationTuple = (row: PublishedPostDatabaseRow = publicationRow) => [
  row.id,
  row.draft_id,
  row.article_id,
  row.telegram_channel_id,
  row.telegram_message_id,
  row.published_at,
  row.message_text,
  row.metadata,
  row.created_at,
];

test("editorial row mappers preserve snake_case, ISO UTC timestamps, nulls, statuses, and safe bigint values", () => {
  const draft = mapDraftRow(draftRow);
  assert.equal(draft.status, "review");
  assert.equal(draft.approved_at, null);
  assert.equal(draft.created_at, canonicalTimestamp);

  const publication = mapPublishedPostRow(publicationRow);
  assert.equal(publication.telegram_message_id, 9001);
  assert.equal(publication.published_at, canonicalTimestamp);
  assert.equal(publication.metadata, publicationRow.metadata);

  assert.throws(
    () => mapDraftRow({ ...draftRow, status: "unknown" }),
    /Invalid draft status/,
  );
  assert.throws(
    () =>
      mapPublishedPostRow({
        ...publicationRow,
        telegram_message_id: "9007199254740992",
      }),
    /Invalid PostgreSQL bigint for telegram_message_id/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class EditorialPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];
  atomicRows: unknown[] | null = null;
  publicationRows: unknown[][] = [publicationTuple()];

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    let rows: unknown[];
    if (text.includes('insert into "drafts"')) {
      rows = [draftTuple({ ...draftRow, status: "draft", model: null })];
    } else if (
      text.includes('from "drafts"') &&
      text.includes('inner join "articles"') &&
      text.includes('"drafts"."model"')
    ) {
      rows = [[...draftTuple(), ...articleTuple()]];
    } else if (
      text.includes('from "drafts"') &&
      text.includes('inner join "articles"')
    ) {
      rows = [[
        draftRow.id,
        draftRow.article_id,
        draftRow.body,
        draftRow.status,
        draftRow.created_at,
        articleRow.title,
      ]];
    } else if (text.includes('update "drafts"')) {
      rows = [draftTuple({ ...draftRow, status: "approved" })];
    } else if (text.includes('insert into "published_posts"')) {
      rows = [publicationTuple()];
    } else if (text.includes('from "published_posts"')) {
      rows = this.publicationRows;
    } else if (text.includes('"public".')) {
      rows =
        this.atomicRows ??
        (text.includes("finalize_draft_publication")
          ? [publicationRow]
          : [draftRow]);
    } else {
      throw new Error(`Unexpected test query: ${text}`);
    }

    return { rows } as QueryResult;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

test("six ordinary editorial paths use typed Drizzle with defaults, null parity, status CAS and receipt mapping", async () => {
  const pool = new EditorialPool();
  const repository = new EditorialRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );

  const created = await repository.createDraft({
    article_id: articleRow.id,
    body: draftRow.body,
    status: null,
    model: null,
  });
  assert.equal(created.status, "draft");
  assert.equal(created.model, null);

  const fetched = await repository.getDraft(draftRow.id);
  assert.equal(fetched.articles.id, articleRow.id);
  assert.equal(fetched.articles.author, null);

  const listed = await repository.listDrafts();
  assert.equal(listed[0].articles.title, articleRow.title);
  assert.equal(listed[0].created_at, canonicalTimestamp);

  const transitioned = await repository.transitionDraft(
    draftRow.id,
    "review",
    "approved",
    { reviewer_notes: null, approved_at: postgresTimestamp },
  );
  assert.equal(transitioned.status, "approved");

  const found = await repository.findPublicationByDraft(draftRow.id);
  assert.equal(found?.telegram_message_id, 9001);

  const recorded = await repository.recordPublication({
    draft_id: draftRow.id,
    article_id: articleRow.id,
    telegram_channel_id: publicationRow.telegram_channel_id,
    telegram_message_id: 9001,
    message_text: publicationRow.message_text,
  });
  assert.equal(recorded.id, publicationRow.id);

  assert.equal(pool.calls.length, 6);
  assert.ok(pool.calls[0].text.includes('insert into "drafts"'));
  assert.ok(pool.calls[1].text.includes('inner join "articles"'));
  assert.ok(pool.calls[2].text.includes('order by "drafts"."created_at"'));
  assert.ok(pool.calls[3].text.includes('update "drafts"'));
  assert.ok(pool.calls[3].text.includes('"id" = $'));
  assert.ok(pool.calls[3].text.includes('"status" = $'));
  assert.ok(pool.calls[4].text.includes('from "published_posts"'));
  assert.ok(pool.calls[5].text.includes('insert into "published_posts"'));
  assert.ok(pool.calls.every((call) => !call.text.includes('"public".')));

  await assert.rejects(
    repository.transitionDraft(draftRow.id, "review", "published"),
    /Invalid draft transition: review -> published/,
  );
});

test("seven atomic Editorial methods retain eight exact parameterized PostgreSQL signatures", async () => {
  const pool = new EditorialPool();
  const repository = new EditorialRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );
  const assignments = [{ code: "science", confidence: 0.95 }];

  await repository.createReviewDraft({
    article_id: articleRow.id,
    body: draftRow.body,
    model: "model-1",
  });
  await repository.createReviewDraft({
    article_id: articleRow.id,
    body: draftRow.body,
    model: "model-1",
    lease_name: "daily",
    lease_owner_id: "00000000-0000-4000-8000-000000000004",
    topic_assignments: assignments,
    topic_assigned_model: "tagger-1",
  });
  await repository.approveDraft(draftRow.id);
  await repository.rejectDraft(draftRow.id);
  await repository.claimDraftForPublication(
    draftRow.id,
    publicationRow.telegram_channel_id,
  );
  const finalized = await repository.finalizeDraftPublication({
    draftId: draftRow.id,
    channelId: publicationRow.telegram_channel_id,
    messageId: 9001,
    messageText: publicationRow.message_text,
  });
  await repository.resetDraftPublication(draftRow.id, "TELEGRAM_NOT_SENT");
  await repository.releaseRejectedDraftPublication(draftRow.id);

  assert.equal(finalized?.telegram_message_id, 9001);
  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."create_review_draft"($1, $2, $3, $4, $5, $6, $7)',
      values: [articleRow.id, draftRow.body, "model-1", null, null, null, null],
    },
    {
      text: 'select * from "public"."create_review_draft_with_topics"($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      values: [
        articleRow.id,
        draftRow.body,
        "model-1",
        null,
        null,
        "daily",
        "00000000-0000-4000-8000-000000000004",
        JSON.stringify(assignments),
        "ai",
        "tagger-1",
      ],
    },
    {
      text: 'select * from "public"."approve_draft"($1)',
      values: [draftRow.id],
    },
    {
      text: 'select * from "public"."reject_draft"($1, $2)',
      values: [draftRow.id, null],
    },
    {
      text: 'select * from "public"."claim_draft_for_publication"($1, $2)',
      values: [draftRow.id, publicationRow.telegram_channel_id],
    },
    {
      text: 'select * from "public"."finalize_draft_publication"($1, $2, $3, $4, $5)',
      values: [
        draftRow.id,
        publicationRow.telegram_channel_id,
        9001,
        publicationRow.message_text,
        {},
      ],
    },
    {
      text: 'select * from "public"."reset_draft_publication"($1, $2)',
      values: [draftRow.id, "TELEGRAM_NOT_SENT"],
    },
    {
      text: 'select * from "public"."release_rejected_draft_publication"($1)',
      values: [draftRow.id],
    },
  ]);

  pool.atomicRows = [];
  assert.equal(await repository.approveDraft(draftRow.id), undefined);
});

test("editorial repositories preserve operation error wrapping, zero-row CAS and publication uniqueness errors", async () => {
  const failingPool = {
    async query() {
      throw new Error("database offline");
    },
  } as unknown as Pool;
  const failingRepository = new EditorialRepository(
    failingPool,
    createDrizzleDatabase(failingPool),
  );
  await assert.rejects(
    failingRepository.createDraft({
      article_id: articleRow.id,
      body: draftRow.body,
    }),
    /Create draft failed: database offline/,
  );

  const emptyPool = {
    async query() {
      return { rows: [] };
    },
  } as unknown as Pool;
  const emptyRepository = new EditorialRepository(
    emptyPool,
    createDrizzleDatabase(emptyPool),
  );
  await assert.rejects(
    emptyRepository.transitionDraft(draftRow.id, "review", "approved"),
    /Transition draft review -> approved failed: expected one row, received 0/,
  );

  const duplicatePool = new EditorialPool();
  duplicatePool.publicationRows = [publicationTuple(), publicationTuple()];
  const duplicateRepository = new EditorialRepository(
    duplicatePool as unknown as Pool,
    createDrizzleDatabase(duplicatePool as unknown as Pool),
  );
  await assert.rejects(
    duplicateRepository.findPublicationByDraft(draftRow.id),
    /Find publication by draft failed: expected at most one row/,
  );
});

const editorialMethods = [
  "createDraft",
  "createReviewDraft",
  "getDraft",
  "listDrafts",
  "transitionDraft",
  "approveDraft",
  "rejectDraft",
  "claimDraftForPublication",
  "finalizeDraftPublication",
  "findPublicationByDraft",
  "resetDraftPublication",
  "releaseRejectedDraftPublication",
  "recordPublication",
] as const satisfies readonly (keyof EditorialPersistence)[];

@Injectable()
class EditorialConsumer {
  constructor(
    @Inject(EDITORIAL_PERSISTENCE)
    readonly persistence: EditorialPersistence,
  ) {}
}

@Module({
  imports: [EditorialPersistenceModule],
  providers: [EditorialConsumer],
})
class EditorialConsumerModule {}

test("EditorialPersistenceModule exports one Symbol alias with exactly thirteen methods", async () => {
  const pool = new EditorialPool();
  const moduleRef = await Test.createTestingModule({
    imports: [EditorialConsumerModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .compile();

  try {
    const consumer = moduleRef.get(EditorialConsumer);
    const repository = moduleRef.get(EditorialRepository);
    const publicPrototypeMethods = Object.getOwnPropertyNames(
      EditorialRepository.prototype,
    ).filter((name) => name !== "constructor");

    assert.equal(typeof EDITORIAL_PERSISTENCE, "symbol");
    assert.equal(consumer.persistence, repository);
    assert.ok(consumer.persistence instanceof EditorialRepository);
    assert.deepEqual(publicPrototypeMethods.sort(), [...editorialMethods].sort());
    assert.deepEqual(
      editorialMethods.filter(
        (method) => typeof consumer.persistence[method] !== "function",
      ),
      [],
    );
    assert.deepEqual(
      Reflect.getMetadata("exports", EditorialPersistenceModule),
      [EDITORIAL_PERSISTENCE],
    );
  } finally {
    await moduleRef.close();
  }
});
