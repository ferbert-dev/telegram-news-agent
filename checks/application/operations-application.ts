import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";

import { NotionAuditDeliveryService } from "../../src/operations/application/notion-audit-delivery.service.js";
import { PipelineLeaseService } from "../../src/operations/application/pipeline-lease.service.js";
import type {
  NotionAuditFinalization,
  NotionAuditGateway,
  NotionAuditRun,
} from "../../src/operations/operations-application.contracts.js";
import { OperationsApplicationModule } from "../../src/operations/operations-application.module.js";
import { LegacyNotionAuditGateway } from "../../src/operations/legacy-notion-audit.gateway.js";
import { LegacyNotionAuditModule } from "../../src/operations/legacy-notion-audit.module.js";
import {
  NOTION_AUDIT_DELIVERY_APPLICATION,
  NOTION_AUDIT_GATEWAY,
  PIPELINE_LEASE_APPLICATION,
} from "../../src/operations/operations-application.tokens.js";
import type {
  NotionAuditOutboxRepositoryPort,
  NotionAuditOutboxRow,
  PipelineLeasesRepositoryPort,
} from "../../src/operations/operations.interfaces.js";
import { OperationsPersistenceModule } from "../../src/operations/operations-persistence.module.js";
import {
  NOTION_AUDIT_OUTBOX_REPOSITORY,
  PIPELINE_LEASES_REPOSITORY,
} from "../../src/operations/operations.tokens.js";
import { backfillNotionAudits } from "../../src/notion-audit.js";

const OUTBOX_ROW: NotionAuditOutboxRow = {
  id: "outbox-1",
  notion_page_id: "run-1",
  event_type: "finalize_success",
  payload: {
    started_at: "2026-08-12T10:00:00.000Z",
    finalization: {
      status: "Succeeded",
      result: "Pipeline completed",
    },
  },
  last_error: "Notion unavailable",
  attempt_count: 1,
  available_at: "2026-08-12T10:01:00.000Z",
  completed_at: null,
  created_at: "2026-08-12T10:00:01.000Z",
  updated_at: "2026-08-12T10:01:00.000Z",
  claimed_at: "2026-08-12T10:01:00.000Z",
};

test("PipelineLeaseService preserves owner fencing arguments, defaults, boolean results, and error identity", async () => {
  const calls: unknown[] = [];
  const failure = new Error("lease database unavailable");
  const leases: PipelineLeasesRepositoryPort = {
    async acquirePipelineLease(...args) {
      calls.push(["acquire", ...args]);
      return true;
    },
    async renewPipelineLease(...args) {
      calls.push(["renew", ...args]);
      return false;
    },
    async releasePipelineLease(...args) {
      calls.push(["release", ...args]);
      throw failure;
    },
  };
  const service = new PipelineLeaseService(leases);
  const request = {
    name: "daily-news-pipeline",
    ownerId: "00000000-0000-4000-8000-000000000001",
  };

  assert.equal(await service.acquire(request), true);
  assert.equal(await service.renew({ ...request, ttlSeconds: 60 }), false);
  await assert.rejects(
    service.release(request),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ["acquire", request.name, request.ownerId, undefined],
    ["renew", request.name, request.ownerId, 60],
    ["release", request.name, request.ownerId],
  ]);
});

