import { assertTransition } from "./pipeline-states.js";

function now() {
  return new Date().toISOString();
}

function selectedEntries(record, allowedColumns) {
  return allowedColumns
    .filter((column) => record[column] !== undefined)
    .map((column) => [column, record[column]]);
}

function placeholders(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => `$${index + offset + 1}`);
}

const SOURCE_COLUMNS = [
  "name",
  "homepage_url",
  "feed_url",
  "source_type",
  "reliability_score",
  "enabled",
  "is_primary",
  "last_checked_at",
  "updated_at",
];
const RAW_CONTENT_COLUMNS = [
  "article_id",
  "content",
  "content_type",
  "language_code",
  "fetched_at",
  "extractor",
  "content_hash",
  "metadata",
];
const DRAFT_COLUMNS = [
  "article_id",
  "body",
  "status",
  "model",
  "prompt_version",
  "reviewer_notes",
  "approved_at",
  "updated_at",
];
const ARTICLE_UPDATE_COLUMNS = [
  "source_id",
  "search_run_id",
  "canonical_url",
  "title",
  "author",
  "published_at",
  "content_hash",
  "status",
  "metadata",
  "updated_at",
];
const PUBLICATION_COLUMNS = [
  "draft_id",
  "article_id",
  "telegram_channel_id",
  "telegram_message_id",
  "published_at",
  "message_text",
  "metadata",
];
const CHECKPOINT_COLUMNS = [
  "update_id",
  "status",
  "draft_id",
  "preview",
  "window_hours",
  "updated_at",
];
const REVIEW_SESSION_COLUMNS = [
  "id",
  "draft_id",
  "control_chat_id",
  "preview_message_id",
  "requested_by",
  "decision",
  "decided_by",
  "decided_at",
  "expires_at",
];
const AUDIT_OUTBOX_COLUMNS = [
  "notion_page_id",
  "event_type",
  "payload",
  "attempt_count",
  "available_at",
  "last_error",
  "completed_at",
  "claimed_at",
];

export class NewsRepository {
  constructor(client) {
    if (!client?.query) {
      throw new Error("A PostgreSQL query client is required");
    }
    this.client = client;
  }

  async query(operation, text, values = []) {
    try {
      return await this.client.query(text, values);
    } catch (error) {
      throw new Error(`${operation} failed: ${error.message}`, { cause: error });
    }
  }

  one(result, operation) {
    if (result.rows.length !== 1) {
      throw new Error(
        `${operation} failed: expected one row, received ${result.rows.length}`,
      );
    }
    return result.rows[0];
  }

  scalar(result, operation) {
    const row = this.one(result, operation);
    return row.value;
  }

  async insertRow(table, record, allowedColumns, operation) {
    const entries = selectedEntries(record, allowedColumns);
    if (!entries.length) {
      throw new Error(`${operation} failed: no values were provided`);
    }
    const columns = entries.map(([column]) => column);
    const result = await this.query(
      operation,
      `insert into public.${table} (${columns.join(", ")}) values (${placeholders(entries.length).join(", ")}) returning *`,
      entries.map(([, value]) => value),
    );
    return this.one(result, operation);
  }

  async upsertRow(
    table,
    record,
    allowedColumns,
    conflictColumns,
    operation,
  ) {
    const entries = selectedEntries(record, allowedColumns);
    const columns = entries.map(([column]) => column);
    const updates = columns
      .filter((column) => !conflictColumns.includes(column))
      .map((column) => `${column} = excluded.${column}`);
    if (!entries.length || !updates.length) {
      throw new Error(`${operation} failed: insufficient values were provided`);
    }
    const result = await this.query(
      operation,
      `insert into public.${table} (${columns.join(", ")}) values (${placeholders(entries.length).join(", ")}) on conflict (${conflictColumns.join(", ")}) do update set ${updates.join(", ")} returning *`,
      entries.map(([, value]) => value),
    );
    return this.one(result, operation);
  }

  async updateState(table, id, from, to, changes, allowedColumns, operation) {
    const entries = selectedEntries(
      { ...changes, status: to, updated_at: now() },
      allowedColumns,
    );
    const setters = entries.map(
      ([column], index) => `${column} = $${index + 1}`,
    );
    const result = await this.query(
      operation,
      `update public.${table} set ${setters.join(", ")} where id = $${entries.length + 1} and status = $${entries.length + 2} returning *`,
      [...entries.map(([, value]) => value), id, from],
    );
    return this.one(result, operation);
  }

  async functionRows(name, args, operation) {
    const result = await this.query(
      operation,
      `select * from public.${name}(${placeholders(args.length).join(", ")})`,
      args,
    );
    return result.rows;
  }

