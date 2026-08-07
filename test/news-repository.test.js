import assert from "node:assert/strict";
import test from "node:test";
import { NewsRepository } from "../src/news-repository.js";

test("createReviewDraft delegates all state changes to one transactional function", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      return {
        rows: [{ id: "draft-1", article_id: parameters[0] }],
      };
    },
  });

  const draft = await repository.createReviewDraft({
    article_id: "article-1",
    body: "Grounded draft",
    model: "model",
    prompt_version: "v1",
    reviewer_notes: "{}",
  });

  assert.equal(draft.id, "draft-1");
  assert.equal(
    calls[0][0],
    "select * from public.create_review_draft($1, $2, $3, $4, $5, $6, $7)",
  );
  assert.deepEqual(calls[0][1], [
    "article-1",
    "Grounded draft",
    "model",
    "v1",
    "{}",
    null,
    null,
  ]);
});

test("createReviewDraft surfaces transaction failures without fallback writes", async () => {
  let calls = 0;
  const repository = new NewsRepository({
    async query() {
      calls += 1;
      throw new Error("injected failure after draft insert");
    },
  });

  await assert.rejects(
    repository.createReviewDraft({
      article_id: "article-1",
      body: "Grounded draft",
    }),
    /Create review draft failed: injected failure after draft insert/,
  );
  assert.equal(calls, 1);
});

test("audit backfill lifecycle uses PostgreSQL functions", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      return {
        rows: text.includes("claim_notion_audit_backfill")
          ? [{ id: "outbox-1" }]
          : [{ value: true }],
      };
    },
  });

  assert.equal((await repository.claimNotionAuditBackfill(10))[0].id, "outbox-1");
  assert.equal(await repository.completeNotionAuditBackfill("outbox-1"), true);
  assert.equal(
    await repository.retryNotionAuditBackfill("outbox-2", new Error("offline")),
    true,
  );
  assert.deepEqual(calls, [
    ["select * from public.claim_notion_audit_backfill($1)", [10]],
    ["select public.complete_notion_audit_backfill($1) as value", ["outbox-1"]],
    [
      "select public.retry_notion_audit_backfill($1, $2) as value",
      ["outbox-2", "offline"],
    ],
  ]);
});

test("repository rejects PostgreSQL writes that unexpectedly match no rows", async () => {
  const repository = new NewsRepository({
    async query() {
      return { rows: [] };
    },
  });

  await assert.rejects(
    repository.setSourceEnabled("missing", true),
    /Enable source failed: expected one row, received 0/,
  );
});

test("source registry excludes active quarantine and exposes topic mappings", async () => {
  let query;
  const repository = new NewsRepository({
    async query(text) {
      query = text;
      return { rows: [] };
    },
  });

  assert.deepEqual(await repository.listEnabledSources(), []);
  assert.match(query, /disabled_until is null or s\.disabled_until <= now\(\)/);
  assert.match(query, /array_agg\(t\.name order by t\.name\)/);
});

