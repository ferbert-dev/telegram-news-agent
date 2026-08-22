import { assertTransition } from "./pipeline-states.js";

function now() {
  return new Date().toISOString();
}

function toIsoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${field} is not a valid timestamp`);
  }
  return date.toISOString();
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
  "publication_message_id",
  "settings_snapshot",
  "updated_at",
];
const REVIEW_SESSION_COLUMNS = [
  "id",
  "draft_id",
  "telegram_channel_id",
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
      `select s.*,
         coalesce(
           (
             select array_agg(t.name order by t.name)
             from public.source_topics st
             join public.topics t on t.id = st.topic_id
             where st.source_id = s.id and t.enabled = true
           ),
           '{}'::text[]
         ) as topic_codes
       from public.sources s
       where s.enabled = true
         and (s.disabled_until is null or s.disabled_until <= now())
       order by s.reliability_score desc nulls last, s.name`,
    );
    return result.rows;
  }

  async listEnabledArticleTags(languageCode) {
    const result = await this.query(
      "List enabled article tags",
      `select
         topic.id as topic_id,
         topic.name as code,
         topic.description,
         translation.language_code,
         translation.label,
         translation.hashtag
       from public.topics as topic
       join public.topic_translations as translation
         on translation.topic_id = topic.id
       where topic.enabled = true
         and translation.language_code = lower(btrim($1))
       order by topic.name`,
      [languageCode],
    );
    return result.rows;
  }

  async listSourceHealth() {
    const result = await this.query(
      "List source health",
      `select s.*,
         coalesce(
           (
             select array_agg(t.name order by t.name)
             from public.source_topics st
             join public.topics t on t.id = st.topic_id
             where st.source_id = s.id and t.enabled = true
           ),
           '{}'::text[]
         ) as topic_codes
       from public.sources s
       order by s.enabled desc, s.disabled_until nulls first,
         s.reliability_score desc nulls last, s.name`,
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

  async markSourceFetchSuccess(id) {
    const rows = await this.functionRows(
      "mark_source_fetch_success",
      [id],
      "Mark source fetch success",
    );
    return this.one({ rows }, "Mark source fetch success");
  }

  async markSourceFetchFailure(id, errorCode) {
    const rows = await this.functionRows(
      "mark_source_fetch_failure",
      [id, errorCode],
      "Mark source fetch failure",
    );
    return this.one({ rows }, "Mark source fetch failure");
  }

  async claimSourceDiscovery(topicKey) {
    return this.functionScalar(
      "claim_source_discovery",
      [topicKey],
      "Claim source discovery",
    );
  }

  async completeSourceDiscovery({
    topicKey,
    provider = null,
    model = null,
    resultCount = 0,
    errorCode = null,
  }) {
    return this.functionScalar(
      "complete_source_discovery",
      [topicKey, provider, model, resultCount, errorCode],
      "Complete source discovery",
    );
  }

  async upsertDiscoveredSource({
    name,
    homepageUrl,
    feedUrl,
    reliabilityScore = 65,
    topicCodes = [],
    discoveredBy,
    discoveryMetadata = {},
  }) {
    const rows = await this.functionRows(
      "upsert_discovered_source",
      [
        name,
        homepageUrl,
        feedUrl,
        reliabilityScore,
        topicCodes,
        discoveredBy,
        discoveryMetadata,
      ],
      "Upsert discovered source",
    );
    return this.one({ rows }, "Upsert discovered source");
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

  async listRecentPublishedStories({
    channelId = null,
    since,
    limit = 100,
  }) {
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
    const boundedLimit = Math.max(1, Math.min(200, requestedLimit));
    const result = await this.query(
      "List recent published stories",
      `select
         a.id as article_id,
         a.title,
         a.metadata ->> 'feed_summary' as feed_summary,
         p.message_text,
         p.telegram_channel_id,
         p.telegram_message_id,
         p.published_at,
         decision.story_fingerprint
       from public.published_posts p
       join public.articles a on a.id = p.article_id
       left join public.article_story_decisions decision
         on decision.article_id = a.id
       where p.published_at >= $1::timestamptz
         and ($2::text is null or p.telegram_channel_id = $2)
       order by p.published_at desc
       limit $3`,
      [since, channelId, boundedLimit],
    );
    return result.rows.map((row) => ({
      ...row,
      published_at: toIsoTimestamp(row.published_at, "published_at"),
    }));
  }

  async recordStoryDedupDecision({
    articleId,
    storyFingerprint,
    relation,
    duplicateOfArticleId = null,
    confidence = null,
    reason = null,
    decisionSource,
    metadata = {},
  }) {
    const result = await this.query(
      "Record story deduplication decision",
      `insert into public.article_story_decisions (
         article_id, story_fingerprint, relation, duplicate_of_article_id,
         confidence, reason, decision_source, metadata
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (article_id) do update set
         story_fingerprint = excluded.story_fingerprint,
         relation = excluded.relation,
         duplicate_of_article_id = excluded.duplicate_of_article_id,
         confidence = excluded.confidence,
         reason = excluded.reason,
         decision_source = excluded.decision_source,
         metadata = excluded.metadata,
         updated_at = now()
       returning *`,
      [
        articleId,
        storyFingerprint,
        relation,
        duplicateOfArticleId,
        confidence,
        reason,
        decisionSource,
        metadata,
      ],
    );
    return this.one(result, "Record story deduplication decision");
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

  async replaceArticleTopics({
    articleId,
    assignments,
    assignmentSource = "ai",
    assignedModel = null,
  }) {
    return this.functionRows(
      "replace_article_topics",
      [articleId, JSON.stringify(assignments), assignmentSource, assignedModel],
      "Replace article topics",
    );
  }

  async createReviewDraft(draft) {
    const withTopics = draft.topic_assignments !== undefined;
    const rows = await this.functionRows(
      withTopics ? "create_review_draft_with_topics" : "create_review_draft",
      [
        draft.article_id,
        draft.body,
        draft.model ?? null,
        draft.prompt_version ?? null,
        draft.reviewer_notes ?? null,
        draft.lease_name ?? null,
        draft.lease_owner_id ?? null,
        ...(withTopics
          ? [
              JSON.stringify(draft.topic_assignments),
              draft.topic_assignment_source ?? "ai",
              draft.topic_assigned_model ?? draft.model ?? null,
            ]
          : []),
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

  async claimDraftForPublication(id, channelId) {
    return (
      await this.functionRows(
        "claim_draft_for_publication",
        [id, channelId],
        "Claim draft for publication",
      )
    )[0];
  }

  async claimDraftForPublicationWithPolicy({
    draftId,
    channelId,
    settingsVersion,
    outboundTextSha256,
  }) {
    const row = (
      await this.functionRows(
        "claim_draft_for_publication_with_policy",
        [
          draftId,
          channelId,
          settingsVersion,
          Buffer.from(outboundTextSha256, "hex"),
        ],
        "Claim draft for publication with policy",
      )
    )[0];
    if (!row) {
      throw new Error("Policy-aware publication claim returned no outcome");
    }
    const { outcome, ...draft } = row;
    return { outcome, draft: draft.id ? draft : null };
  }

  async blockDraftPublication({
    draftId,
    channelId,
    stage,
    publicationPath,
    topicCode,
    classification,
    settingsVersion,
    outboundText,
    outboundTextSha256,
    provider = null,
    model = null,
    promptVersion = null,
    reasonCode,
  }) {
    const row = (
      await this.functionRows(
        "block_draft_publication",
        [
          draftId,
          channelId,
          stage,
          publicationPath,
          topicCode,
          classification,
          settingsVersion,
          outboundText,
          Buffer.from(outboundTextSha256, "hex"),
          provider,
          model,
          promptVersion,
          reasonCode,
        ],
        "Block draft publication",
      )
    )[0];
    if (!row) {
      throw new Error("Draft publication block returned no outcome");
    }
    return {
      outcome: row.outcome,
      blockId: row.block_id,
      draftId: row.draft_id,
      articleId: row.article_id,
      draftStatus: row.draft_status,
      reasonCode: row.reason_code,
      createdAt:
        row.created_at == null ? null : new Date(row.created_at).toISOString(),
    };
  }


  async findPublicationPolicyBlockByDraft(draftId, channelId) {
    const result = await this.query(
      "Find publication policy block by draft",
      `select id, idempotency_key, telegram_channel_id, draft_id, article_id,
              stage, publication_path, topic_code, classification,
              settings_version, encode(outbound_text_sha256, 'hex') as outbound_text_sha256,
              provider, model, prompt_version, reason_code, created_at
       from public.publication_policy_blocks
       where draft_id = $1 and telegram_channel_id = $2`,
      [draftId, channelId],
    );
    if (result.rows.length > 1) {
      throw new Error(
        "Find publication policy block by draft failed: expected at most one row",
      );
    }
    return result.rows[0] ?? null;
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

  async recordAiUsage({
    provider,
    providerResponseId = null,
    model,
    operation,
    telegramChannelId = null,
    searchRunId = null,
    articleId = null,
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    webSearchCalls = 0,
    estimatedCostUsd = null,
    pricingSnapshot = null,
  }) {
    const result = await this.query(
      "Record AI usage",
      `insert into public.ai_usage_events (
        provider, provider_response_id, model, operation, telegram_channel_id,
        search_run_id, article_id, input_tokens, cached_input_tokens,
        output_tokens, reasoning_tokens, web_search_calls,
        estimated_cost_usd, pricing_snapshot
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) on conflict (provider, provider_response_id) do update
        set provider_response_id = excluded.provider_response_id
      returning *`,
      [
        provider,
        providerResponseId,
        model,
        operation,
        telegramChannelId,
        searchRunId,
        articleId,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        webSearchCalls,
        estimatedCostUsd,
        pricingSnapshot,
      ],
    );
    return this.one(result, "Record AI usage");
  }

  async startAiProviderAttempt({ id, correlationId, operation, provider, model = null, attemptNumber, startedAt }) {
    const result = await this.query(
      "Start AI provider attempt",
      `insert into public.ai_provider_attempts (
        id, correlation_id, operation, provider, model, attempt_number, status, started_at
      ) values ($1, $2, $3, $4, $5, $6, 'started', $7) returning *`,
      [id, correlationId, operation, provider, model, attemptNumber, startedAt],
    );
    return this.one(result, "Start AI provider attempt");
  }

  async completeAiProviderAttempt({ id, status, completedAt, latencyMs, ...diagnostics }) {
    const result = await this.query(
      "Complete AI provider attempt",
      `update public.ai_provider_attempts set
        status = $2, completed_at = $3, latency_ms = $4, error_code = $5,
        http_status = $6, provider_response_id = $7, response_status = $8,
        incomplete_reason = $9, refusal = $10, input_tokens = $11,
        output_tokens = $12, reasoning_tokens = $13, error_fingerprint = $14
      where id = $1 returning *`,
      [id, status, completedAt, latencyMs, diagnostics.errorCode ?? null, diagnostics.httpStatus ?? null,
        diagnostics.providerResponseId ?? null, diagnostics.responseStatus ?? null,
        diagnostics.incompleteReason ?? null, diagnostics.refusal ?? null,
        diagnostics.inputTokens ?? null, diagnostics.outputTokens ?? null,
        diagnostics.reasoningTokens ?? null, diagnostics.errorFingerprint ?? null],
    );
    return this.one(result, "Complete AI provider attempt");
  }

  async getLatestAiProviderAttemptHealth() {
    const result = await this.query(
      "Get latest AI provider attempt health",
      `select distinct on (provider) provider, status, error_code, operation, started_at,
        completed_at, latency_ms, correlation_id
       from public.ai_provider_attempts
       order by provider, started_at desc, attempt_number desc, id desc`,
    );
    return result.rows;
  }

  async getDailyUsageDashboard({
    channelId,
    now: currentTime = new Date().toISOString(),
    timeZone = "Europe/Madrid",
    postLimit = 5,
  }) {
    const bounds = `select
      date_trunc('day', $2::timestamptz at time zone $3) at time zone $3 as period_start,
      (date_trunc('day', $2::timestamptz at time zone $3) + interval '1 day') at time zone $3 as period_end`;
    const summaryResult = await this.query(
      "Get daily AI usage summary",
      `with bounds as (${bounds}),
       usage_summary as (
       select
         bounds.period_start,
         bounds.period_end,
         count(u.id)::bigint as request_count,
         coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
         coalesce(sum(u.cached_input_tokens), 0)::bigint as cached_input_tokens,
         coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
         coalesce(sum(u.reasoning_tokens), 0)::bigint as reasoning_tokens,
         coalesce(sum(u.web_search_calls), 0)::bigint as web_search_calls,
         count(u.estimated_cost_usd)::bigint as priced_request_count,
         coalesce(sum(u.estimated_cost_usd), 0)::numeric(16, 8) as estimated_cost_usd,
         min(u.created_at) as tracking_started_at
       from bounds
       left join public.ai_usage_events u
         on u.telegram_channel_id = $1
        and u.created_at >= bounds.period_start
        and u.created_at < bounds.period_end
       group by bounds.period_start, bounds.period_end
       )
       select
         usage_summary.*,
         (
           select count(*)::bigint
           from public.published_posts p
           where p.telegram_channel_id = $1
             and p.published_at >= usage_summary.period_start
             and p.published_at < usage_summary.period_end
         ) as published_post_count
       from usage_summary`,
      [channelId, currentTime, timeZone],
    );
    const postsResult = await this.query(
      "Get daily publication cost summary",
      `with bounds as (${bounds})
       select
         p.telegram_message_id,
         p.published_at,
         coalesce(p.metadata #>> '{editor,name}', 'Unknown editor') as editor_name,
         count(u.id)::bigint as usage_request_count,
         coalesce(sum(u.estimated_cost_usd), 0)::numeric(16, 8) as estimated_cost_usd
       from bounds
       join public.published_posts p
         on p.telegram_channel_id = $1
        and p.published_at >= bounds.period_start
        and p.published_at < bounds.period_end
       join public.drafts d on d.id = p.draft_id
       join public.articles a on a.id = d.article_id
       left join public.ai_usage_events u
         on u.telegram_channel_id = p.telegram_channel_id
        and (u.article_id = a.id or u.search_run_id = a.search_run_id)
       group by p.telegram_message_id, p.published_at, editor_name
       order by p.published_at desc
       limit $4`,
      [channelId, currentTime, timeZone, postLimit],
    );
    const providersResult = await this.query(
      "Get AI provider usage summary",
      `with bounds as (${bounds})
       select
         u.provider,
         count(*) filter (
           where u.created_at >= bounds.period_start
             and u.created_at < bounds.period_end
         )::bigint as request_count,
         coalesce(sum(u.web_search_calls) filter (
           where u.created_at >= bounds.period_start
             and u.created_at < bounds.period_end
         ), 0)::bigint as web_search_calls,
         max(u.created_at) as last_success_at
       from bounds
       join public.ai_usage_events u
         on u.telegram_channel_id = $1
       group by u.provider
       order by u.provider`,
      [channelId, currentTime, timeZone],
    );
    return {
      summary: this.one(summaryResult, "Get daily AI usage summary"),
      posts: postsResult.rows,
      providers: providersResult.rows,
    };
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

  async getOrCreateNewsSettings({ channelId, reviewChatId, updatedBy }) {
    const rows = await this.functionRows(
      "get_or_create_news_settings",
      [channelId, reviewChatId, updatedBy],
      "Get or create news settings",
    );
    return rows[0] ?? null;
  }

  async getOrCreateNewsFeatureFlags({ channelId, updatedBy }) {
    return this.functionRows(
      "get_or_create_news_feature_flags",
      [channelId, updatedBy],
      "Get or create news feature flags",
    );
  }

  async getNewsFeatureFlags(channelId) {
    return this.functionRows(
      "get_news_feature_flags",
      [channelId],
      "Get news feature flags",
    );
  }

  async updateNewsFeatureFlag({
    channelId,
    featureKey,
    state,
    updatedBy,
    expectedVersion,
  }) {
    const rows = await this.functionRows(
      "update_news_feature_flag",
      [channelId, featureKey, state, updatedBy, expectedVersion],
      "Update news feature flag",
    );
    return rows[0] ?? null;
  }

  async getNewsSettings(channelId) {
    const rows = await this.functionRows(
      "get_news_settings",
      [channelId],
      "Get news settings",
    );
    return rows[0] ?? null;
  }

  async updateNewsSettings({
    channelId,
    reviewChatId,
    scheduleIntervalMinutes,
    languageCode,
    topicCodes,
    customTopics,
    approvalPolicy,
    quietHoursEnabled,
    updatedBy,
    expectedVersion,
  }) {
    const rows = await this.functionRows(
      "update_news_settings",
      [
        channelId,
        reviewChatId,
        scheduleIntervalMinutes,
        languageCode,
        topicCodes,
        customTopics,
        approvalPolicy,
        quietHoursEnabled,
        updatedBy,
        expectedVersion,
      ],
      "Update news settings",
    );
    return rows[0] ?? null;
  }

  async updateNewsExcludedTopics({
    channelId,
    excludedTopicCodes,
    updatedBy,
    expectedVersion,
  }) {
    const rows = await this.functionRows(
      "update_news_excluded_topics",
      [channelId, excludedTopicCodes, updatedBy, expectedVersion],
      "Update news excluded topics",
    );
    return rows[0] ?? null;
  }

  async beginTelegramSettingsInput({
    controlChatId,
    requestedBy,
    promptMessageId,
    expiresAt,
  }) {
    const rows = await this.functionRows(
      "begin_telegram_settings_input",
      [controlChatId, requestedBy, promptMessageId, expiresAt],
      "Begin Telegram settings input",
    );
    return rows[0] ?? null;
  }

  async consumeTelegramSettingsInput({
    controlChatId,
    requestedBy,
    promptMessageId,
  }) {
    const rows = await this.functionRows(
      "consume_telegram_settings_input",
      [controlChatId, requestedBy, promptMessageId],
      "Consume Telegram settings input",
    );
    return rows[0] ?? null;
  }

  async claimDueNewsSchedule({ claimToken, staleAfterSeconds = 1800 }) {
    const rows = await this.functionRows(
      "claim_due_news_schedule",
      [claimToken, staleAfterSeconds],
      "Claim due news schedule",
    );
    return rows[0] ?? null;
  }

  async saveNewsScheduleDraft({
    channelId,
    claimToken,
    draftId,
    preview,
    windowHours,
  }) {
    return this.functionScalar(
      "save_news_schedule_draft",
      [channelId, claimToken, draftId, preview, windowHours],
      "Save news schedule draft",
    );
  }

  async saveNewsSchedulePublication({
    channelId,
    claimToken,
    draftId,
    publicationMessageId,
  }) {
    return this.functionScalar(
      "save_news_schedule_publication",
      [channelId, claimToken, draftId, publicationMessageId],
      "Save news schedule publication",
    );
  }

  async renewNewsScheduleClaim({ channelId, claimToken }) {
    return this.functionScalar(
      "renew_news_schedule_claim",
      [channelId, claimToken],
      "Renew news schedule claim",
    );
  }

  async deferNewsScheduleForQuietHours({ channelId, claimToken }) {
    return this.functionScalar(
      "defer_news_schedule_for_quiet_hours",
      [channelId, claimToken],
      "Defer news schedule for quiet hours",
    );
  }

  async pauseNewsScheduleUnresolved({ channelId, claimToken, errorCode }) {
    return this.functionScalar(
      "pause_news_schedule_unresolved",
      [channelId, claimToken, errorCode],
      "Pause unresolved news schedule",
    );
  }

  async finishNewsSchedule({
    channelId,
    claimToken,
    status,
    errorCode = null,
  }) {
    return this.functionScalar(
      "finish_news_schedule",
      [channelId, claimToken, status, errorCode],
      "Finish news schedule",
    );
  }

  async hasPendingTelegramReview(channelId) {
    return this.functionScalar(
      "has_pending_telegram_review",
      [channelId],
      "Check pending Telegram review",
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

  async recordTelegramUpdateFailure(
    updateId,
    updateKind,
    errorCode,
    maxAttempts = 3,
    terminal = false,
    claimToken = null,
  ) {
    return (
      await this.functionRows(
        "record_telegram_update_failure",
        [
          updateId,
          updateKind,
          errorCode,
          maxAttempts,
          terminal,
          claimToken,
        ],
        "Record Telegram update failure",
      )
    )[0];
  }

  async enqueueTelegramNewsJob({
    updateId,
    updateClaimToken,
    channelId,
    controlChatId,
    requestedBy,
    settingsSnapshot,
  }) {
    return (
      await this.functionRows(
        "enqueue_telegram_news_job",
        [
          updateId,
          updateClaimToken,
          channelId,
          controlChatId,
          requestedBy,
          settingsSnapshot,
        ],
        "Enqueue Telegram news job",
      )
    )[0];
  }

  async claimNextTelegramNewsJob({
    claimToken,
    staleAfterSeconds = 1800,
    maxExecutionAttempts = 3,
    maxDeliveryAttempts = 10,
  }) {
    return (
      await this.functionRows(
        "claim_next_telegram_news_job",
        [
          claimToken,
          staleAfterSeconds,
          maxExecutionAttempts,
          maxDeliveryAttempts,
        ],
        "Claim next Telegram news job",
      )
    )[0] ?? null;
  }

  async renewTelegramNewsJobClaim({ jobId, claimToken }) {
    return this.functionScalar(
      "renew_telegram_news_job_claim",
      [jobId, claimToken],
      "Renew Telegram news job claim",
    );
  }

  async recordTelegramNewsJobOutcome({
    jobId,
    claimToken,
    outcomeStatus,
    draftId = null,
    publicationMessageId = null,
    errorCode = null,
  }) {
    return (
      await this.functionRows(
        "record_telegram_news_job_outcome",
        [
          jobId,
          claimToken,
          outcomeStatus,
          draftId,
          publicationMessageId,
          errorCode,
        ],
        "Record Telegram news job outcome",
      )
    )[0] ?? null;
  }

  async retryTelegramNewsJob({
    jobId,
    claimToken,
    errorCode,
    maxAttempts = 3,
    terminal = false,
  }) {
    return (
      await this.functionRows(
        "retry_telegram_news_job",
        [jobId, claimToken, errorCode, maxAttempts, terminal],
        "Retry Telegram news job",
      )
    )[0] ?? null;
  }

  async retryTelegramNewsJobDelivery({
    jobId,
    claimToken,
    errorCode,
    maxAttempts = 10,
  }) {
    return (
      await this.functionRows(
        "retry_telegram_news_job_delivery",
        [jobId, claimToken, errorCode, maxAttempts],
        "Retry Telegram news job delivery",
      )
    )[0] ?? null;
  }

  async completeTelegramNewsJob({ jobId, claimToken }) {
    return this.functionScalar(
      "complete_telegram_news_job",
      [jobId, claimToken],
      "Complete Telegram news job",
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

  async findTelegramReviewSessionByDraft(draftId) {
    const result = await this.query(
      "Find Telegram review session by draft",
      "select * from public.telegram_review_sessions where draft_id = $1",
      [draftId],
    );
    if (result.rows.length > 1) {
      throw new Error(
        "Find Telegram review session by draft failed: expected at most one row",
      );
    }
    return result.rows[0] ?? null;
  }

  async renewTelegramReviewSession({ draftId, expiresAt }) {
    const rows = await this.functionRows(
      "renew_telegram_review_session",
      [draftId, expiresAt],
      "Renew Telegram review session",
    );
    return rows[0] ?? null;
  }

  async rebindTelegramReviewSession({
    draftId,
    controlChatId,
    expectedPreviewMessageId,
    previewMessageId,
    expiresAt,
  }) {
    const rows = await this.functionRows(
      "rebind_telegram_review_session",
      [
        draftId,
        controlChatId,
        expectedPreviewMessageId,
        previewMessageId,
        expiresAt,
      ],
      "Rebind Telegram review session",
    );
    return rows[0] ?? null;
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
