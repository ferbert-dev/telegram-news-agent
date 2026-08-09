import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { NotionAuditOutboxRepository } from "../../src/database/repositories/notion-audit-outbox-repository.js";
import { PipelineLeasesRepository } from "../../src/database/repositories/pipeline-leases-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Operations repositories preserve lease fencing and concurrent audit retry semantics",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const database = createDrizzleDatabase(pool);
    const leaseRepository = new PipelineLeasesRepository(
      pool,
      database,
    );
    const auditRepository = new NotionAuditOutboxRepository(
      pool,
      database,
    );
    const suffix = randomUUID();
    const leaseName = `operations-${suffix}`;
    const concurrentLeaseName = `operations-concurrent-${suffix}`;
    const firstOwner = randomUUID();
    const nextOwner = randomUUID();
    const concurrentOwners = [randomUUID(), randomUUID()];
    const notionPageIds = [
      `operations-a-${suffix}`,
      `operations-b-${suffix}`,
    ];

    try {
      await assert.rejects(
        leaseRepository.acquirePipelineLease(
          leaseName,
          firstOwner,
          29,
        ),
        /Acquire pipeline lease failed: Lease TTL must be between 30 and 3600 seconds/,
      );
      assert.equal(
        await leaseRepository.acquirePipelineLease(
          leaseName,
          firstOwner,
          30,
        ),
        true,
      );
      assert.equal(
        await leaseRepository.acquirePipelineLease(
          leaseName,
          nextOwner,
          30,
        ),
        false,
      );
      assert.equal(
        await leaseRepository.renewPipelineLease(leaseName, nextOwner, 30),
        false,
      );
      assert.equal(
        await leaseRepository.releasePipelineLease(leaseName, nextOwner),
        false,
      );
      assert.equal(
        await leaseRepository.renewPipelineLease(leaseName, firstOwner, 30),
        true,
      );

      await pool.query(
        "update public.pipeline_leases set expires_at = now() - interval '1 second' where name = $1",
        [leaseName],
      );
      assert.equal(
        await leaseRepository.renewPipelineLease(leaseName, firstOwner, 30),
        false,
      );
      assert.equal(
        await leaseRepository.acquirePipelineLease(
          leaseName,
          nextOwner,
          30,
        ),
        true,
      );
      assert.equal(
        await leaseRepository.releasePipelineLease(leaseName, firstOwner),
        false,
      );
      assert.equal(
        await leaseRepository.releasePipelineLease(leaseName, nextOwner),
        true,
      );

      const concurrentAcquisitions = await Promise.all(
        concurrentOwners.map((owner) =>
          leaseRepository.acquirePipelineLease(
            concurrentLeaseName,
            owner,
            30,
          ),
        ),
      );
      assert.equal(
        concurrentAcquisitions.filter(Boolean).length,
        1,
        "exactly one owner must acquire an unowned lease",
      );

      const enqueued = await Promise.all(
        notionPageIds.map((notionPageId, index) =>
          auditRepository.enqueueNotionAuditBackfill({
            notion_page_id: notionPageId,
            event_type: "finalize_success",
            payload: {
              started_at: new Date().toISOString(),
              finalization: { status: "Succeeded", index },
            },
            last_error: "initial integration failure",
          }),
        ),
      );
      const updated = await auditRepository.enqueueNotionAuditBackfill({
        notion_page_id: notionPageIds[0],
        event_type: "finalize_success",
        payload: {
          started_at: new Date().toISOString(),
          finalization: { status: "Succeeded", updated: true },
        },
        last_error: "updated integration failure",
      });
      assert.equal(updated.id, enqueued[0].id);
      assert.equal(updated.last_error, "updated integration failure");
      assert.equal(updated.attempt_count, 0);

      const claimedBatches = await Promise.all([
        auditRepository.claimNotionAuditBackfill(1),
        auditRepository.claimNotionAuditBackfill(1),
      ]);
      const claimed = claimedBatches.flat();
      assert.equal(claimed.length, 2);
      assert.equal(new Set(claimed.map((row) => row.id)).size, 2);
      assert.ok(claimed.every((row) => row.attempt_count === 1));
      assert.ok(claimed.every((row) => row.claimed_at !== null));

      const completed = claimed[0];
      const retrying = claimed[1];
      assert.equal(
        await auditRepository.completeNotionAuditBackfill(completed.id),
        true,
      );
      const retryStartedAt = Date.now();
      assert.equal(
        await auditRepository.retryNotionAuditBackfill(
          retrying.id,
          new Error("Notion integration unavailable"),
        ),
        true,
      );
      const retryState = await pool.query<{
        attempt_count: number;
        available_at: Date;
        claimed_at: Date | null;
        completed_at: Date | null;
        last_error: string;
      }>(
        "select attempt_count, available_at, claimed_at, completed_at, last_error from public.notion_audit_outbox where id = $1",
        [retrying.id],
      );
      assert.equal(retryState.rows[0].attempt_count, 1);
      assert.equal(retryState.rows[0].claimed_at, null);
      assert.equal(retryState.rows[0].completed_at, null);
      assert.equal(
        retryState.rows[0].last_error,
        "Notion integration unavailable",
      );
      assert.ok(
        retryState.rows[0].available_at.getTime() >= retryStartedAt + 55_000,
      );
      assert.deepEqual(await auditRepository.claimNotionAuditBackfill(2), []);
      assert.equal(
        await auditRepository.completeNotionAuditBackfill(retrying.id),
        false,
      );

      await pool.query(
        "update public.notion_audit_outbox set available_at = now() - interval '1 second' where id = $1",
        [retrying.id],
      );
      const reclaimed = await auditRepository.claimNotionAuditBackfill(1);
      assert.equal(reclaimed[0].id, retrying.id);
      assert.equal(reclaimed[0].attempt_count, 2);
      assert.equal(
        await auditRepository.completeNotionAuditBackfill(retrying.id),
        true,
      );
      assert.equal(
        await auditRepository.retryNotionAuditBackfill(
          retrying.id,
          "late retry",
        ),
        false,
      );

      await assert.rejects(
        auditRepository.claimNotionAuditBackfill(0),
        /Claim Notion audit backfill failed: Backfill claim limit must be between 1 and 100/,
      );
    } finally {
      await pool
        .query(
          "delete from public.notion_audit_outbox where notion_page_id = any($1::text[])",
          [notionPageIds],
        )
        .catch(() => {});
      await pool
        .query(
          "delete from public.pipeline_leases where name = any($1::text[])",
          [[leaseName, concurrentLeaseName]],
        )
        .catch(() => {});
      await pool.end();
    }
  },
);
