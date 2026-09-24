import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";

import type {
  CreateDraftInput,
  CreateReviewDraftInput,
  BlockDraftPublicationInput,
  BlockDraftPublicationResult,
  ClaimDraftForPublicationWithPolicyInput,
  ClaimDraftForPublicationWithPolicyResult,
  DraftListRow,
  DraftRow,
  DraftStatus,
  DraftTransitionChanges,
  DraftWithArticleRow,
  EditorialPersistence,
  FinalizeDraftPublicationInput,
  PublishedPostRow,
  PublicationPolicyBlockRow,
  RecordPublicationInput,
} from "../../editorial/editorial-persistence.contracts.js";
import {
  mapDraftListRow,
  mapDraftRow,
  mapDraftWithArticleRow,
  mapPublishedPostRow,
  mapPublicationPolicyBlockRow,
  type DraftDatabaseRow,
  type DraftListDatabaseRow,
  type DraftWithArticleDatabaseRow,
  type PublishedPostDatabaseRow,
  type PublicationPolicyBlockDatabaseRow,
} from "../../editorial/editorial-row-mappers.js";
import { assertTransition } from "../../operations/domain/pipeline-states.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { drafts, publishedPosts } from "../schema/editorial.js";
import { publicationPolicyBlocks } from "../schema/publication-policy.js";
import { articles } from "../schema/research.js";
import {
  postgresRows,
  RepositorySupport,
  timestamp,
  toIsoTimestamp,
} from "./repository-support.js";

const draftSelection = {
  id: drafts.id,
  article_id: drafts.articleId,
  body: drafts.body,
  status: drafts.status,
  model: drafts.model,
  prompt_version: drafts.promptVersion,
  reviewer_notes: drafts.reviewerNotes,
  approved_at: drafts.approvedAt,
  created_at: drafts.createdAt,
  updated_at: drafts.updatedAt,
};

const articleSelection = {
  id: articles.id,
  source_id: articles.sourceId,
  search_run_id: articles.searchRunId,
  canonical_url: articles.canonicalUrl,
  title: articles.title,
  author: articles.author,
  published_at: articles.publishedAt,
  discovered_at: articles.discoveredAt,
  content_hash: articles.contentHash,
  status: articles.status,
  metadata: articles.metadata,
  created_at: articles.createdAt,
  updated_at: articles.updatedAt,
};

const publicationSelection = {
  id: publishedPosts.id,
  draft_id: publishedPosts.draftId,
  article_id: publishedPosts.articleId,
  telegram_channel_id: publishedPosts.telegramChannelId,
  telegram_message_id: publishedPosts.telegramMessageId,
  published_at: publishedPosts.publishedAt,
  message_text: publishedPosts.messageText,
  metadata: publishedPosts.metadata,
  created_at: publishedPosts.createdAt,
};

const publicationPolicyBlockSelection = {
  id: publicationPolicyBlocks.id,
  idempotency_key: publicationPolicyBlocks.idempotencyKey,
  telegram_channel_id: publicationPolicyBlocks.telegramChannelId,
  draft_id: publicationPolicyBlocks.draftId,
  article_id: publicationPolicyBlocks.articleId,
  stage: publicationPolicyBlocks.stage,
  publication_path: publicationPolicyBlocks.publicationPath,
  topic_code: publicationPolicyBlocks.topicCode,
  classification: publicationPolicyBlocks.classification,
  settings_version: publicationPolicyBlocks.settingsVersion,
  outbound_text_sha256: publicationPolicyBlocks.outboundTextSha256,
  provider: publicationPolicyBlocks.provider,
  model: publicationPolicyBlocks.model,
  prompt_version: publicationPolicyBlocks.promptVersion,
  reason_code: publicationPolicyBlocks.reasonCode,
  created_at: publicationPolicyBlocks.createdAt,
};

type PolicyClaimDatabaseRow = DraftDatabaseRow & { outcome: string };
type PolicyBlockResultDatabaseRow = {
  outcome: string;
  block_id: string | null;
  draft_id: string | null;
  article_id: string | null;
  draft_status: string | null;
  reason_code: string | null;
  created_at: string | Date | null;
};