  async functionScalar(name, args, operation) {
    const result = await this.query(
      operation,
      `select public.${name}(${placeholders(args.length).join(", ")}) as value`,
      args,
    );
    return this.scalar(result, operation);
  }

  async listEnabledSources() {
    const result = await this.query(
      "List enabled sources",
      "select * from public.sources where enabled = true order by reliability_score desc nulls last",
    );
    return result.rows;
  }

  async upsertSource(source) {
    return this.upsertRow(
      "sources",
      { ...source, updated_at: now() },
      SOURCE_COLUMNS,
      ["feed_url"],
      "Upsert source",
    );
  }

  async setSourceEnabled(id, enabled) {
    const operation = `${enabled ? "Enable" : "Disable"} source`;
    const result = await this.query(
      operation,
      "update public.sources set enabled = $1, updated_at = $2 where id = $3 returning *",
      [enabled, now(), id],
    );
    return this.one(result, operation);
  }

  async markSourceChecked(id) {
    const operation = "Mark source checked";
    const timestamp = now();
    const result = await this.query(
      operation,
      "update public.sources set last_checked_at = $1, updated_at = $1 where id = $2 returning *",
      [timestamp, id],
    );
    return this.one(result, operation);
  }

  async startSearchRun({ query, sourceId = null, metadata = {} }) {
    const operation = "Start search run";
    const result = await this.query(
      operation,
      "insert into public.search_runs (query, source_id, metadata, status) values ($1, $2, $3, 'running') returning *",
      [query, sourceId, metadata],
    );
    return this.one(result, operation);
  }

  async finishSearchRun(id, { resultCount, metadata = {} }) {
    const operation = "Complete search run";
    const result = await this.query(
      operation,
      "update public.search_runs set status = 'completed', result_count = $1, finished_at = $2, metadata = $3 where id = $4 and status = 'running' returning *",
      [resultCount, now(), metadata, id],
    );
    return this.one(result, operation);
  }

  async failSearchRun(id, error) {
    const operation = "Fail search run";
    const result = await this.query(
      operation,
      "update public.search_runs set status = 'failed', error = $1, finished_at = $2 where id = $3 and status = 'running' returning *",
      [error instanceof Error ? error.message : String(error), now(), id],
    );
    return this.one(result, operation);
  }

  async createOrResumeArticleCandidate(article) {
    const rows = await this.functionRows(
      "create_or_resume_article_candidate",
      [
        article.source_id,
        article.search_run_id,
        article.canonical_url,
        article.title,
        article.author,
        article.published_at,
        article.content_hash,
        article.metadata ?? {},
      ],
      "Create or resume article candidate",
    );
    return rows[0] ?? null;
  }

  async saveRawContent(rawContent) {
    return this.upsertRow(
      "raw_contents",
      rawContent,
      RAW_CONTENT_COLUMNS,
      ["article_id", "content_hash"],
      "Save raw content",
    );
  }

  async transitionArticle(id, from, to, changes = {}) {
    assertTransition("article", from, to);
    return this.updateState(
      "articles",
      id,
      from,
      to,
      changes,
      ARTICLE_UPDATE_COLUMNS,
      `Transition article ${from} -> ${to}`,
    );
  }

  async createDraft(draft) {
    return this.insertRow(
      "drafts",
      { ...draft, status: draft.status ?? "draft" },
      DRAFT_COLUMNS,
      "Create draft",
    );
  }

  async createReviewDraft(draft) {
    const rows = await this.functionRows(
      "create_review_draft",
      [
        draft.article_id,
        draft.body,
        draft.model ?? null,
        draft.prompt_version ?? null,
        draft.reviewer_notes ?? null,
        draft.lease_name ?? null,
        draft.lease_owner_id ?? null,
      ],
      "Create review draft",
    );
    return rows[0];
  }

  async getDraft(id) {
    const operation = "Get draft";
    const result = await this.query(
      operation,
      "select d.*, row_to_json(a) as articles from public.drafts d join public.articles a on a.id = d.article_id where d.id = $1",
      [id],
    );
    return this.one(result, operation);
  }

  async listDrafts(status = "review") {
    const result = await this.query(
      `List ${status} drafts`,
      "select d.id, d.article_id, d.body, d.status, d.created_at, json_build_object('title', a.title) as articles from public.drafts d join public.articles a on a.id = d.article_id where d.status = $1 order by d.created_at asc",
      [status],
    );
    return result.rows;
  }

  async transitionDraft(id, from, to, changes = {}) {
    assertTransition("draft", from, to);
    return this.updateState(
      "drafts",
      id,
      from,
      to,
      changes,
      DRAFT_COLUMNS,
      `Transition draft ${from} -> ${to}`,
    );
  }

  async approveDraft(id) {
    return (
      await this.functionRows("approve_draft", [id], "Approve draft")
    )[0];
  }

