import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyEditorialPublicationGateway,
  type LegacyEditorialPublicationGatewayDependencies,
} from "../../src/editorial/legacy-editorial-publication.gateway.js";
import {
  LegacyEditorialPublicationPolicyGateway,
} from "../../src/editorial/legacy-editorial-publication-policy.gateway.js";
import {
  LegacyEditorialPublicationAdaptersModule,
} from "../../src/editorial/legacy-editorial-publication.module.js";
import { PublicationDeliveryError } from "../../src/editorial/editorial-application.contracts.js";
import { TelegramError } from "../../src/telegram.js";
import { EXCLUDED_TOPIC_POLICY_PROMPT_VERSION } from "../../src/excluded-topic-policy.js";

const BASE_INPUT = {
  draftId: "draft-1",
  articleId: "article-1",
  channelId: "@channel",
  content: { text: "Grounded draft text about war." },
  settings: {
    version: 2,
    excludedTopicCodes: ["war_conflict"],
  },
};

test("LegacyEditorialPublicationGateway maps a successful send into a typed receipt", async () => {
  let sendArgs: unknown;
  const dependencies: LegacyEditorialPublicationGatewayDependencies = {
    token: "legacy-token",
    sendMessage: async (
      token,
      channelId,
      text,
      disableNotification,
      signal,
      entities,
    ) => {
      sendArgs = { token, channelId, text, disableNotification, signal, entities };
      return { message_id: "82", date: 1720000000 };
    },
  };
  const gateway = new LegacyEditorialPublicationGateway(dependencies);
  const receipt = await gateway.publish({
    channelId: BASE_INPUT.channelId,
    text: BASE_INPUT.content.text,
    disableNotification: false,
  });
  assert.deepEqual(sendArgs, {
    token: "legacy-token",
    channelId: "@channel",
    text: BASE_INPUT.content.text,
    disableNotification: false,
    signal: undefined,
    entities: [
      {
        type: "bold",
        offset: 0,
        length: BASE_INPUT.content.text.length,
      },
    ],
  });
  assert.deepEqual(receipt, { messageId: 82, messageDate: 1720000000 });
});

test("LegacyEditorialPublicationGateway converts TelegramError to PublicationDeliveryError(outcome=rejected)", async () => {
  const gateway = new LegacyEditorialPublicationGateway({
    token: "legacy-token",
    sendMessage: async () => {
      throw new TelegramError("sendMessage", 403, 403, "forbidden");
    },
  });

  await assert.rejects(
    gateway.publish({
      channelId: "@channel",
      text: BASE_INPUT.content.text,
      disableNotification: false,
    }),
    (error) =>
      error instanceof PublicationDeliveryError &&
      error.outcome === "rejected",
  );
});

test("LegacyEditorialPublicationGateway preserves local validation and invalid-receipt uncertainty", async () => {
  const defaultGateway = new LegacyEditorialPublicationGateway({
    token: "legacy-token",
  });
  await assert.rejects(
    defaultGateway.publish({
      channelId: "@channel",
      text: "   ",
      disableNotification: false,
    }),
    /Message text is required/,
  );

  let sendCount = 0;
  const invalidReceipt = new LegacyEditorialPublicationGateway({
    token: "legacy-token",
    sendMessage: async () => {
      sendCount += 1;
      return { message_id: "not-a-message-id" };
    },
  });

  await assert.rejects(
    invalidReceipt.publish({
      channelId: "@channel",
      text: BASE_INPUT.content.text,
      disableNotification: false,
    }),
    /invalid Telegram message id/,
  );
  assert.equal(sendCount, 1);
});

