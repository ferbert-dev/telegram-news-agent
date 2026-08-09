import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import {
  DATABASE_LIFECYCLE,
  DRIZZLE_DB,
  PG_POOL,
} from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SchedulerRepository } from "../../src/database/repositories/scheduler-repository.js";
import type { SchedulerPersistence } from "../../src/scheduler/scheduler-persistence.contracts.js";
import { SchedulerPersistenceModule } from "../../src/scheduler/scheduler-persistence.module.js";
import { SCHEDULER_PERSISTENCE } from "../../src/scheduler/scheduler-persistence.tokens.js";
import type { NewsSettingsDatabaseRow } from "../../src/settings/settings-row-mappers.js";

const postgresTimestamp = "2026-03-29 01:30:00+01";
const canonicalTimestamp = "2026-03-29T00:30:00.000Z";

const claimedSettingsRow: NewsSettingsDatabaseRow = {
  telegram_channel_id: "@channel",
  review_chat_id: "700000000001",
  schedule_interval_minutes: 180,
  language_code: "de",
  topic_codes: ["world", "nature"],
  custom_topics: ["Ocean exploration"],
  approval_policy: "automatic",
  next_run_at: postgresTimestamp,
  version: 4,
  updated_by: "700000000002",
  schedule_claim_token: "00000000-0000-4000-8000-000000000001",
  schedule_claimed_at: postgresTimestamp,
  schedule_run_id: "00000000-0000-4000-8000-000000000002",
  schedule_run_due_at: postgresTimestamp,
  schedule_settings_snapshot: {
    channelId: "@channel",
    scheduleIntervalMinutes: 180,
  },
  schedule_draft_id: "00000000-0000-4000-8000-000000000003",
  schedule_preview: "Durable preview",
  schedule_window_hours: 48,
  schedule_publication_message_id: "700000000004",
  last_run_at: null,
  last_run_status: null,
  last_error_code: null,
  created_at: new Date(canonicalTimestamp),
  updated_at: postgresTimestamp,
  quiet_hours_enabled: true,
};

type RecordedCall = { text: string; values: unknown[] };

class SchedulerPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    if (text.includes("claim_due_news_schedule")) {
      return { rows: [claimedSettingsRow] } as QueryResult;
    }
    return {
      rows: [{ value: !text.includes("renew_news_schedule_claim") }],
    } as QueryResult;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

test("Scheduler repository exposes exactly seven retained PostgreSQL-function paths", async () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(SchedulerRepository.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    [
      "claimDueNewsSchedule",
      "deferNewsScheduleForQuietHours",
      "finishNewsSchedule",
      "pauseNewsScheduleUnresolved",
      "renewNewsScheduleClaim",
      "saveNewsScheduleDraft",
      "saveNewsSchedulePublication",
    ],
  );

  const pool = new SchedulerPool();
  const repository = new SchedulerRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );
  const claimToken = claimedSettingsRow.schedule_claim_token as string;
  const draftId = claimedSettingsRow.schedule_draft_id as string;

  const claim = await repository.claimDueNewsSchedule({ claimToken });
  assert.ok(claim);
  assert.equal(claim.review_chat_id, 700_000_000_001);
  assert.equal(claim.schedule_publication_message_id, 700_000_000_004);
  assert.equal(claim.schedule_claimed_at, canonicalTimestamp);
  assert.equal(claim.schedule_run_due_at, canonicalTimestamp);
  assert.equal(claim.updated_at, canonicalTimestamp);
  assert.equal(
    await repository.saveNewsScheduleDraft({
      channelId: "@channel",
      claimToken,
      draftId,
      preview: "Durable preview",
      windowHours: 48,
    }),
    true,
  );
  assert.equal(
    await repository.saveNewsSchedulePublication({
      channelId: "@channel",
      claimToken,
      draftId,
      publicationMessageId: 700_000_000_004,
    }),
    true,
  );
  assert.equal(
    await repository.renewNewsScheduleClaim({
      channelId: "@channel",
      claimToken,
    }),
    false,
  );
  assert.equal(
    await repository.deferNewsScheduleForQuietHours({
      channelId: "@channel",
      claimToken,
    }),
    true,
  );
  assert.equal(
    await repository.pauseNewsScheduleUnresolved({
      channelId: "@channel",
      claimToken,
      errorCode: "publication_unresolved",
    }),
    true,
  );
  assert.equal(
    await repository.finishNewsSchedule({
      channelId: "@channel",
      claimToken,
      status: "published",
    }),
    true,
  );

  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."claim_due_news_schedule"($1, $2)',
      values: [claimToken, 1800],
    },
    {
      text: 'select "public"."save_news_schedule_draft"($1, $2, $3, $4, $5) as value',
      values: ["@channel", claimToken, draftId, "Durable preview", 48],
    },
    {
      text: 'select "public"."save_news_schedule_publication"($1, $2, $3, $4) as value',
      values: ["@channel", claimToken, draftId, 700_000_000_004],
    },
    {
      text: 'select "public"."renew_news_schedule_claim"($1, $2) as value',
      values: ["@channel", claimToken],
    },
    {
      text: 'select "public"."defer_news_schedule_for_quiet_hours"($1, $2) as value',
      values: ["@channel", claimToken],
    },
    {
      text: 'select "public"."pause_news_schedule_unresolved"($1, $2, $3) as value',
      values: ["@channel", claimToken, "publication_unresolved"],
    },
    {
      text: 'select "public"."finish_news_schedule"($1, $2, $3, $4) as value',
      values: ["@channel", claimToken, "published", null],
    },
  ]);
});

test("SchedulerPersistenceModule exports one Symbol-token-backed repository instance", async () => {
  const pool = new SchedulerPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const moduleRef = await Test.createTestingModule({
    imports: [SchedulerPersistenceModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(database)
    .overrideProvider(DATABASE_LIFECYCLE)
    .useValue({ close: () => Promise.resolve() })
    .compile();

  try {
    const persistence = moduleRef.get<SchedulerPersistence>(
      SCHEDULER_PERSISTENCE,
    );
    assert.ok(persistence instanceof SchedulerRepository);
    assert.equal(persistence, moduleRef.get(SchedulerRepository));
    assert.deepEqual(
      Reflect.getMetadata("exports", SchedulerPersistenceModule),
      [SCHEDULER_PERSISTENCE],
    );
  } finally {
    await moduleRef.close();
  }
});