test("source health and discovery methods preserve PostgreSQL bindings", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      if (text.includes("claim_source_discovery")) {
        return { rows: [{ value: true }] };
      }
      if (text.includes("complete_source_discovery")) {
        return { rows: [{ value: true }] };
      }
      return {
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Discovered",
          },
        ],
      };
    },
  });

  await repository.markSourceFetchSuccess(
    "00000000-0000-4000-8000-000000000001",
  );
  await repository.markSourceFetchFailure(
    "00000000-0000-4000-8000-000000000001",
    "http_503",
  );
  assert.equal(await repository.claimSourceDiscovery("a".repeat(64)), true);
  assert.equal(
    await repository.completeSourceDiscovery({
      topicKey: "a".repeat(64),
      provider: "openai",
      model: "gpt-5.4-2026-03-05",
      resultCount: 2,
    }),
    true,
  );
  await repository.upsertDiscoveredSource({
    name: "Discovered",
    homepageUrl: "https://example.com/",
    feedUrl: "https://example.com/feed.xml",
    topicCodes: ["science"],
    discoveredBy: "openai",
    discoveryMetadata: { custom_topics: [] },
  });

  assert.deepEqual(calls, [
    [
      "select * from public.mark_source_fetch_success($1)",
      ["00000000-0000-4000-8000-000000000001"],
    ],
    [
      "select * from public.mark_source_fetch_failure($1, $2)",
      ["00000000-0000-4000-8000-000000000001", "http_503"],
    ],
    ["select public.claim_source_discovery($1) as value", ["a".repeat(64)]],
    [
      "select public.complete_source_discovery($1, $2, $3, $4, $5) as value",
      ["a".repeat(64), "openai", "gpt-5.4-2026-03-05", 2, null],
    ],
    [
      "select * from public.upsert_discovered_source($1, $2, $3, $4, $5, $6, $7)",
      [
        "Discovered",
        "https://example.com/",
        "https://example.com/feed.xml",
        65,
        ["science"],
        "openai",
        { custom_topics: [] },
      ],
    ],
  ]);
});

test("news settings repository methods use versioned PostgreSQL functions", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      if (text.includes("update_news_settings")) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            telegram_channel_id: "@channel",
            review_chat_id: 42,
            version: 1,
          },
        ],
      };
    },
  });

  const created = await repository.getOrCreateNewsSettings({
    channelId: "@channel",
    reviewChatId: 42,
    updatedBy: 7,
  });
  assert.equal(created.version, 1);
  assert.equal((await repository.getNewsSettings("@channel")).review_chat_id, 42);
  assert.equal(
    await repository.updateNewsSettings({
      channelId: "@channel",
      reviewChatId: 42,
      scheduleIntervalMinutes: 360,
      languageCode: "uk",
      topicCodes: ["world", "nature"],
      customTopics: ["Ocean exploration"],
      approvalPolicy: "automatic",
      updatedBy: 7,
      expectedVersion: 1,
    }),
    null,
  );

  assert.deepEqual(calls, [
    [
      "select * from public.get_or_create_news_settings($1, $2, $3)",
      ["@channel", 42, 7],
    ],
    ["select * from public.get_news_settings($1)", ["@channel"]],
    [
      "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        "@channel",
        42,
        360,
        "uk",
        ["world", "nature"],
        ["Ocean exploration"],
        "automatic",
        7,
        1,
      ],
    ],
  ]);
});

