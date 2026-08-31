import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import {
  mapNotionAuditOutboxRow,
  NotionAuditOutboxRepository,
} from "../../src/database/repositories/notion-audit-outbox-repository.js";
import { PipelineLeasesRepository } from "../../src/database/repositories/pipeline-leases-repository.js";
import { OperationsPersistenceModule } from "../../src/operations/operations-persistence.module.js";
import {
  NOTION_AUDIT_OUTBOX_REPOSITORY,
  PIPELINE_LEASES_REPOSITORY,
} from "../../src/operations/operations.tokens.js";

type RecordedCall = [string, unknown[]];

function queryParts(
  query: string | { text: string; values?: unknown[] },
  parameters: unknown[] = [],
): RecordedCall {
  return typeof query === "string"
    ? [query, parameters]
    : [query.text, query.values ?? parameters];
}

test("pipeline lease operations retain parameterized PostgreSQL functions and legacy TTL defaults", async () => {
  const calls: RecordedCall[] = [];
  const pool = {
    async query(
      query: string | { text: string; values?: unknown[] },
      parameters: unknown[] = [],
    ) {
      const call = queryParts(query, parameters);
      calls.push(call);
      return { rows: [{ value: !call[0].includes("renew_pipeline_lease") }] };
    },
  } as unknown as Pool;
  const repository = new PipelineLeasesRepository(
    pool,
    createDrizzleDatabase(pool),
  );

  assert.equal(
    await repository.acquirePipelineLease("daily", "owner-1"),
    true,
  );
  assert.equal(
    await repository.renewPipelineLease("daily", "owner-1"),
    false,
  );
  assert.equal(
    await repository.releasePipelineLease("daily", "owner-1"),
    true,
  );
  assert.deepEqual(calls, [
    [
      'select "public"."acquire_pipeline_lease"($1, $2, $3) as value',
      ["daily", "owner-1", 900],
    ],
    [
      'select "public"."renew_pipeline_lease"($1, $2, $3) as value',
      ["daily", "owner-1", 60],
    ],
    [
      'select "public"."release_pipeline_lease"($1, $2) as value',
      ["daily", "owner-1"],
    ],
  ]);
});

test("Notion outbox mapper canonicalizes only timestamps and preserves payload", () => {
  const payload = {
    started_at: "2026-08-09 12:34:56.123456+02",
    finalization: { status: "Succeeded" },
  };
  const mapped = mapNotionAuditOutboxRow({
    id: "outbox-1",
    notion_page_id: "notion-page-1",
    event_type: "finalize_success",
    payload,
    last_error: "offline",
    attempt_count: 1,
    available_at: "2026-08-09 12:34:56.123456+02",
    completed_at: null,
    created_at: new Date("2026-08-09T10:34:56.123Z"),
    updated_at: "2026-08-09T10:34:56.123456Z",
    claimed_at: "2026-08-09 13:34:56.123456+03",
  });

  assert.equal(mapped.available_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.completed_at, null);
  assert.equal(mapped.created_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.updated_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.claimed_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.payload, payload);
  assert.equal(
    mapped.payload.started_at,
    "2026-08-09 12:34:56.123456+02",
  );
});

