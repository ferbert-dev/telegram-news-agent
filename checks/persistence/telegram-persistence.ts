import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import type {
  TelegramCheckpointsPersistence,
  TelegramReviewSessionsPersistence,
  TelegramUpdatesPersistence,
} from "../../src/telegram/telegram-persistence.contracts.js";
import { TelegramPersistenceModule } from "../../src/telegram/telegram-persistence.module.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
  TELEGRAM_UPDATES_PERSISTENCE,
} from "../../src/telegram/telegram-persistence.tokens.js";
import { TelegramCheckpointsRepository } from "../../src/telegram/telegram-checkpoints-repository.js";
import { TelegramReviewSessionsRepository } from "../../src/telegram/telegram-review-sessions-repository.js";
import {
  mapTelegramNewsCheckpointRow,
  mapTelegramReviewDecisionRow,
  mapTelegramReviewSessionRow,
  mapTelegramUpdateFailureRow,
  type TelegramNewsCheckpointDatabaseRow,
  type TelegramReviewDecisionDatabaseRow,
  type TelegramReviewSessionDatabaseRow,
} from "../../src/telegram/telegram-row-mappers.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";

const postgresTimestamp = "2026-08-09 20:34:56.123456+02";
const canonicalTimestamp = "2026-08-09T18:34:56.123Z";
const updateId = 9_001;
const draftId = "00000000-0000-4000-8000-000000000001";
const sessionId = "a".repeat(48);

const checkpointRow: TelegramNewsCheckpointDatabaseRow = {
  update_id: String(updateId),
  status: "review_ready",
  draft_id: draftId,
  preview: "Review preview",
  window_hours: 48,
  created_at: postgresTimestamp,
  updated_at: postgresTimestamp,
  publication_message_id: null,
  settings_snapshot: { languageCode: "en" },
};

const reviewSessionRow: TelegramReviewSessionDatabaseRow = {
  id: sessionId,
  draft_id: draftId,
  telegram_channel_id: "@channel",
  control_chat_id: "-1009001",
  preview_message_id: "701",
  requested_by: "42",
  decision: null,
  decided_by: null,
  decided_at: null,
  expires_at: postgresTimestamp,
  created_at: postgresTimestamp,
};

const decisionRow: TelegramReviewDecisionDatabaseRow = {
  session_id: sessionId,
  draft_id: draftId,
  decision: "publish",
  decision_won: true,
  expires_at: postgresTimestamp,
};

const checkpointTuple = (row = checkpointRow) => [
  row.update_id,
  row.status,
  row.draft_id,
  row.preview,
  row.window_hours,
  row.created_at,
  row.updated_at,
  row.publication_message_id,
  row.settings_snapshot,
];

const reviewSessionTuple = (row = reviewSessionRow) => [
  row.id,
  row.draft_id,
  row.telegram_channel_id,
  row.control_chat_id,
  row.preview_message_id,
  row.requested_by,
  row.decision,
  row.decided_by,
  row.decided_at,
  row.expires_at,
  row.created_at,
];

