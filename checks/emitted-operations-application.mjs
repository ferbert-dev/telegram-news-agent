import assert from "node:assert/strict";

const { NotionAuditDeliveryService } = await import(
  "../dist/operations/application/notion-audit-delivery.service.js"
);
const { PipelineLeaseService } = await import(
  "../dist/operations/application/pipeline-lease.service.js"
);
const { OperationsApplicationModule } = await import(
  "../dist/operations/operations-application.module.js"
);
const tokens = await import(
  "../dist/operations/operations-application.tokens.js"
);

const leaseCalls = [];
const leases = new PipelineLeaseService({
  async acquirePipelineLease(...args) {
    leaseCalls.push(["acquire", ...args]);
    return true;
  },
  async renewPipelineLease(...args) {
    leaseCalls.push(["renew", ...args]);
    return true;
  },
  async releasePipelineLease(...args) {
    leaseCalls.push(["release", ...args]);
    return true;
  },
});
assert.equal(
  await leases.acquire({ name: "emitted", ownerId: "owner", ttlSeconds: 30 }),
  true,
);
assert.deepEqual(leaseCalls[0], ["acquire", "emitted", "owner", 30]);

const deliveryCalls = [];
const delivery = new NotionAuditDeliveryService(
  {
    async enqueueNotionAuditBackfill() {
      throw new Error("unused");
    },
    async claimNotionAuditBackfill(limit) {
      assert.equal(limit, 1);
      return [{
        id: "outbox",
        notion_page_id: "run",
        payload: {
          started_at: "2026-08-12T10:00:00.000Z",
          finalization: { status: "Succeeded" },
        },
      }];
    },
    async completeNotionAuditBackfill(id) {
      deliveryCalls.push(["complete", id]);
      return true;
    },
    async retryNotionAuditBackfill() {
      throw new Error("must not retry");
    },
  },
  {
    async finalize(run) {
      deliveryCalls.push(["finalize", run.pageId]);
    },
  },
);
assert.deepEqual(await delivery.deliverPending({ limit: 1 }), {
  claimed: 1,
  completed: 1,
  failed: 0,
});
assert.deepEqual(deliveryCalls, [
  ["finalize", "run"],
  ["complete", "outbox"],
]);

const dynamicModule = OperationsApplicationModule.register({
  notionAudit: { async finalize() {} },
});
assert.equal(dynamicModule.module, OperationsApplicationModule);
assert.deepEqual(dynamicModule.exports, [
  tokens.PIPELINE_LEASE_APPLICATION,
  tokens.NOTION_AUDIT_DELIVERY_APPLICATION,
]);
