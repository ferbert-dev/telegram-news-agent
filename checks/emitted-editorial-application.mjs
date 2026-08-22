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
const { EDITORIAL_WORKFLOW_APPLICATION } = await import(
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