  async rejectDraft(id, reason = null) {
    return (
      await this.functionRows("reject_draft", [id, reason], "Reject draft")
    )[0];
  }

  async claimDraftForPublication(id) {
    return (
      await this.functionRows(
        "claim_draft_for_publication",
        [id],
        "Claim draft for publication",
      )
    )[0];
  }

  async finalizeDraftPublication({
    draftId,
    channelId,
    messageId,
    messageText,
    metadata = {},
  }) {
    return (
      await this.functionRows(
        "finalize_draft_publication",
        [draftId, channelId, messageId, messageText, metadata],
        "Finalize draft publication",
      )
    )[0];
  }

  async findPublicationByDraft(draftId) {
    const result = await this.query(
      "Find publication by draft",
      "select * from public.published_posts where draft_id = $1",
      [draftId],
    );
    if (result.rows.length > 1) {
      throw new Error(
        "Find publication by draft failed: expected at most one row",
      );
    }
    return result.rows[0] ?? null;
  }

  async resetDraftPublication(id, confirmation) {
    return (
      await this.functionRows(
        "reset_draft_publication",
        [id, confirmation],
        "Reset unresolved draft publication",
      )
    )[0];
  }

  async releaseRejectedDraftPublication(id) {
    return (
      await this.functionRows(
        "release_rejected_draft_publication",
        [id],
        "Release rejected draft publication",
      )
    )[0];
  }

  async recordPublication(publication) {
    return this.insertRow(
      "published_posts",
      publication,
      PUBLICATION_COLUMNS,
      "Record publication",
    );
  }

  async acquirePipelineLease(name, ownerId, ttlSeconds = 900) {
    return this.functionScalar(
      "acquire_pipeline_lease",
      [name, ownerId, ttlSeconds],
      "Acquire pipeline lease",
    );
  }

  async renewPipelineLease(name, ownerId, ttlSeconds = 60) {
    return this.functionScalar(
      "renew_pipeline_lease",
      [name, ownerId, ttlSeconds],
      "Renew pipeline lease",
    );
  }

  async releasePipelineLease(name, ownerId) {
    return this.functionScalar(
      "release_pipeline_lease",
      [name, ownerId],
      "Release pipeline lease",
    );
  }

  async claimTelegramUpdate(updateId, updateKind, staleAfterSeconds = 120) {
    return (
      await this.functionRows(
        "claim_telegram_update",
        [updateId, updateKind, staleAfterSeconds],
        "Claim Telegram update",
      )
    )[0];
  }

  async finishTelegramUpdate(updateId, claimToken, status, errorCode = null) {
    return this.functionScalar(
      "finish_telegram_update",
      [updateId, claimToken, status, errorCode],
      "Finish Telegram update",
    );
  }

  async getTelegramNewsCheckpoint(updateId) {
    const result = await this.query(
      "Get Telegram news checkpoint",
      "select * from public.telegram_news_request_checkpoints where update_id = $1",
      [updateId],
    );
    if (result.rows.length > 1) {
      throw new Error(
        "Get Telegram news checkpoint failed: expected at most one row",
      );
    }
    return result.rows[0] ?? null;
  }

  async saveTelegramNewsCheckpoint(checkpoint) {
    return this.upsertRow(
      "telegram_news_request_checkpoints",
      checkpoint,
      CHECKPOINT_COLUMNS,
      ["update_id"],
      "Save Telegram news checkpoint",
    );
  }

  async createTelegramReviewSession(session) {
    return this.insertRow(
      "telegram_review_sessions",
      session,
      REVIEW_SESSION_COLUMNS,
      "Create Telegram review session",
    );
  }

  async decideTelegramReviewSession({
    sessionId,
    action,
    chatId,
    messageId,
    actorId,
  }) {
    return (
      await this.functionRows(
        "decide_telegram_review_session",
        [sessionId, action, chatId, messageId, actorId],
        "Decide Telegram review session",
      )
    )[0];
  }

  async enqueueNotionAuditBackfill(record) {
    return this.upsertRow(
      "notion_audit_outbox",
      record,
      AUDIT_OUTBOX_COLUMNS,
      ["notion_page_id", "event_type"],
      "Enqueue Notion audit backfill",
    );
  }

  async claimNotionAuditBackfill(limit = 25) {
    return this.functionRows(
      "claim_notion_audit_backfill",
      [limit],
      "Claim Notion audit backfill",
    );
  }

  async completeNotionAuditBackfill(id) {
    return this.functionScalar(
      "complete_notion_audit_backfill",
      [id],
      "Complete Notion audit backfill",
    );
  }

  async retryNotionAuditBackfill(id, error) {
    return this.functionScalar(
      "retry_notion_audit_backfill",
      [id, error instanceof Error ? error.message : String(error)],
      "Retry Notion audit backfill",
    );
  }
}
