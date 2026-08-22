import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { PublicationMilestonesRepository } from "../../src/database/repositories/publication-milestones-repository.js";
import {
  mapPublicationMilestoneRow,
  type PublicationMilestoneDatabaseRow,
} from "../../src/publication-milestones/publication-milestones-row-mappers.js";

const postgresTimestamp = "2026-08-21 14:34:56.123456+02";
const canonicalTimestamp = "2026-08-21T12:34:56.123Z";

const milestoneRow: PublicationMilestoneDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  telegram_channel_id: "@channel",
  ordinal: 50,
  published_post_id: "00000000-0000-4000-8000-000000000050",
  language_code: "en",
  editor_name: "Mikhail",
  state: "sending",
  claim_token: "00000000-0000-4000-8000-000000000010",
  telegram_message_id: null,
  attempt_count: 1,
  last_error: null,
  created_at: new Date(canonicalTimestamp),
  updated_at: postgresTimestamp,
  claimed_at: postgresTimestamp,
  sent_at: null,
  failed_at: null,
  uncertain_at: null,
};

test("publication milestone mapper preserves canonical timestamps and validates enums", () => {
  const mapped = mapPublicationMilestoneRow(milestoneRow);
  assert.equal(mapped.ordinal, 50);
  assert.equal(mapped.language_code, "en");
  assert.equal(mapped.updated_at, canonicalTimestamp);

  assert.throws(
    () => mapPublicationMilestoneRow({ ...milestoneRow, state: "unknown" }),
    /Invalid publication milestone state/,
  );
  assert.throws(
    () =>
      mapPublicationMilestoneRow({
        ...milestoneRow,
        telegram_message_id: "9007199254740992",
      }),
    /Invalid PostgreSQL bigint for telegram_message_id/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class FunctionPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    if (text.includes("claim_publication_milestone")) {
      return { rows: [milestoneRow] } as QueryResult;
    }
    if (text.includes("mark_publication_milestone_sent")) {
      return {
        rows: [{ ...milestoneRow, state: "sent", claim_token: null, telegram_message_id: "9001", claimed_at: null }],
      } as QueryResult;
    }
    if (text.includes("mark_publication_milestone_failed")) {
      return {
        rows: [{ ...milestoneRow, state: "failed", claim_token: null, claimed_at: null, last_error: "rejected" }],
      } as QueryResult;
    }
    if (text.includes("mark_publication_milestone_uncertain")) {
      return { rows: [{ ...milestoneRow, state: "uncertain", claim_token: null, claimed_at: null, last_error: "timeout" }] } as QueryResult;
    }
    if (text.includes("retry_publication_milestone")) {
      return { rows: [milestoneRow] } as QueryResult;
    }
    if (text.includes("reconcile_publication_milestone_sent")) {
      return { rows: [{ ...milestoneRow, state: "sent", claim_token: null, claimed_at: null, telegram_message_id: "9001" }] } as QueryResult;
    }
    if (text.includes("reconcile_publication_milestone_not_sent")) {
      return { rows: [{ ...milestoneRow, state: "failed", claim_token: null, claimed_at: null }] } as QueryResult;
    }
    throw new Error(`Unexpected test query: ${text}`);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

test("publication milestone repository keeps parameterized PostgreSQL function boundaries", async () => {
  const pool = new FunctionPool();
  const repository = new PublicationMilestonesRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );

  assert.equal(
    (
      await repository.claim({
        publicationId: milestoneRow.published_post_id,
        languageCode: "en",
        editorName: "Mikhail",
      })
    )?.ordinal,
    50,
  );
  assert.equal(
    (
      await repository.markSent({
        milestoneId: milestoneRow.id,
        claimToken: milestoneRow.claim_token!,
        telegramMessageId: 9001,
      })
    )?.state,
    "sent",
  );
  assert.equal(
    (
      await repository.markFailed({
        milestoneId: milestoneRow.id,
        claimToken: milestoneRow.claim_token!,
        errorMessage: "rejected",
      })
    )?.state,
    "failed",
  );

  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."claim_publication_milestone"($1, $2, $3)',
      values: [milestoneRow.published_post_id, "en", "Mikhail"],
    },
    {
      text: 'select * from "public"."mark_publication_milestone_sent"($1, $2, $3)',
      values: [milestoneRow.id, milestoneRow.claim_token, 9001],
    },
    {
      text: 'select * from "public"."mark_publication_milestone_failed"($1, $2, $3)',
      values: [milestoneRow.id, milestoneRow.claim_token, "rejected"],
    },
  ]);
});
