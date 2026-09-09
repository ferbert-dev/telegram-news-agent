import "reflect-metadata";

import assert from "node:assert/strict";

import { Test } from "@nestjs/testing";

const { DRIZZLE_DB, PG_POOL } = await import(
  "../dist/database/database.tokens.js"
);
const { EditorialApplicationModule } = await import(
  "../dist/editorial/editorial-application.module.js"
);
const { EditorialWorkflowService } = await import(
  "../dist/editorial/application/editorial-workflow.service.js"
);
const { LegacyEditorialDraftGateway } = await import(
  "../dist/editorial/legacy-editorial-draft.gateway.js"
);
const { LegacyEditorialDraftGatewayModule } = await import(
  "../dist/editorial/legacy-editorial-draft.module.js"
);
const { EvidenceCorroborationService } = await import(
  "../dist/editorial/corroboration/evidence-corroboration.service.js"
);
const { EDITORIAL_DRAFT_GATEWAY, EDITORIAL_WORKFLOW_APPLICATION } = await import(
  "../dist/editorial/editorial-application.tokens.js"
);
const { EDITORIAL_PERSISTENCE } = await import(
  "../dist/editorial/editorial-persistence.tokens.js"
);
const { NEWS_SETTINGS_REPOSITORY } = await import(
  "../dist/settings/settings.tokens.js"
);
const { USAGE_REPORTING_PERSISTENCE } = await import(
  "../dist/usage/usage-persistence.tokens.js"
);

assert.equal(typeof LegacyEditorialDraftGateway, "function");
assert.equal(typeof LegacyEditorialDraftGatewayModule.register, "function");

const unusedEditorial = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    return async () => { throw new Error("unused emitted persistence"); };
  },
});
const unusedUsage = {
  async recordAiUsage() { throw new Error("unused emitted usage"); },
  async getDailyUsageDashboard() { throw new Error("unused emitted dashboard"); },
};
const unusedSettings = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    return async () => { throw new Error("unused emitted settings"); };
  },
});
const gateways = {
  draft: { async generate() { throw new Error("unused emitted draft gateway"); } },
  publication: { async publish() { throw new Error("unused emitted publication gateway"); } },
  excludedTopics: { async evaluate() { return { decision: "allow" }; } },
};
const fakePool = {
  on() {},
  async query() { throw new Error("unused emitted pool"); },
  async end() {},
};

const moduleRef = await Test.createTestingModule({
  imports: [EditorialApplicationModule.register(gateways)],
})
  .overrideProvider(PG_POOL)
  .useValue(fakePool)
  .overrideProvider(DRIZZLE_DB)
  .useValue({
    async execute() { throw new Error("unused emitted Drizzle execution"); },
    async transaction() { throw new Error("unused emitted Drizzle transaction"); },
  })
  .overrideProvider(EDITORIAL_PERSISTENCE)
  .useValue(unusedEditorial)
  .overrideProvider(USAGE_REPORTING_PERSISTENCE)
  .useValue(unusedUsage)
  .overrideProvider(NEWS_SETTINGS_REPOSITORY)
  .useValue(unusedSettings)
  .compile();

const workflow = moduleRef.get(EDITORIAL_WORKFLOW_APPLICATION);
assert.ok(workflow instanceof EditorialWorkflowService);
assert.equal(moduleRef.get(EditorialWorkflowService), workflow);
await moduleRef.close();

// The draft gateway's own wiring, compiled. It resolves EVIDENCE_CORROBORATION
// out of EvidenceCorroborationModule through a useFactory/inject pair, and an
// inject array that survives `tsx` but not `tsc` emit is exactly the failure
// this file exists to catch. Asserting `register` is a function did not reach
// any of that.
const draftRef = await Test.createTestingModule({
  imports: [
    LegacyEditorialDraftGatewayModule.register({
      model: "emitted-model",
      repository: unusedEditorial,
    }),
  ],
}).compile();

const draftGateway = draftRef.get(EDITORIAL_DRAFT_GATEWAY);
assert.ok(draftGateway instanceof LegacyEditorialDraftGateway);
assert.equal(typeof draftGateway.generate, "function");
// Reads the gateway's own dependencies on purpose. That the module compiles
// and that the token resolves are both true of a factory that quietly received
// `undefined`; the corroboration service reaching the gateway is the thing this
// wiring exists to do, and it is only observable here.
assert.ok(
  draftGateway.dependencies.corroboration instanceof EvidenceCorroborationService,
  "draft gateway must be built with the injected corroboration service",
);
await draftRef.close();
