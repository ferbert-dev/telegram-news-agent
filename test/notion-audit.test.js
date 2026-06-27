import assert from "node:assert/strict";
import test from "node:test";
import {
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