test("Telegram row mappers preserve snake_case, ISO UTC, nulls, decisions and safe bigint numbers", () => {
  const checkpoint = mapTelegramNewsCheckpointRow(checkpointRow);
  assert.equal(checkpoint.update_id, updateId);
  assert.equal(checkpoint.publication_message_id, null);
  assert.equal(checkpoint.created_at, canonicalTimestamp);

  const session = mapTelegramReviewSessionRow(reviewSessionRow);
  assert.equal(session.control_chat_id, -1_009_001);
  assert.equal(session.decision, null);
  assert.equal(session.decided_at, null);
  assert.equal(session.expires_at, canonicalTimestamp);

  const decision = mapTelegramReviewDecisionRow(decisionRow);
  assert.equal(decision.decision, "publish");
  assert.equal(decision.expires_at, canonicalTimestamp);

  assert.deepEqual(
    mapTelegramUpdateFailureRow({
      attempt_count: "3",
      terminal: true,
      failure_status: "quarantined",
      recorded: true,
    }),
    {
      attempt_count: 3,
      terminal: true,
      failure_status: "quarantined",
      recorded: true,
    },
  );

  assert.throws(
    () =>
      mapTelegramNewsCheckpointRow({
        ...checkpointRow,
        update_id: "9007199254740992",
      }),
    /Invalid PostgreSQL bigint for update_id/,
  );
  assert.throws(
    () => mapTelegramReviewDecisionRow({ ...decisionRow, decision: "later" }),
    /Invalid Telegram review decision/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class TelegramPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];
  hasPending = true;
  checkpointRows: unknown[][] = [checkpointTuple()];
  reviewRows: unknown[][] = [reviewSessionTuple()];
  functionRows: unknown[] | null = null;

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    let rows: unknown[];
    if (
      text.includes('from "telegram_review_sessions"') &&
      text.includes('inner join "drafts"')
    ) {
      rows = this.hasPending ? [[sessionId]] : [];
    } else if (
      text.includes('from "telegram_news_request_checkpoints"')
    ) {
      rows = this.checkpointRows;
    } else if (
      text.includes('insert into "telegram_news_request_checkpoints"')
    ) {
      rows = [checkpointTuple()];
    } else if (
      text.includes('insert into "telegram_review_sessions"') ||
      text.includes('from "telegram_review_sessions"')
    ) {
      rows = this.reviewRows;
    } else if (text.includes('"public".')) {
      rows =
        this.functionRows ??
        (text.includes("claim_telegram_update")
          ? [
              {
                claimed: true,
                claim_token: "00000000-0000-4000-8000-000000000002",
                claim_status: "claimed",
              },
            ]
          : text.includes("record_telegram_update_failure")
            ? [
                {
                  attempt_count: 1,
                  terminal: false,
                  failure_status: "failed",
                  recorded: true,
                },
              ]
            : text.includes("finish_telegram_update")
            ? [{ value: true }]
            : text.includes("decide_telegram_review_session")
              ? [decisionRow]
              : [reviewSessionRow]);
    } else {
      throw new Error(`Unexpected test query: ${text}`);
    }

    return { rows } as QueryResult;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function repositories(pool: TelegramPool) {
  const database = createDrizzleDatabase(pool as unknown as Pool);
  return {
    updates: new TelegramUpdatesRepository(pool as unknown as Pool, database),
    checkpoints: new TelegramCheckpointsRepository(
      pool as unknown as Pool,
      database,
    ),
    reviews: new TelegramReviewSessionsRepository(
      pool as unknown as Pool,
      database,
    ),
  };
}

test("five ordinary Telegram paths use typed Drizzle and preserve pending fallback plus last-write-wins checkpoint upsert", async () => {
  const pool = new TelegramPool();
  const { checkpoints, reviews } = repositories(pool);

  assert.equal(await reviews.hasPendingTelegramReview(" @channel "), true);
  assert.equal(
    (await checkpoints.getTelegramNewsCheckpoint(updateId))?.update_id,
    updateId,
  );
  const saved = await checkpoints.saveTelegramNewsCheckpoint({
    update_id: updateId,
    status: "no_candidates",
    draft_id: null,
    preview: null,
    window_hours: null,
    publication_message_id: null,
    settings_snapshot: {},
    updated_at: postgresTimestamp,
  });
  assert.equal(saved.status, "review_ready");
  assert.equal(
    (
      await reviews.createTelegramReviewSession({
        id: sessionId,
        draft_id: draftId,
        telegram_channel_id: null,
        control_chat_id: -1_009_001,
        preview_message_id: 701,
        requested_by: 42,
        expires_at: postgresTimestamp,
      })
    ).telegram_channel_id,
    "@channel",
  );
  assert.equal(
    (await reviews.findTelegramReviewSessionByDraft(draftId))?.id,
    sessionId,
  );

  assert.equal(pool.calls.length, 5);
  const pendingSql = pool.calls[0].text;
  assert.ok(pendingSql.includes('inner join "drafts"'));
  assert.ok(pendingSql.includes('"telegram_channel_id" is null'));
  assert.ok(pendingSql.includes("exists"));
  assert.ok(pendingSql.includes("btrim("));
  assert.ok(pendingSql.includes("now()"));
  assert.ok(!pendingSql.includes('"public"."has_pending_telegram_review"'));

  const saveSql = pool.calls[2].text;
  assert.ok(saveSql.includes('on conflict ("update_id") do update'));
  assert.match(saveSql, /do update set "status" = \$/);
  assert.ok(saveSql.includes('"draft_id" = $'));
  assert.ok(!saveSql.includes("claim_token"));
  assert.ok(pool.calls.slice(0, 5).every((call) => !call.text.includes('"public".')));
});

test("six retained Telegram methods call exact parameterized PostgreSQL signatures and preserve defaults", async () => {
  const pool = new TelegramPool();
  const { updates, reviews } = repositories(pool);
  const claimToken = "00000000-0000-4000-8000-000000000002";

  const claim = await updates.claimTelegramUpdate({
    updateId,
    updateKind: "callback_query",
  });
  assert.equal(claim.claim_status, "claimed");
  assert.equal(
    await updates.finishTelegramUpdate({
      updateId,
      claimToken,
      status: "completed",
    }),
    true,
  );
  assert.deepEqual(
    await updates.recordTelegramUpdateFailure({
      updateId,
      updateKind: "callback_query",
      errorCode: "handler_failed",
    }),
    {
      attempt_count: 1,
      terminal: false,
      failure_status: "failed",
      recorded: true,
    },
  );
  assert.equal(
    (
      await reviews.renewTelegramReviewSession({
        draftId,
        expiresAt: postgresTimestamp,
      })
    )?.id,
    sessionId,
  );
  assert.equal(
    (
      await reviews.rebindTelegramReviewSession({
        draftId,
        controlChatId: -1_009_001,
        expectedPreviewMessageId: 701,
        previewMessageId: 702,
        expiresAt: postgresTimestamp,
      })
    )?.preview_message_id,
    701,
  );
  assert.equal(
    (
      await reviews.decideTelegramReviewSession({
        sessionId,
        action: "publish",
        chatId: -1_009_001,
        messageId: 702,
        actorId: 42,
      })
    ).decision_won,
    true,
  );

  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."claim_telegram_update"($1, $2, $3)',
      values: [updateId, "callback_query", 120],
    },
    {
      text: 'select "public"."finish_telegram_update"($1, $2, $3, $4) as value',
      values: [updateId, claimToken, "completed", null],
    },
    {
      text: 'select * from "public"."record_telegram_update_failure"($1, $2, $3, $4, $5, $6)',
      values: [updateId, "callback_query", "handler_failed", 3, false, null],
    },
    {
      text: 'select * from "public"."renew_telegram_review_session"($1, $2)',
      values: [draftId, postgresTimestamp],
    },
    {
      text: 'select * from "public"."rebind_telegram_review_session"($1, $2, $3, $4, $5)',
      values: [draftId, -1_009_001, 701, 702, postgresTimestamp],
    },
    {
      text: 'select * from "public"."decide_telegram_review_session"($1, $2, $3, $4, $5)',
      values: [sessionId, "publish", -1_009_001, 702, 42],
    },
  ]);

  pool.functionRows = [];
  assert.equal(
    await reviews.renewTelegramReviewSession({
      draftId,
      expiresAt: postgresTimestamp,
    }),
    null,
  );
});

