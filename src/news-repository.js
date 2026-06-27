import { requireResult } from "./database.js";
import { assertTransition } from "./pipeline-states.js";

function now() {
  return new Date().toISOString();
}

export class NewsRepository {
  constructor(client) {
    this.client = client;
  }

  async listEnabledSources() {
    const result = await this.client
      .from("sources")
      .select("*")
      .eq("enabled", true)
      .order("reliability_score", { ascending: false, nullsFirst: false });

    return requireResult(result, "List enabled sources");
  }

  async upsertSource(source) {
    const result = await this.client
      .from("sources")
      .upsert({ ...source, updated_at: now() }, { onConflict: "feed_url" })
      .select()
      .single();

    return requireResult(result, "Upsert source");
  }

  async setSourceEnabled(id, enabled) {
    const result = await this.client
      .from("sources")
      .update({ enabled, updated_at: now() })
      .eq("id", id)
      .select()
      .single();

    return requireResult(result, `${enabled ? "Enable" : "Disable"} source`);
  }

  async markSourceChecked(id) {
    const result = await this.client
      .from("sources")
      .update({ last_checked_at: now(), updated_at: now() })
      .eq("id", id)
      .select()
      .single();

    return requireResult(result, "Mark source checked");
  }

  async startSearchRun({ query, sourceId = null, metadata = {} }) {
    const result = await this.client
      .from("search_runs")
      .insert({
        query,
        source_id: sourceId,
        metadata,
        status: "running",
      })
      .select()
      .single();

    return requireResult(result, "Start search run");
  }

  async finishSearchRun(id, { resultCount, metadata = {} }) {
    const result = await this.client
      .from("search_runs")
      .update({
        status: "completed",
        result_count: resultCount,
        finished_at: now(),
        metadata,
      })
      .eq("id", id)
      .eq("status", "running")
      .select()
      .single();

    return requireResult(result, "Complete search run");
  }

  async failSearchRun(id, error) {
    const result = await this.client
      .from("search_runs")
      .update({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: now(),
      })
      .eq("id", id)
      .eq("status", "running")
      .select()
      .single();

    return requireResult(result, "Fail search run");
  }

  async createOrResumeArticleCandidate(article) {
    const result = await this.client.rpc("create_or_resume_article_candidate", {
      p_source_id: article.source_id,
      p_search_run_id: article.search_run_id,
      p_canonical_url: article.canonical_url,
      p_title: article.title,
      p_author: article.author,
      p_published_at: article.published_at,
      p_content_hash: article.content_hash,
      p_metadata: article.metadata ?? {},
    });
    return requireResult(result, "Create or resume article candidate")[0] ?? null;
  }

  async saveRawContent(rawContent) {
    const result = await this.client
      .from("raw_contents")
      .upsert(rawContent, { onConflict: "article_id,content_hash" })
      .select()
      .single();

    return requireResult(result, "Save raw content");
  }

  async transitionArticle(id, from, to, changes = {}) {
    assertTransition("article", from, to);

    const result = await this.client
      .from("articles")
      .update({ ...changes, status: to, updated_at: now() })
      .eq("id", id)
      .eq("status", from)
      .select()
      .single();

    return requireResult(result, `Transition article ${from} -> ${to}`);
  }

  async createDraft(draft) {
    const result = await this.client
      .from("drafts")
      .insert({ ...draft, status: draft.status ?? "draft" })
      .select()
      .single();

    return requireResult(result, "Create draft");
  }

  async getDraft(id) {
    const result = await this.client
      .from("drafts")
      .select("*, articles(*)")
      .eq("id", id)
      .single();

    return requireResult(result, "Get draft");
  }

  async listDrafts(status = "review") {
    const result = await this.client
      .from("drafts")
      .select("id, article_id, body, status, created_at, articles(title)")
      .eq("status", status)
      .order("created_at", { ascending: true });

    return requireResult(result, `List ${status} drafts`);
  }

  async transitionDraft(id, from, to, changes = {}) {
    assertTransition("draft", from, to);

    const result = await this.client
      .from("drafts")
      .update({ ...changes, status: to, updated_at: now() })
      .eq("id", id)
      .eq("status", from)
      .select()
      .single();

    return requireResult(result, `Transition draft ${from} -> ${to}`);
  }

  async approveDraft(id) {
    const result = await this.client.rpc("approve_draft", { p_draft_id: id });
    return requireResult(result, "Approve draft")[0];
  }

  async rejectDraft(id, reason = null) {
    const result = await this.client.rpc("reject_draft", {
      p_draft_id: id,
      p_reason: reason,
    });
    return requireResult(result, "Reject draft")[0];
  }

  async claimDraftForPublication(id) {
    const result = await this.client.rpc("claim_draft_for_publication", {
      p_draft_id: id,
    });
    return requireResult(result, "Claim draft for publication")[0];
  }

  async finalizeDraftPublication({
    draftId,
    channelId,
    messageId,
    messageText,
    metadata = {},
  }) {
    const result = await this.client.rpc("finalize_draft_publication", {
      p_draft_id: draftId,
      p_channel_id: channelId,
      p_message_id: messageId,
      p_message_text: messageText,
      p_metadata: metadata,
    });
    return requireResult(result, "Finalize draft publication")[0];
  }

  async findPublicationByDraft(draftId) {
    const result = await this.client
      .from("published_posts")
      .select("*")
      .eq("draft_id", draftId)
      .maybeSingle();

    return requireResult(result, "Find publication by draft");
  }

  async recordPublication(publication) {
    const result = await this.client
      .from("published_posts")
      .insert(publication)
      .select()
      .single();

    return requireResult(result, "Record publication");
  }

  async acquirePipelineLease(name, ownerId, ttlSeconds = 900) {
    const result = await this.client.rpc("acquire_pipeline_lease", {
      p_name: name,
      p_owner_id: ownerId,
      p_ttl_seconds: ttlSeconds,
    });
    return requireResult(result, "Acquire pipeline lease");
  }

  async releasePipelineLease(name, ownerId) {
    const result = await this.client.rpc("release_pipeline_lease", {
      p_name: name,
      p_owner_id: ownerId,
    });
    return requireResult(result, "Release pipeline lease");
  }
}
