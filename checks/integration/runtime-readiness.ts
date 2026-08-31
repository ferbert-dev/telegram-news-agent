import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { PipelineLeasesRepository } from "../../src/database/repositories/pipeline-leases-repository.js";
import { checkRuntimeHealth } from "../../src/runtime/runtime-health-check.js";
import { RuntimeHealthWorker } from "../../src/runtime/runtime-health.js";
import { TELEGRAM_CONTROL_POLLER_LEASE_NAME } from "../../src/telegram/telegram-polling-worker.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

/**
 * The readiness protocol against a real PostgreSQL.
 *
 * Everything else about it is proven with a fake lease reader, which means the
 * one claim that makes it worth having -- that a runtime cannot certify itself,
 * because the database is asked -- had never actually touched a database. Nor
 * had `readPipelineLease`: its timestamp normalization and the `now()::text`
 * cast were only ever exercised against a mocked pool that hands back strings,
 * while the real driver's shape is decided by pg.
 */
test(
  "readiness is decided by the real lease row, and a runtime cannot certify itself",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const leases = new PipelineLeasesRepository(pool, createDrizzleDatabase(pool));
    // Namespaced so a failed run cannot strand the real poller lease name.
    const leaseName = `${TELEGRAM_CONTROL_POLLER_LEASE_NAME}-check-${randomUUID()}`;
    const ownerId = randomUUID();
    const filePath = join(await mkdtemp(join(tmpdir(), "readiness-")), "health.json");
    const health = new RuntimeHealthWorker({
      runtimeId: randomUUID(),
      botId: 4242,
      channelId: "@integration-channel",
      pollerLeaseName: leaseName,
      pollerLeaseOwnerId: ownerId,
      filePath,
    });

    try {
      // 1. No lease yet. The runtime's file says ready either way -- that is the
      //    point of treating it as a claim.
      await health.start(new AbortController().signal);
      const beforeLease = await checkRuntimeHealth({ filePath, leases });
      assert.equal(beforeLease.healthy, false);
      assert.match(beforeLease.healthy ? "" : beforeLease.reason, /is not held/);

      // 2. Lease acquired through the same atomic function production uses.
      assert.equal(await leases.acquirePipelineLease(leaseName, ownerId, 60), true);

      const held = await checkRuntimeHealth({ filePath, leases });
      assert.equal(
        held.healthy,
        true,
        held.healthy ? "" : `expected healthy, got: ${held.reason}`,
      );

      // The timestamps survive the real driver, not just the mock.
      const snapshot = await leases.readPipelineLease(leaseName);
      assert.ok(snapshot);
      assert.equal(snapshot.ownerId, ownerId);
      for (const value of [snapshot.acquiredAt, snapshot.expiresAt, snapshot.serverNowAt]) {
        assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      // now() is the database's clock, read in the same statement, and the
      // lease it was read with is genuinely still in the future there.
      assert.ok(Date.parse(snapshot.expiresAt) > Date.parse(snapshot.serverNowAt));

      // 3. A second runtime that has not won the lease. Its file is fresh, its
      //    pid is alive, its heartbeat is current -- and it is serving nothing.
      //    This is the case a process-alive check gets wrong.
      const duplicatePath = join(await mkdtemp(join(tmpdir(), "readiness-dup-")), "health.json");
      const duplicate = new RuntimeHealthWorker({
        runtimeId: randomUUID(),
        botId: 4242,
        channelId: "@integration-channel",
        pollerLeaseName: leaseName,
        pollerLeaseOwnerId: randomUUID(),
        filePath: duplicatePath,
      });
      await duplicate.start(new AbortController().signal);
      try {
        assert.equal(await leases.acquirePipelineLease(leaseName, randomUUID(), 60), false);
        const impostor = await checkRuntimeHealth({ filePath: duplicatePath, leases });
        assert.equal(impostor.healthy, false);
        assert.match(
          impostor.healthy ? "" : impostor.reason,
          /owned by another runtime/,
        );
      } finally {
        await duplicate.stop();
      }

      // 4. An expired lease, judged on PostgreSQL's clock rather than ours.
      await pool.query(
        "update public.pipeline_leases set expires_at = now() - interval '1 second' where name = $1",
        [leaseName],
      );
      const expired = await checkRuntimeHealth({ filePath, leases });
      assert.equal(expired.healthy, false);
      assert.match(expired.healthy ? "" : expired.reason, /expired/);

      // 5. Released. A runtime that has surrendered its lease is not healthy,
      //    however convincing its own file remains.
      assert.equal(await leases.releasePipelineLease(leaseName, ownerId), true);
      const released = await checkRuntimeHealth({ filePath, leases });
      assert.equal(released.healthy, false);
      assert.match(released.healthy ? "" : released.reason, /is not held/);
    } finally {
      await health.stop();
      await pool
        .query("delete from public.pipeline_leases where name = $1", [leaseName])
        .catch(() => {});
      await pool.end();
    }
  },
);