test("Notion audit lifecycle retains atomic claim, completion, and retry functions", async () => {
  const calls: RecordedCall[] = [];
  const row = {
    id: "outbox-1",
    notion_page_id: "notion-page-1",
    event_type: "finalize_success",
    payload: { finalization: { status: "Succeeded" } },
    last_error: "offline",
    attempt_count: 1,
    available_at: new Date("2026-08-09T10:34:56.123Z"),
    completed_at: null,
    created_at: new Date("2026-08-09T10:00:00.000Z"),
    updated_at: new Date("2026-08-09T10:34:56.123Z"),
    claimed_at: new Date("2026-08-09T10:34:56.123Z"),
  };
  const pool = {
    async query(
      query: string | { text: string; values?: unknown[] },
      parameters: unknown[] = [],
    ) {
      const call = queryParts(query, parameters);
      calls.push(call);
      return call[0].includes("claim_notion_audit_backfill")
        ? { rows: [row] }
        : { rows: [{ value: true }] };
    },
  } as unknown as Pool;
  const repository = new NotionAuditOutboxRepository(
    pool,
    createDrizzleDatabase(pool),
  );

  const claimed = await repository.claimNotionAuditBackfill(10);
  assert.equal(claimed[0].claimed_at, "2026-08-09T10:34:56.123Z");
  assert.equal(await repository.completeNotionAuditBackfill("outbox-1"), true);
  assert.equal(
    await repository.retryNotionAuditBackfill(
      "outbox-2",
      new Error("offline"),
    ),
    true,
  );
  assert.deepEqual(calls, [
    [
      'select * from "public"."claim_notion_audit_backfill"($1)',
      [10],
    ],
    [
      'select "public"."complete_notion_audit_backfill"($1) as value',
      ["outbox-1"],
    ],
    [
      'select "public"."retry_notion_audit_backfill"($1, $2) as value',
      ["outbox-2", "offline"],
    ],
  ]);
});

test("OperationsPersistenceModule exports narrow interface tokens backed by one repository instance", async () => {
  class FakePool extends EventEmitter {
    query(): never {
      throw new Error("The dependency-injection test must not query PostgreSQL");
    }

    async end(): Promise<void> {}
  }

  const pool = new FakePool() as unknown as Pool;
  const moduleRef = await Test.createTestingModule({
    imports: [OperationsPersistenceModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .compile();

  try {
    assert.equal(
      moduleRef.get(PIPELINE_LEASES_REPOSITORY),
      moduleRef.get(PipelineLeasesRepository),
    );
    assert.equal(
      moduleRef.get(NOTION_AUDIT_OUTBOX_REPOSITORY),
      moduleRef.get(NotionAuditOutboxRepository),
    );
  } finally {
    await moduleRef.close();
  }
});

test("reading a pipeline lease is a plain select that never mutates the lease it reports on", async () => {
  const calls: RecordedCall[] = [];
  // Drizzle selects run with rowMode "array", so the fake answers positionally
  // in the order the repository's select projection declares.
  const pool = {
    async query(
      query: string | { text: string; values?: unknown[] },
      parameters: unknown[] = [],
    ) {
      calls.push(queryParts(query, parameters));
      return {
        rows: [
          [
            "telegram_control_poller",
            "owner-1",
            "2026-08-31 13:59:00.123456+02",
            "2026-08-31 14:01:00.123456+02",
            "2026-08-31 14:00:00.000000+02",
          ],
        ],
      };
    },
  } as unknown as Pool;
  const repository = new PipelineLeasesRepository(pool, createDrizzleDatabase(pool));

  const lease = await repository.readPipelineLease("telegram_control_poller");

  assert.deepEqual(lease, {
    name: "telegram_control_poller",
    ownerId: "owner-1",
    // Normalized at the boundary: the health check compares these against a
    // clock, so driver-shaped offsets must not leak out of the repository.
    acquiredAt: "2026-08-31T11:59:00.123Z",
    expiresAt: "2026-08-31T12:01:00.123Z",
    // Read in the same statement so lease expiry is never judged across two
    // clocks.
    serverNowAt: "2026-08-31T12:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  const [text, values] = calls[0] as RecordedCall;
  // A health probe must be incapable of acquiring, renewing, or extending the
  // lease it is asserting about.
  assert.match(text, /^select /i);
  assert.match(text, /now\(\)/i);
  assert.doesNotMatch(text, /acquire_pipeline_lease|renew_pipeline_lease|update|insert|delete/i);
  assert.deepEqual(values, ["telegram_control_poller", 1]);
});

test("an absent pipeline lease reads as null rather than an error", async () => {
  const pool = {
    async query() {
      return { rows: [] };
    },
  } as unknown as Pool;
  const repository = new PipelineLeasesRepository(pool, createDrizzleDatabase(pool));

  assert.equal(await repository.readPipelineLease("telegram_control_poller"), null);
});