test("Telegram repositories preserve operation errors, zero-row requirements and safe bigint failures", async () => {
  const failingPool = {
    async query() {
      throw new Error("database offline");
    },
  } as unknown as Pool;
  const failingDatabase = createDrizzleDatabase(failingPool);
  await assert.rejects(
    new TelegramCheckpointsRepository(
      failingPool,
      failingDatabase,
    ).getTelegramNewsCheckpoint(updateId),
    /Get Telegram news checkpoint failed: database offline/,
  );

  const emptyPool = new TelegramPool();
  emptyPool.functionRows = [];
  await assert.rejects(
    repositories(emptyPool).updates.claimTelegramUpdate({
      updateId,
      updateKind: "message",
    }),
    /Claim Telegram update failed: expected one row, received 0/,
  );

  const duplicatePool = new TelegramPool();
  duplicatePool.reviewRows = [reviewSessionTuple(), reviewSessionTuple()];
  await assert.rejects(
    repositories(duplicatePool).reviews.findTelegramReviewSessionByDraft(
      draftId,
    ),
    /Find Telegram review session by draft failed: expected at most one row/,
  );
});

const updateMethods = [
  "claimTelegramUpdate",
  "finishTelegramUpdate",
  "recordTelegramUpdateFailure",
] as const satisfies readonly (keyof TelegramUpdatesPersistence)[];
const checkpointMethods = [
  "getTelegramNewsCheckpoint",
  "saveTelegramNewsCheckpoint",
] as const satisfies readonly (keyof TelegramCheckpointsPersistence)[];
const reviewMethods = [
  "hasPendingTelegramReview",
  "createTelegramReviewSession",
  "findTelegramReviewSessionByDraft",
  "renewTelegramReviewSession",
  "rebindTelegramReviewSession",
  "decideTelegramReviewSession",
] as const satisfies readonly (keyof TelegramReviewSessionsPersistence)[];

