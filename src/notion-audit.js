const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const MAX_RICH_TEXT_LENGTH = 2000;

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function richText(content) {
  const text = String(content ?? "").slice(0, MAX_RICH_TEXT_LENGTH);
  return text ? [{ type: "text", text: { content: text } }] : [];
}

function relation(id) {
  return id ? [{ id }] : [];
}

async function notionRequest(fetchImpl, token, path, options) {
  const response = await fetchImpl(`${NOTION_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body.message || `${response.status} ${response.statusText}`;
    throw new Error(`Notion audit request failed: ${detail}`);
  }

  return body;
}

export function getNotionAuditConfig(env = process.env) {
  return {
    token: required(env.NOTION_API_KEY, "NOTION_API_KEY"),
    dataSourceId: required(
      env.NOTION_AGENT_RUNS_DATA_SOURCE_ID ??
        env.NOTION_AGENT_RUNS_DATABASE_ID,
      "NOTION_AGENT_RUNS_DATA_SOURCE_ID",
    ),
    agentPageId: required(
      env.NOTION_PIPELINE_AGENT_PAGE_ID,
      "NOTION_PIPELINE_AGENT_PAGE_ID",
    ),
    ticketPageId: env.NOTION_PIPELINE_TICKET_PAGE_ID?.trim() || null,
  };
}

export class NotionAuditLogger {
  constructor(config, { fetchImpl = fetch, clock = () => new Date() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  async start({ name, objective, links = "" }) {
    const startedAt = this.clock();
    const properties = {
      Name: { type: "title", title: richText(name) },
      Agent: {
        type: "relation",
        relation: relation(this.config.agentPageId),
      },
      Status: { type: "select", select: { name: "Running" } },
      "Started At": {
        type: "date",
        date: { start: startedAt.toISOString() },
      },
      Result: { type: "rich_text", rich_text: richText(objective) },
      Links: { type: "rich_text", rich_text: richText(links) },
    };

    if (this.config.ticketPageId) {
      properties["Task / Ticket"] = {
        type: "relation",
        relation: relation(this.config.ticketPageId),
      };
    }

    const page = await notionRequest(
      this.fetchImpl,
      this.config.token,
      "/pages",
      {
        method: "POST",
        body: JSON.stringify({
          parent: {
            type: "data_source_id",
            data_source_id: this.config.dataSourceId,
          },
          properties,
        }),
      },
    );

    return { pageId: page.id, pageUrl: page.url, startedAt };
  }

  async finish(
    run,
    { status, result, links = "", error = "", finishedAt = this.clock() },
  ) {
    const durationSeconds = Math.max(
      0,
      Math.round((finishedAt.valueOf() - run.startedAt.valueOf()) / 1000),
    );
    return notionRequest(
      this.fetchImpl,
      this.config.token,
      `/pages/${run.pageId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            Status: { type: "select", select: { name: status } },
            "Finished At": {
              type: "date",
              date: { start: finishedAt.toISOString() },
            },
            Duration: { type: "number", number: durationSeconds },
            Result: { type: "rich_text", rich_text: richText(result) },
            Links: { type: "rich_text", rich_text: richText(links) },
            Error: { type: "rich_text", rich_text: richText(error) },
          },
        }),
      },
    );
  }
}

export async function backfillNotionAudits(
  logger,
  repository,
  { limit = 25 } = {},
) {
  const records = await repository.claimNotionAuditBackfill(limit);
  const result = { claimed: records.length, completed: 0, failed: 0 };

  for (const record of records) {
    try {
      await logger.finish(
        {
          pageId: record.notion_page_id,
          startedAt: new Date(record.payload.started_at),
        },
        record.payload.finalization,
      );
      await repository.completeNotionAuditBackfill(record.id);
      result.completed += 1;
    } catch (error) {
      await repository.retryNotionAuditBackfill(record.id, error);
      result.failed += 1;
    }
  }

  return result;
}

export async function withNotionAudit(logger, details, operation) {
  const run = await logger.start(details);

  let outcome;
  try {
    outcome = await operation(run);
  } catch (error) {
    try {
      await logger.finish(run, {
        status: "Failed",
        result: "Automated news pipeline did not complete.",
        links: run.pageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "Pipeline failed and its Notion audit record could not be finalized",
      );
    }
    throw error;
  }

  const finalization = {
    status: "Succeeded",
    result: outcome.auditResult,
    links: outcome.auditLinks,
  };
  try {
    await logger.finish(run, finalization);
  } catch (error) {
    if (!details.onFinalizationFailure) {
      throw error;
    }
    await details.onFinalizationFailure({
      notion_page_id: run.pageId,
      event_type: "finalize_success",
      payload: {
        started_at: run.startedAt.toISOString(),
        finalization,
      },
      last_error: error instanceof Error ? error.message : String(error),
    });
  }

  return outcome.value;
}
