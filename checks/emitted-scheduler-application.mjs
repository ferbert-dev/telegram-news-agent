import "reflect-metadata";

import assert from "node:assert/strict";

import { Test } from "@nestjs/testing";

const { DRIZZLE_DB, PG_POOL } = await import(
  "../dist/database/database.tokens.js"
);
const { SchedulerService } = await import(
  "../dist/scheduler/application/scheduler.service.js"
);
const { SchedulerApplicationModule } = await import(
  "../dist/scheduler/scheduler-application.module.js"
);
const { SCHEDULER_APPLICATION } = await import(
  "../dist/scheduler/scheduler-application.tokens.js"
);

const fakePool = {
  on() {},
  async query() { throw new Error("unused emitted pool"); },
  async end() {},
};
const moduleRef = await Test.createTestingModule({
  imports: [
    SchedulerApplicationModule.register({
      newsWorkflow: {
        async run() { return { status: "no_candidates" }; },
      },
      editorial: {
        async generateReviewDraft() { throw new Error("unused generation"); },
        async publishApprovedDraft() { throw new Error("unused publication"); },
        async reconcilePublication() { throw new Error("unused recovery"); },
      },
      pipelineLease: {
        async acquire() { return true; },
        async renew() { return true; },
        async release() { return true; },
      },
      reviewDelivery: {
        async deliver() { return { status: "review_ready" }; },
      },
      audit: {
        async run(_context, operation) { return operation(); },
      },
      notification: { async notify() {} },
    }),
  ],
})
  .overrideProvider(PG_POOL)
  .useValue(fakePool)
  .overrideProvider(DRIZZLE_DB)
  .useValue({
    async execute() { throw new Error("unused emitted Drizzle execution"); },
    async transaction() { throw new Error("unused emitted Drizzle transaction"); },
  })
  .compile();

const application = moduleRef.get(SCHEDULER_APPLICATION);
assert.ok(application instanceof SchedulerService);
assert.equal(moduleRef.get(SchedulerService), application);
assert.equal(typeof application.runOnce, "function");
await moduleRef.close();