@Injectable()
class TelegramPersistenceConsumer {
  constructor(
    @Inject(TELEGRAM_UPDATES_PERSISTENCE)
    readonly updates: TelegramUpdatesPersistence,
    @Inject(TELEGRAM_CHECKPOINTS_PERSISTENCE)
    readonly checkpoints: TelegramCheckpointsPersistence,
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    readonly reviews: TelegramReviewSessionsPersistence,
  ) {}
}

@Module({
  imports: [TelegramPersistenceModule],
  providers: [TelegramPersistenceConsumer],
})
class TelegramPersistenceConsumerModule {}

test("TelegramPersistenceModule exports three Symbol aliases backed by three single repository instances and exactly eleven methods", async () => {
  const pool = new TelegramPool();
  const moduleRef = await Test.createTestingModule({
    imports: [TelegramPersistenceConsumerModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .compile();

  try {
    const consumer = moduleRef.get(TelegramPersistenceConsumer);
    const updates = moduleRef.get(TelegramUpdatesRepository);
    const checkpoints = moduleRef.get(TelegramCheckpointsRepository);
    const reviews = moduleRef.get(TelegramReviewSessionsRepository);

    assert.equal(typeof TELEGRAM_UPDATES_PERSISTENCE, "symbol");
    assert.equal(typeof TELEGRAM_CHECKPOINTS_PERSISTENCE, "symbol");
    assert.equal(typeof TELEGRAM_REVIEW_SESSIONS_PERSISTENCE, "symbol");
    assert.equal(consumer.updates, updates);
    assert.equal(consumer.checkpoints, checkpoints);
    assert.equal(consumer.reviews, reviews);
    assert.deepEqual(
      Object.getOwnPropertyNames(TelegramUpdatesRepository.prototype)
        .filter((name) => name !== "constructor")
        .sort(),
      [...updateMethods].sort(),
    );
    assert.deepEqual(
      Object.getOwnPropertyNames(TelegramCheckpointsRepository.prototype)
        .filter((name) => name !== "constructor")
        .sort(),
      [...checkpointMethods].sort(),
    );
    assert.deepEqual(
      Object.getOwnPropertyNames(TelegramReviewSessionsRepository.prototype)
        .filter((name) => name !== "constructor")
        .sort(),
      [...reviewMethods].sort(),
    );
    assert.equal(
      updateMethods.length + checkpointMethods.length + reviewMethods.length,
      11,
    );
    assert.deepEqual(
      Reflect.getMetadata("exports", TelegramPersistenceModule),
      [
        TELEGRAM_UPDATES_PERSISTENCE,
        TELEGRAM_CHECKPOINTS_PERSISTENCE,
        TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
      ],
    );
  } finally {
    await moduleRef.close();
  }
});