function policyDraftStatus(value: string | null): DraftStatus | null {
  if (value === null) return null;
  if (
    value !== "draft" &&
    value !== "review" &&
    value !== "approved" &&
    value !== "publishing" &&
    value !== "rejected" &&
    value !== "published"
  ) {
    throw new Error("Invalid draft status in publication policy outcome");
  }
  return value;
}

const createReviewDraftFunction = postgresRows<DraftDatabaseRow>(
  "public.create_review_draft",
  7,
);
const createReviewDraftWithTopicsFunction = postgresRows<DraftDatabaseRow>(
  "public.create_review_draft_with_topics",
  10,
);
const approveDraftFunction = postgresRows<DraftDatabaseRow>(
  "public.approve_draft",
  1,
);
const rejectDraftFunction = postgresRows<DraftDatabaseRow>(
  "public.reject_draft",
  2,
);
const claimDraftForPublicationFunction = postgresRows<DraftDatabaseRow>(
  "public.claim_draft_for_publication",
  2,
);
const claimDraftForPublicationWithPolicyFunction =
  postgresRows<PolicyClaimDatabaseRow>(
    "public.claim_draft_for_publication_with_policy",
    4,
  );
const blockDraftPublicationFunction =
  postgresRows<PolicyBlockResultDatabaseRow>(
    "public.block_draft_publication",
    13,
  );
const finalizeDraftPublicationFunction =
  postgresRows<PublishedPostDatabaseRow>(
    "public.finalize_draft_publication",
    5,
  );
const resetDraftPublicationFunction = postgresRows<DraftDatabaseRow>(
  "public.reset_draft_publication",
  2,
);
const releaseRejectedDraftPublicationFunction =
  postgresRows<DraftDatabaseRow>(
    "public.release_rejected_draft_publication",
    1,
  );

function optionalDraft(row: DraftDatabaseRow | undefined): DraftRow | undefined {
  return row === undefined ? undefined : mapDraftRow(row);
}

function optionalPublication(
  row: PublishedPostDatabaseRow | undefined,
): PublishedPostRow | undefined {
  return row === undefined ? undefined : mapPublishedPostRow(row);
}