test("settings input and scheduler repository methods preserve bindings", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      if (
        text.includes("finish_news_schedule") ||
        text.includes("save_news_schedule") ||
        text.includes("renew_news_schedule") ||
        text.includes("pause_news_schedule") ||
        text.includes("has_pending")
      ) {
        return { rows: [{ value: true }] };
      }
      if (text.includes("consume_telegram_settings_input")) {
        return { rows: [] };
      }
      return { rows: [{ id: "input-1", schedule_claim_token: "claim-1" }] };
    },
  });
  const expiresAt = "2026-08-07T16:00:00.000Z";

  assert.equal(
    (
      await repository.beginTelegramSettingsInput({
        controlChatId: 10,
        requestedBy: 20,
        promptMessageId: 30,
        expiresAt,
      })
    ).id,
    "input-1",
  );
  assert.equal(
    await repository.consumeTelegramSettingsInput({
      controlChatId: 10,
      requestedBy: 20,
      promptMessageId: 30,
    }),
    null,
  );
  assert.equal(
    (
      await repository.claimDueNewsSchedule({
        claimToken: "claim-1",
        staleAfterSeconds: 60,
      })
    ).schedule_claim_token,
    "claim-1",
  );
  assert.equal(
    await repository.saveNewsScheduleDraft({
      channelId: "@channel",
      claimToken: "claim-1",
      draftId: "draft-1",
      preview: "Preview",
      windowHours: 48,
    }),
    true,
  );
  assert.equal(
    await repository.saveNewsSchedulePublication({
      channelId: "@channel",
      claimToken: "claim-1",
      draftId: "draft-1",
      publicationMessageId: 99,
    }),
    true,
  );
  assert.equal(
    await repository.renewNewsScheduleClaim({
      channelId: "@channel",
      claimToken: "claim-1",
    }),
    true,
  );
  assert.equal(
    await repository.finishNewsSchedule({
      channelId: "@channel",
      claimToken: "claim-1",
      status: "published",
    }),
    true,
  );
  assert.equal(await repository.hasPendingTelegramReview("@channel"), true);

  assert.deepEqual(calls, [
    [
      "select * from public.begin_telegram_settings_input($1, $2, $3, $4)",
      [10, 20, 30, expiresAt],
    ],
    [
      "select * from public.consume_telegram_settings_input($1, $2, $3)",
      [10, 20, 30],
    ],
    [
      "select * from public.claim_due_news_schedule($1, $2)",
      ["claim-1", 60],
    ],
    [
      "select public.save_news_schedule_draft($1, $2, $3, $4, $5) as value",
      ["@channel", "claim-1", "draft-1", "Preview", 48],
    ],
    [
      "select public.save_news_schedule_publication($1, $2, $3, $4) as value",
      ["@channel", "claim-1", "draft-1", 99],
    ],
    [
      "select public.renew_news_schedule_claim($1, $2) as value",
      ["@channel", "claim-1"],
    ],
    [
      "select public.finish_news_schedule($1, $2, $3, $4) as value",
      ["@channel", "claim-1", "published", null],
    ],
    ["select public.has_pending_telegram_review($1) as value", ["@channel"]],
  ]);
});

test("AI usage ledger records provider metrics and returns a daily dashboard", async () => {
  const calls = [];
  const repository = new NewsRepository({
    async query(text, parameters) {
      calls.push([text, parameters]);
      if (text.includes("insert into public.ai_usage_events")) {
        return { rows: [{ id: "usage-1", provider: parameters[0] }] };
      }
      if (text.includes("priced_request_count")) {
        return {
          rows: [
            {
              request_count: "1",
              input_tokens: "100",
              estimated_cost_usd: "0.01000000",
            },
          ],
        };
      }
      return {
        rows: [
          {
            telegram_message_id: "42",
            editor_name: "Михаил Онест",
            estimated_cost_usd: "0.01000000",
          },
        ],
      };
    },
  });

  const usage = await repository.recordAiUsage({
    provider: "openai",
    providerResponseId: "resp_1",
    model: "gpt-5.4-2026-03-05",
    operation: "news_search",
    telegramChannelId: "@channel",
    searchRunId: "00000000-0000-4000-8000-000000000001",
    inputTokens: 100,
    outputTokens: 50,
    webSearchCalls: 1,
    estimatedCostUsd: 0.01075,
    pricingSnapshot: { tier: "standard" },
  });
  const dashboard = await repository.getDailyUsageDashboard({
    channelId: "@channel",
    now: "2026-08-07T14:00:00.000Z",
  });

  assert.equal(usage.id, "usage-1");
  assert.equal(calls[0][1][0], "openai");
  assert.equal(calls[0][1][1], "resp_1");
  assert.equal(calls[0][1][7], 100);
  assert.equal(calls[0][1][11], 1);
  assert.equal(dashboard.summary.request_count, "1");
  assert.equal(dashboard.posts[0].editor_name, "Михаил Онест");
  assert.deepEqual(calls[1][1], [
    "@channel",
    "2026-08-07T14:00:00.000Z",
    "Europe/Madrid",
  ]);
  assert.deepEqual(calls[2][1], [
    "@channel",
    "2026-08-07T14:00:00.000Z",
    "Europe/Madrid",
    5,
  ]);
});