test("NotionAuditDeliveryService keeps enqueue DTO identity and delivers claimed records sequentially in PostgreSQL order", async () => {
  const calls: unknown[] = [];
  const enqueued = { ...OUTBOX_ROW, id: "enqueued" };
  const second = {
    ...OUTBOX_ROW,
    id: "outbox-2",
    notion_page_id: "run-2",
  };
  const repository: NotionAuditOutboxRepositoryPort = {
    async enqueueNotionAuditBackfill(record) {
      calls.push(["enqueue", record]);
      return enqueued;
    },
    async claimNotionAuditBackfill(limit) {
      calls.push(["claim", limit]);
      return [OUTBOX_ROW, second];
    },
    async completeNotionAuditBackfill(id) {
      calls.push(["complete", id]);
      return true;
    },
    async retryNotionAuditBackfill() {
      throw new Error("successful delivery must not retry");
    },
  };
  const signal = new AbortController().signal;
  const gateway: NotionAuditGateway = {
    async finalize(run, finalization, receivedSignal) {
      calls.push([
        "finalize",
        run.pageId,
        run.startedAt.toISOString(),
        finalization,
        receivedSignal,
      ]);
    },
  };
  const service = new NotionAuditDeliveryService(repository, gateway);
  const enqueueInput = {
    notion_page_id: "run-new",
    event_type: "finalize_success",
    payload: OUTBOX_ROW.payload,
    last_error: "offline",
  };

  assert.equal(await service.enqueue(enqueueInput), enqueued);
  assert.equal((calls[0] as unknown[])[1], enqueueInput);
  assert.deepEqual(
    await service.deliverPending({ limit: 10, signal }),
    { claimed: 2, completed: 2, failed: 0 },
  );
  assert.deepEqual(calls.slice(1), [
    ["claim", 10],
    [
      "finalize",
      "run-1",
      "2026-08-12T10:00:00.000Z",
      OUTBOX_ROW.payload.finalization,
      signal,
    ],
    ["complete", "outbox-1"],
    [
      "finalize",
      "run-2",
      "2026-08-12T10:00:00.000Z",
      OUTBOX_ROW.payload.finalization,
      signal,
    ],
    ["complete", "outbox-2"],
  ]);
});

test("NotionAuditDeliveryService fail-closes malformed persisted payloads and continues the batch", async (t) => {
  const privateMarker = "must-not-leak-from-persisted-payload";
  const validFinalization = OUTBOX_ROW.payload.finalization;
  const cases: Array<{
    name: string;
    notionPageId?: string;
    payload: Record<string, unknown>;
  }> = [
    {
      name: "missing started timestamp",
      payload: { finalization: validFinalization, privateMarker },
    },
    {
      name: "invalid calendar timestamp",
      payload: {
        started_at: "2026-02-30T10:00:00.000Z",
        finalization: validFinalization,
        privateMarker,
      },
    },
    {
      name: "non-strict ISO timestamp",
      payload: {
        started_at: "2026-08-12T10:00:00Z",
        finalization: validFinalization,
        privateMarker,
      },
    },
    {
      name: "missing finalization",
      payload: {
        started_at: OUTBOX_ROW.payload.started_at,
        privateMarker,
      },
    },
    {
      name: "null finalization",
      payload: {
        started_at: OUTBOX_ROW.payload.started_at,
        finalization: null,
        privateMarker,
      },
    },
    {
      name: "non-object finalization",
      payload: {
        started_at: OUTBOX_ROW.payload.started_at,
        finalization: privateMarker,
      },
    },
    {
      name: "array finalization",
      payload: {
        started_at: OUTBOX_ROW.payload.started_at,
        finalization: [privateMarker],
      },
    },
    {
      name: "blank page ID",
      notionPageId: "   ",
      payload: { ...OUTBOX_ROW.payload, privateMarker },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const invalid = {
        ...OUTBOX_ROW,
        id: `invalid-${index}`,
        notion_page_id: fixture.notionPageId ?? `invalid-run-${index}`,
        payload: fixture.payload,
      };
      const valid = {
        ...OUTBOX_ROW,
        id: `valid-${index}`,
        notion_page_id: `valid-run-${index}`,
      };
      const gatewayCalls: string[] = [];
      const completed: string[] = [];
      const retries: Array<[string, unknown]> = [];
      const repository: NotionAuditOutboxRepositoryPort = {
        async enqueueNotionAuditBackfill() {
          throw new Error("unused");
        },
        async claimNotionAuditBackfill() {
          return [invalid, valid];
        },
        async completeNotionAuditBackfill(id) {
          completed.push(id);
          return true;
        },
        async retryNotionAuditBackfill(id, error) {
          retries.push([id, error]);
          return true;
        },
      };
      const gateway: NotionAuditGateway = {
        async finalize(run) {
          gatewayCalls.push(run.pageId);
        },
      };

      assert.deepEqual(
        await new NotionAuditDeliveryService(
          repository,
          gateway,
        ).deliverPending(),
        { claimed: 2, completed: 1, failed: 1 },
      );
      assert.deepEqual(gatewayCalls, [valid.notion_page_id]);
      assert.deepEqual(completed, [valid.id]);
      assert.equal(retries.length, 1);
      assert.equal(retries[0]?.[0], invalid.id);
      const retryError = retries[0]?.[1];
      assert.ok(retryError instanceof Error);
      assert.equal(
        retryError.message,
        "Invalid persisted Notion audit outbox payload",
      );
      assert.doesNotMatch(retryError.message, new RegExp(privateMarker));
    });
  }
});

