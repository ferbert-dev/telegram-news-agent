import "reflect-metadata";

import assert from "node:assert/strict";

import { Test } from "@nestjs/testing";

const { DRIZZLE_DB, PG_POOL } = await import(
  "../dist/database/database.tokens.js"
);
const { TelegramControlService } = await import(
  "../dist/telegram/application/telegram-control.service.js"
);
const { TelegramControlApplicationModule } = await import(
  "../dist/telegram/telegram-control-application.module.js"
);
const { TELEGRAM_CONTROL_APPLICATION } = await import(
  "../dist/telegram/telegram-application.tokens.js"
);
const { TelegramBotApiGateway } = await import(
  "../dist/telegram/transport/telegram-bot-api.gateway.js"
);
const { TelegramBotApiOutcomeRenderer } = await import(
  "../dist/telegram/transport/telegram-bot-api.gateway.js"
);
const {
  TelegramLegacyLabsGateway,
  TelegramLegacySettingsGateway,
  TelegramLegacyStatsGateway,
} = await import(
  "../dist/telegram/transport/telegram-legacy-feature.gateways.js"
);
const { TelegramControlTransportHandler } = await import(
  "../dist/telegram/transport/telegram-control-transport.handler.js"
);

assert.equal(typeof TelegramBotApiGateway, "function");
assert.equal(typeof TelegramBotApiOutcomeRenderer, "function");
assert.equal(typeof TelegramLegacySettingsGateway, "function");
assert.equal(typeof TelegramLegacyLabsGateway, "function");
assert.equal(typeof TelegramLegacyStatsGateway, "function");
assert.equal(typeof TelegramControlTransportHandler, "function");

const unused = { async execute() { return { status: "unused" }; } };
const fakePool = {
  on() {},
  async query() { throw new Error("unused emitted pool"); },
  async end() {},
};
const moduleRef = await Test.createTestingModule({
  imports: [
    TelegramControlApplicationModule.register({
      authorization: { async isChannelAdmin() { return true; } },
      audit: { async run(_context, operation) { return operation(); } },
      news: { async run() { return { status: "no_candidates" }; } },
      editorial: {
        async generateReviewDraft() { throw new Error("unused emitted generation"); },
        async publishApprovedDraft() { throw new Error("unused emitted publication"); },
        async reconcilePublication() { throw new Error("unused emitted recovery"); },
      },
      reviewPresentation: {
        async restoreControls() { return "missing"; },
        async disableControls() {},
        async answerCallback() {},
        async sendReview() { return { messageId: 1 }; },
      },
      settings: unused,
      labs: unused,
      stats: unused,
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

const application = moduleRef.get(TELEGRAM_CONTROL_APPLICATION);
assert.ok(application instanceof TelegramControlService);
assert.equal(moduleRef.get(TelegramControlService), application);
await moduleRef.close();
