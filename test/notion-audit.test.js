import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillNotionAudits,
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "../src/notion-audit.js";

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    async json() {
      return body;
    },
  };
}

test("getNotionAuditConfig requires all server-side audit settings", () => {
  assert.throws(() => getNotionAuditConfig({}), /NOTION_API_KEY/);
  assert.deepEqual(
    getNotionAuditConfig({
      NOTION_API_KEY: "secret",
      NOTION_AGENT_RUNS_DATA_SOURCE_ID: "runs",
      NOTION_PIPELINE_AGENT_PAGE_ID: "agent",
    }),
    {
      token: "secret",
      dataSourceId: "runs",
      agentPageId: "agent",
      ticketPageId: null,
    },
  );
});

test("withNotionAudit creates and finalizes a successful run", async () => {
  const requests = [];
  const times = [
    new Date("2026-06-27T10:00:00Z"),
    new Date("2026-06-27T10:00:12Z"),
  ];
  const logger = new NotionAuditLogger(
    {
      token: "secret",
      dataSourceId: "runs",
      agentPageId: "agent",
      ticketPageId: null,
    },
    {
      clock: () => times.shift(),
      fetchImpl: async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return requests.length === 1
          ? response({ id: "run-1", url: "https://notion.test/run-1" })
          : response({ id: "run-1" });
      },
    },
  );

  const value = await withNotionAudit(
    logger,
    { name: "Pipeline", objective: "Create a draft" },
    async () => ({
      value: "done",
      auditResult: "Draft created",
      auditLinks: "https://example.com",
    }),
  );

  assert.equal(value, "done");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].body.parent.type, "data_source_id");
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].body.properties.Status.select.name, "Succeeded");
  assert.equal(requests[1].body.properties.Duration.number, 12);
});

test("withNotionAudit finalizes a failed operation and rethrows", async () => {
  const requests = [];
  const logger = new NotionAuditLogger(
    {
      token: "secret",
      dataSourceId: "runs",
      agentPageId: "agent",
      ticketPageId: null,
    },
    {
      clock: () => new Date("2026-06-27T10:00:00Z"),
      fetchImpl: async (url, options) => {
        requests.push(JSON.parse(options.body));
        return requests.length === 1
          ? response({ id: "run-2", url: "https://notion.test/run-2" })
          : response({ id: "run-2" });
      },
    },
  );

  await assert.rejects(
    withNotionAudit(
      logger,
      { name: "Pipeline", objective: "Create a draft" },
      async () => {
        throw new Error("Gemini key missing");
      },
    ),
    /Gemini key missing/,
  );
  assert.equal(requests[1].properties.Status.select.name, "Failed");
  assert.equal(
    requests[1].properties.Error.rich_text[0].text.content,
    "Gemini key missing",
  );
});

test("withNotionAudit never starts work when audit creation fails", async () => {
  let operationCalled = false;
  const logger = new NotionAuditLogger(
    {
      token: "secret",
      dataSourceId: "runs",
      agentPageId: "agent",
      ticketPageId: null,
    },
    {
      fetchImpl: async () =>
        response({ message: "integration has no access" }, false),
    },
  );

  await assert.rejects(
    withNotionAudit(
      logger,
      { name: "Pipeline", objective: "Create a draft" },
      async () => {
        operationCalled = true;
      },
    ),
    /integration has no access/,
  );
  assert.equal(operationCalled, false);
});

test("successful business outcome survives finalization failure with durable backfill", async () => {
  const outbox = [];
  let requests = 0;
  const startedAt = new Date("2026-06-27T10:00:00.000Z");
  const logger = new NotionAuditLogger(
    {
      token: "secret",
      dataSourceId: "runs",
      agentPageId: "agent",
      ticketPageId: null,
    },
    {
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? response({ id: "run-3", url: "https://notion.test/run-3" })
          : response({ message: "Notion unavailable" }, false);
      },
      clock: () => startedAt,
    },
  );

  const value = await withNotionAudit(
    logger,
    {
      name: "Pipeline",
      objective: "Publish once",
      async onFinalizationFailure(record) {
        outbox.push(record);
      },
    },
    async () => ({
      value: { publicationId: "post-1" },
      auditResult: "Published post-1",
      auditLinks: "https://t.me/channel/1",
    }),
  );

  assert.deepEqual(value, { publicationId: "post-1" });
  assert.deepEqual(outbox, [
    {
      notion_page_id: "run-3",
      event_type: "finalize_success",
      payload: {
        started_at: startedAt.toISOString(),
        finalization: {
          status: "Succeeded",
          result: "Published post-1",
          links: "https://t.me/channel/1",
        },
      },
      last_error: "Notion audit request failed: Notion unavailable",
    },
  ]);
  assert.equal(requests, 2);
});

test("backfill replays claimed finalizations and marks successes complete", async () => {
  const calls = [];
  const logger = {
    async finish(run, finalization) {
      calls.push(["finish", run.pageId, finalization.status]);
    },
  };
  const repository = {
    async claimNotionAuditBackfill(limit) {
      calls.push(["claim", limit]);
      return [{
        id: "outbox-1",
        notion_page_id: "run-3",
        payload: {
          started_at: "2026-06-27T10:00:00.000Z",
          finalization: { status: "Succeeded", result: "Published" },
        },
      }];
    },
    async completeNotionAuditBackfill(id) {
      calls.push(["complete", id]);
    },
    async retryNotionAuditBackfill() {
      assert.fail("successful replay must not be retried");
    },
  };

  const result = await backfillNotionAudits(logger, repository, { limit: 10 });

  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(calls, [
    ["claim", 10],
    ["finish", "run-3", "Succeeded"],
    ["complete", "outbox-1"],
  ]);
});

test("backfill schedules failed finalizations for retry without stopping the batch", async () => {
  const retries = [];
  const repository = {
    async claimNotionAuditBackfill() {
      return [{
        id: "outbox-1",
        notion_page_id: "run-3",
        payload: {
          started_at: "2026-06-27T10:00:00.000Z",
          finalization: { status: "Succeeded", result: "Published" },
        },
      }];
    },
    async completeNotionAuditBackfill() {
      assert.fail("failed replay must not be completed");
    },
    async retryNotionAuditBackfill(id, error) {
      retries.push([id, error.message]);
    },
  };

  const result = await backfillNotionAudits(
    { async finish() { throw new Error("Notion unavailable"); } },
    repository,
  );

  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
  assert.deepEqual(retries, [["outbox-1", "Notion unavailable"]]);
});