test("NotionAuditDeliveryService retries a failed delivery without stopping the claimed batch", async () => {
  const deliveryFailure = new Error("Notion unavailable");
  const calls: unknown[] = [];
  const second = {
    ...OUTBOX_ROW,
    id: "outbox-2",
    notion_page_id: "run-2",
  };
  const repository: NotionAuditOutboxRepositoryPort = {
    async enqueueNotionAuditBackfill() {
      throw new Error("unused");
    },
    async claimNotionAuditBackfill() {
      return [OUTBOX_ROW, second];
    },
    async completeNotionAuditBackfill(id) {
      calls.push(["complete", id]);
      return true;
    },
    async retryNotionAuditBackfill(id, error) {
      calls.push(["retry", id, error]);
      return true;
    },
  };
  const gateway: NotionAuditGateway = {
    async finalize(run) {
      calls.push(["finalize", run.pageId]);
      if (run.pageId === "run-1") throw deliveryFailure;
    },
  };

  assert.deepEqual(
    await new NotionAuditDeliveryService(
      repository,
      gateway,
    ).deliverPending(),
    { claimed: 2, completed: 1, failed: 1 },
  );
  assert.deepEqual(calls, [
    ["finalize", "run-1"],
    ["retry", "outbox-1", deliveryFailure],
    ["finalize", "run-2"],
    ["complete", "outbox-2"],
  ]);
});

test("NotionAuditDeliveryService preserves legacy replay ordering and result parity", async () => {
  const run = async (legacy: boolean) => {
    const calls: unknown[] = [];
    const second = {
      ...OUTBOX_ROW,
      id: "outbox-2",
      notion_page_id: "run-2",
    };
    const repository: NotionAuditOutboxRepositoryPort = {
      async enqueueNotionAuditBackfill() {
        throw new Error("unused");
      },
      async claimNotionAuditBackfill(limit) {
        calls.push(["claim", limit]);
        return [OUTBOX_ROW, second];
      },
      async completeNotionAuditBackfill(id) {
        calls.push(["complete", id]);
        return true;
      },
      async retryNotionAuditBackfill(id, error) {
        calls.push([
          "retry",
          id,
          error instanceof Error ? error.message : String(error),
        ]);
        return true;
      },
    };
    const finish = async (
      pageId: string,
      startedAt: Date,
      finalization: unknown,
    ) => {
      calls.push([
        "finish",
        pageId,
        startedAt.toISOString(),
        finalization,
      ]);
      if (pageId === "run-1") throw new Error("Notion unavailable");
    };

    const result = legacy
      ? await backfillNotionAudits(
          {
            async finish(
              run: { pageId: string; startedAt: Date },
              finalization: unknown,
            ) {
              await finish(run.pageId, run.startedAt, finalization);
            },
          },
          repository,
          { limit: 10 },
        )
      : await new NotionAuditDeliveryService(repository, {
          async finalize(run, finalization) {
            await finish(run.pageId, run.startedAt, finalization);
          },
        }).deliverPending({ limit: 10 });
    return { result, calls };
  };

  assert.deepEqual(await run(false), await run(true));
});

test("NotionAuditDeliveryService honors cancellation before claim and durably retries an in-flight abort", async () => {
  const beforeClaim = new AbortController();
  const beforeClaimReason = new Error("cancel before claim");
  beforeClaim.abort(beforeClaimReason);
  let claims = 0;
  const repository: NotionAuditOutboxRepositoryPort = {
    async enqueueNotionAuditBackfill() {
      throw new Error("unused");
    },
    async claimNotionAuditBackfill() {
      claims += 1;
      return [OUTBOX_ROW];
    },
    async completeNotionAuditBackfill() {
      throw new Error("aborted delivery must not complete");
    },
    async retryNotionAuditBackfill() {
      return true;
    },
  };
  const unusedGateway: NotionAuditGateway = {
    async finalize() {
      throw new Error("must not deliver");
    },
  };

  await assert.rejects(
    new NotionAuditDeliveryService(
      repository,
      unusedGateway,
    ).deliverPending({ signal: beforeClaim.signal }),
    (error) => error === beforeClaimReason,
  );
  assert.equal(claims, 0);

  const inFlight = new AbortController();
  const inFlightReason = new Error("shutdown requested");
  let retriedError: unknown;
  const inFlightRepository: NotionAuditOutboxRepositoryPort = {
    ...repository,
    async claimNotionAuditBackfill() {
      return [OUTBOX_ROW];
    },
    async retryNotionAuditBackfill(_id, error) {
      retriedError = error;
      return true;
    },
  };
  const abortingGateway: NotionAuditGateway = {
    async finalize(_run, _finalization, signal) {
      inFlight.abort(inFlightReason);
      signal?.throwIfAborted();
    },
  };

  await assert.rejects(
    new NotionAuditDeliveryService(
      inFlightRepository,
      abortingGateway,
    ).deliverPending({ signal: inFlight.signal }),
    (error) => error === inFlightReason,
  );
  assert.equal(retriedError, inFlightReason);
});