test("LegacyEditorialPublicationPolicyGateway preserves block/allow behavior and usage passthrough", async () => {
  const allowPolicy = new LegacyEditorialPublicationPolicyGateway({});
  const allowResult = await allowPolicy.evaluate({
    ...BASE_INPUT,
    settings: { ...BASE_INPUT.settings, excludedTopicCodes: [] },
  });
  assert.deepEqual(allowResult, { decision: "allow", usageEvents: [] });

  const policy = new LegacyEditorialPublicationPolicyGateway({
    aiProvider: {
      async generateStructured() {
        return {
          provider: "openai",
          model: "gpt-4o-mini",
          usageEvents: [{ provider: "openai", model: "gpt-4o-mini", operation: "excluded_topic_publication_veto" }],
          value: {
            assessments: [{ topicCode: "war_conflict", relation: "main_subject" }],
          },
        };
      },
    },
  });
  const blockedResult = await policy.evaluate(BASE_INPUT);
  assert.equal(blockedResult.decision, "block");
  assert.equal(blockedResult.reasonCode, "excluded_topic_main_subject");
  assert.equal(blockedResult.topicCode, "war_conflict");
  assert.equal(blockedResult.provider, "openai");
  assert.equal(blockedResult.model, "gpt-4o-mini");
  assert.equal(blockedResult.usageEvents?.length, 1);
});

test("LegacyEditorialPublicationPolicyGateway fail-closes missing, failed, and malformed classifiers", async () => {
  const missing = await new LegacyEditorialPublicationPolicyGateway({}).evaluate(
    BASE_INPUT,
  );
  assert.deepEqual(missing, {
    decision: "block",
    topicCode: "war_conflict",
    reasonCode: "excluded_topic_classifier_error",
    provider: null,
    model: null,
    promptVersion: EXCLUDED_TOPIC_POLICY_PROMPT_VERSION,
    usageEvents: [],
  });

  const failed = await new LegacyEditorialPublicationPolicyGateway({
    aiProvider: {
      async generateStructured() {
        throw new Error("provider response must stay private");
      },
    },
  }).evaluate(BASE_INPUT);
  assert.equal(failed.decision, "block");
  assert.equal(failed.reasonCode, "excluded_topic_classifier_error");

  const malformed = await new LegacyEditorialPublicationPolicyGateway({
    aiProvider: {
      async generateStructured() {
        return {
          provider: "unsafe provider value",
          model: "unsafe model value",
          value: { assessments: [] },
        };
      },
    },
  }).evaluate(BASE_INPUT);
  assert.equal(malformed.decision, "block");
  assert.equal(malformed.reasonCode, "excluded_topic_uncertain");
  assert.equal(malformed.topicCode, "war_conflict");
  assert.equal(malformed.provider, null);
  assert.equal(malformed.model, null);
});

test("LegacyEditorialPublicationPolicyGateway honors cancellation before provider work", async () => {
  let calls = 0;
  const policy = new LegacyEditorialPublicationPolicyGateway({
    aiProvider: {
      async generateStructured() {
        calls += 1;
        return { value: { assessments: [] } };
      },
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(policy.evaluate(BASE_INPUT, controller.signal), /stop/);
  assert.equal(calls, 0);
});

test("LegacyEditorialPublicationAdaptersModule supports symbol replaceability", () => {
  const customPublication = Symbol("CUSTOM_PUBLICATION_GATEWAY");
  const customPolicy = Symbol("CUSTOM_TOPIC_POLICY_GATEWAY");
  const providerEntries = (module: { providers?: unknown }) =>
    ((module.providers ?? []) as Array<{ provide?: symbol }>).map(
      (provider) => provider.provide ?? null,
    );
  const module = LegacyEditorialPublicationAdaptersModule.register(
    {
      publication: { token: "legacy-token" },
      excludedTopicPolicy: {
        aiProvider: {
          async generateStructured() {
            return {
              value: { assessments: [{ topicCode: "war_conflict", relation: "unrelated" }] },
            };
          },
        },
      },
    },
    customPublication,
    customPolicy,
  );
  assert.deepEqual(providerEntries(module), [
    customPublication,
    customPolicy,
  ]);
  assert.deepEqual(module.exports, [customPublication, customPolicy]);
});