@Injectable()
export class EditorialRepository
  extends RepositorySupport
  implements EditorialPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRow> {
    const values: typeof drafts.$inferInsert = {
      articleId: input.article_id,
      body: input.body,
      status: input.status ?? "draft",
    };
    if (input.model !== undefined) values.model = input.model;
    if (input.prompt_version !== undefined) {
      values.promptVersion = input.prompt_version;
    }
    if (input.reviewer_notes !== undefined) {
      values.reviewerNotes = input.reviewer_notes;
    }
    if (input.approved_at !== undefined) {
      values.approvedAt =
        input.approved_at === null
          ? null
          : toIsoTimestamp(input.approved_at);
    }
    if (input.updated_at !== undefined) {
      values.updatedAt = toIsoTimestamp(input.updated_at);
    }

    const rows = await this.operation("Create draft", () =>
      this.database.insert(drafts).values(values).returning(draftSelection),
    );
    return mapDraftRow(this.one(rows, "Create draft"));
  }

  async createReviewDraft(
    input: CreateReviewDraftInput,
  ): Promise<DraftRow | undefined> {
    // `!= null`, not `!== undefined`: the contract permits null, and the
    // gateway passes exactly that when article tagging is off. Treating null as
    // "with topics" sent `JSON.stringify(null)` -- the string "null" -- into
    // create_review_draft_with_topics, which refuses it with "Article topic
    // assignments must be a JSON array". Every review draft failed whenever
    // tagging was off, which is the default.
    //
    // Both absent forms now take the plain function, which is what "no topic
    // assignment" has always meant. An empty array still takes the topics
    // function: that is a caller saying "tagging ran and produced nothing",
    // which is a different statement from "tagging did not run".
    const withTopics = input.topic_assignments != null;
    const rows = await this.functionRows(
      "Create review draft",
      withTopics
        ? createReviewDraftWithTopicsFunction
        : createReviewDraftFunction,
      [
        input.article_id,
        input.body,
        input.model ?? null,
        input.prompt_version ?? null,
        input.reviewer_notes ?? null,
        input.lease_name ?? null,
        input.lease_owner_id ?? null,
        ...(withTopics
          ? [
              JSON.stringify(input.topic_assignments),
              input.topic_assignment_source ?? "ai",
              input.topic_assigned_model ?? input.model ?? null,
            ]
          : []),
      ],
    );
    return optionalDraft(rows[0]);
  }

  async getDraft(id: string): Promise<DraftWithArticleRow> {
    const operation = "Get draft";
    const rows = await this.operation(operation, () =>
      this.database
        .select({ ...draftSelection, articles: articleSelection })
        .from(drafts)
        .innerJoin(articles, eq(articles.id, drafts.articleId))
        .where(eq(drafts.id, id)),
    );
    return mapDraftWithArticleRow(
      this.one(rows, operation) as DraftWithArticleDatabaseRow,
    );
  }

  async listDrafts(status: DraftStatus = "review"): Promise<DraftListRow[]> {
    const operation = `List ${status} drafts`;
    const rows = await this.operation(operation, () =>
      this.database
        .select({
          id: drafts.id,
          article_id: drafts.articleId,
          body: drafts.body,
          status: drafts.status,
          created_at: drafts.createdAt,
          articles: { title: articles.title },
        })
        .from(drafts)
        .innerJoin(articles, eq(articles.id, drafts.articleId))
        .where(eq(drafts.status, status))
        .orderBy(drafts.createdAt),
    );
    return (rows as DraftListDatabaseRow[]).map(mapDraftListRow);
  }

  async transitionDraft(
    id: string,
    from: DraftStatus,
    to: DraftStatus,
    changes: DraftTransitionChanges = {},
  ): Promise<DraftRow> {
    assertTransition("draft", from, to);

    const updates: Partial<typeof drafts.$inferInsert> = {
      status: to,
      updatedAt: timestamp(),
    };
    if (changes.article_id !== undefined) {
      updates.articleId = changes.article_id;
    }
    if (changes.body !== undefined) updates.body = changes.body;
    if (changes.model !== undefined) updates.model = changes.model;
    if (changes.prompt_version !== undefined) {
      updates.promptVersion = changes.prompt_version;
    }
    if (changes.reviewer_notes !== undefined) {
      updates.reviewerNotes = changes.reviewer_notes;
    }
    if (changes.approved_at !== undefined) {
      updates.approvedAt =
        changes.approved_at === null
          ? null
          : toIsoTimestamp(changes.approved_at);
    }

    const operation = `Transition draft ${from} -> ${to}`;
    const rows = await this.operation(operation, () =>
      this.database
        .update(drafts)
        .set(updates)
        .where(and(eq(drafts.id, id), eq(drafts.status, from)))
        .returning(draftSelection),
    );
    return mapDraftRow(this.one(rows, operation));
  }

  async approveDraft(id: string): Promise<DraftRow | undefined> {
    const rows = await this.functionRows(
      "Approve draft",
      approveDraftFunction,
      [id],
    );
    return optionalDraft(rows[0]);
  }

  async rejectDraft(
    id: string,
    reason: string | null = null,
  ): Promise<DraftRow | undefined> {
    const rows = await this.functionRows("Reject draft", rejectDraftFunction, [
      id,
      reason,
    ]);
    return optionalDraft(rows[0]);
  }

  async claimDraftForPublication(
    id: string,
    channelId: string,
  ): Promise<DraftRow | undefined> {
    const rows = await this.functionRows(
      "Claim draft for publication",
      claimDraftForPublicationFunction,
      [id, channelId],
    );
    return optionalDraft(rows[0]);
  }

  async claimDraftForPublicationWithPolicy({
    draftId,
    channelId,
    settingsVersion,
    outboundTextSha256,
  }: ClaimDraftForPublicationWithPolicyInput): Promise<ClaimDraftForPublicationWithPolicyResult> {
    const rows = await this.functionRows(
      "Claim draft for publication with policy",
      claimDraftForPublicationWithPolicyFunction,
      [draftId, channelId, settingsVersion, Buffer.from(outboundTextSha256, "hex")],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Policy-aware publication claim returned no outcome");
    }
    const { outcome, ...draft } = row;
    if (
      outcome !== "claimed" &&
      outcome !== "already_published" &&
      outcome !== "already_blocked" &&
      outcome !== "stale_settings" &&
      outcome !== "outbound_changed" &&
      outcome !== "not_publishable"
    ) {
      throw new Error("Invalid policy-aware publication claim outcome");
    }
    return {
      outcome,
      draft: draft.id === null ? null : mapDraftRow(draft),
    };
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
  }: BlockDraftPublicationInput): Promise<BlockDraftPublicationResult> {
    const rows = await this.functionRows(
      "Block draft publication",
      blockDraftPublicationFunction,
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
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Draft publication block returned no outcome");
    }
    if (
      row.outcome !== "blocked" &&
      row.outcome !== "already_published" &&
      row.outcome !== "already_blocked" &&
      row.outcome !== "stale_settings" &&
      row.outcome !== "outbound_changed" &&
      row.outcome !== "not_publishable"
    ) {
      throw new Error("Invalid draft publication block outcome");
    }
    return {
      outcome: row.outcome,
      blockId: row.block_id,
      draftId: row.draft_id,
      articleId: row.article_id,
      draftStatus: policyDraftStatus(row.draft_status),
      reasonCode: row.reason_code,
      createdAt: row.created_at === null ? null : toIsoTimestamp(row.created_at),
    };
  }

  async findPublicationPolicyBlockByDraft(
    draftId: string,
    channelId: string,
  ): Promise<PublicationPolicyBlockRow | null> {
    const operation = "Find publication policy block by draft";
    const rows = await this.operation(operation, () =>
      this.database
        .select(publicationPolicyBlockSelection)
        .from(publicationPolicyBlocks)
        .where(
          and(
            eq(publicationPolicyBlocks.draftId, draftId),
            eq(publicationPolicyBlocks.telegramChannelId, channelId),
          ),
        ),
    );
    const row = this.optionalOne(rows, operation);
    return row === null
      ? null
      : mapPublicationPolicyBlockRow(
          row as PublicationPolicyBlockDatabaseRow,
        );
  }


  async finalizeDraftPublication({
    draftId,
    channelId,
    messageId,
    messageText,
    metadata = {},
  }: FinalizeDraftPublicationInput): Promise<PublishedPostRow | undefined> {
    const rows = await this.functionRows(
      "Finalize draft publication",
      finalizeDraftPublicationFunction,
      [draftId, channelId, messageId, messageText, metadata],
    );
    return optionalPublication(rows[0]);
  }

  async findPublicationByDraft(
    draftId: string,
  ): Promise<PublishedPostRow | null> {
    const operation = "Find publication by draft";
    const rows = await this.operation(operation, () =>
      this.database
        .select(publicationSelection)
        .from(publishedPosts)
        .where(eq(publishedPosts.draftId, draftId)),
    );
    const row = this.optionalOne(rows, operation);
    return row === null
      ? null
      : mapPublishedPostRow(row as PublishedPostDatabaseRow);
  }

  async resetDraftPublication(
    id: string,
    confirmation: string,
  ): Promise<DraftRow | undefined> {
    const rows = await this.functionRows(
      "Reset unresolved draft publication",
      resetDraftPublicationFunction,
      [id, confirmation],
    );
    return optionalDraft(rows[0]);
  }

  async releaseRejectedDraftPublication(
    id: string,
  ): Promise<DraftRow | undefined> {
    const rows = await this.functionRows(
      "Release rejected draft publication",
      releaseRejectedDraftPublicationFunction,
      [id],
    );
    return optionalDraft(rows[0]);
  }

  async recordPublication(
    input: RecordPublicationInput,
  ): Promise<PublishedPostRow> {
    const values: typeof publishedPosts.$inferInsert = {
      draftId: input.draft_id,
      articleId: input.article_id,
      telegramChannelId: input.telegram_channel_id,
      telegramMessageId: input.telegram_message_id,
      messageText: input.message_text,
    };
    if (input.published_at !== undefined) {
      values.publishedAt = toIsoTimestamp(input.published_at);
    }
    if (input.metadata !== undefined) values.metadata = input.metadata;

    const rows = await this.operation("Record publication", () =>
      this.database
        .insert(publishedPosts)
        .values(values)
        .returning(publicationSelection),
    );
    return mapPublishedPostRow(
      this.one(rows, "Record publication") as PublishedPostDatabaseRow,
    );
  }
}