test("LegacyNotionAuditGateway forwards run and finalization by reference and preserves signal cancellation", async () => {
  const calls: unknown[] = [];
  const logger = {
    async finish(
      run: NotionAuditRun,
      finalization: NotionAuditFinalization,
    ) {
      calls.push([run, finalization]);
    },
  };
  const gateway = new LegacyNotionAuditGateway(logger);
  const run = { pageId: "run-1", startedAt: new Date("2026-08-22T08:00:00.000Z") };
  const finalization = { status: "Succeeded", result: "ok" };
  const signal = new AbortController().signal;

  await gateway.finalize(run, finalization, signal);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as unknown[])[0], run);
  assert.equal((calls[0] as unknown[])[1], finalization);

  const canceled = new AbortController();
  const reason = new Error("delivery canceled");
  canceled.abort(reason);
  const canceledGateway = new LegacyNotionAuditGateway({
    async finish() {
      throw new Error("must not write");
    },
  });
  await assert.rejects(
    canceledGateway.finalize(run, finalization, canceled.signal),
    (error) => error === reason,
  );
});

test("LegacyNotionAuditGateway preserves raw finish errors", async () => {
  const failure = new Error("notion request failed");
  const logger = {
    async finish() {
      throw failure;
    },
  };
  const gateway = new LegacyNotionAuditGateway(logger);

  await assert.rejects(
    gateway.finalize(
      { pageId: "run-1", startedAt: new Date("2026-08-22T08:01:00.000Z") },
      { status: "Failed", result: "boom" },
    ),
    (error) => error === failure,
  );
});

test("LegacyNotionAuditModule exports only its replaceable gateway token without constructing a client", () => {
  const customGateway = Symbol("CUSTOM_NOTION_AUDIT_GATEWAY");
  const finalizer = { async finish() {} };
  const module = LegacyNotionAuditModule.register(finalizer, customGateway);
  assert.deepEqual(module.exports, [customGateway]);
  assert.equal(module.providers?.length, 1);
  const provider = module.providers?.[0] as {
    provide?: symbol;
    useValue?: unknown;
  };
  assert.equal(provider.provide, customGateway);
  assert.ok(provider.useValue instanceof LegacyNotionAuditGateway);
});

test("Operations application providers use explicit Symbol injection and export only narrow application ports", () => {
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PipelineLeaseService),
    [{ index: 0, param: PIPELINE_LEASES_REPOSITORY }],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      SELF_DECLARED_DEPS_METADATA,
      NotionAuditDeliveryService,
    ),
    [
      { index: 1, param: NOTION_AUDIT_GATEWAY },
      { index: 0, param: NOTION_AUDIT_OUTBOX_REPOSITORY },
    ],
  );

  const notionAudit: NotionAuditGateway = {
    async finalize() {},
  };
  const module = OperationsApplicationModule.register({ notionAudit });
  assert.deepEqual(module.imports, [OperationsPersistenceModule]);
  assert.deepEqual(module.exports, [
    PIPELINE_LEASE_APPLICATION,
    NOTION_AUDIT_DELIVERY_APPLICATION,
  ]);
  assert.deepEqual(module.providers, [
    { provide: NOTION_AUDIT_GATEWAY, useValue: notionAudit },
    PipelineLeaseService,
    NotionAuditDeliveryService,
    {
      provide: PIPELINE_LEASE_APPLICATION,
      useExisting: PipelineLeaseService,
    },
    {
      provide: NOTION_AUDIT_DELIVERY_APPLICATION,
      useExisting: NotionAuditDeliveryService,
    },
  ]);
});
