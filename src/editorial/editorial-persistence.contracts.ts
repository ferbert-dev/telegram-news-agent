import type { JsonObject } from "../database/schema/common.js";
import type {
  ArticleRow,
  ArticleTopicAssignment,
  ArticleTopicAssignmentSource,
} from "../research/research-persistence.contracts.js";

export type DraftStatus =
  | "draft"
  | "review"
  | "approved"
  | "publishing"
  | "rejected"
  | "published";

export type DraftRow = {
  id: string;
  article_id: string;
  body: string;
  status: DraftStatus;
  model: string | null;
  prompt_version: string | null;
  reviewer_notes: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DraftWithArticleRow = DraftRow & {
  articles: ArticleRow;
};

export type DraftListRow = Pick<
  DraftRow,
  "id" | "article_id" | "body" | "status" | "created_at"
> & {
  articles: { title: string };
};

export type PublishedPostRow = {
  id: string;
  draft_id: string;
  article_id: string;
  telegram_channel_id: string;
  telegram_message_id: number;
  published_at: string;
  message_text: string;
  metadata: JsonObject;
  created_at: string;
};

export type CreateDraftInput = {
  article_id: string;
  body: string;
  status?: DraftStatus | null;
  model?: string | null;
  prompt_version?: string | null;
  reviewer_notes?: string | null;
  approved_at?: string | Date | null;
  updated_at?: string | Date;
};

export type CreateReviewDraftInput = {
  article_id: string;
  body: string;
  model?: string | null;
  prompt_version?: string | null;
  reviewer_notes?: string | null;
  lease_name?: string | null;
  lease_owner_id?: string | null;
  topic_assignments?: ArticleTopicAssignment[] | null;
  topic_assignment_source?: ArticleTopicAssignmentSource | null;
  topic_assigned_model?: string | null;
};

export type DraftTransitionChanges = Partial<
  Pick<
    CreateDraftInput,
    | "article_id"
    | "body"
    | "status"
    | "model"
    | "prompt_version"
    | "reviewer_notes"
    | "approved_at"
    | "updated_at"
  >
>;

export type FinalizeDraftPublicationInput = {
  draftId: string;
  channelId: string;
  messageId: number;
  messageText: string;
  metadata?: JsonObject;
};

export type RecordPublicationInput = {
  draft_id: string;
  article_id: string;
  telegram_channel_id: string;
  telegram_message_id: number;
  published_at?: string | Date;
  message_text: string;
  metadata?: JsonObject;
};

export type PublicationPath =
  | "automatic"
  | "automatic_news"
  | "manual_review"
  | "scheduler"
  | "drafts_cli"
  | "reconciliation"
  | "direct";

export type PublicationPolicyClassification =
  | "main_subject"
  | "uncertain"
  | "classifier_error";

export type PublicationPolicyBlockRow = {
  id: string;
  idempotency_key: string;
  telegram_channel_id: string;
  draft_id: string | null;
  article_id: string | null;
  stage: "final_publication" | "direct_publication" | "reconciliation";
  publication_path: PublicationPath;
  topic_code: string;
  classification: PublicationPolicyClassification;
  settings_version: number;
  outbound_text_sha256: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  reason_code: string;
  created_at: string;
};

export type PolicyPublicationOutcome =
  | "claimed"
  | "blocked"
  | "already_published"
  | "already_blocked"
  | "stale_settings"
  | "outbound_changed"
  | "not_publishable";

export type ClaimDraftForPublicationWithPolicyInput = {
  draftId: string;
  channelId: string;
  settingsVersion: number;
  outboundTextSha256: string;
};

export type ClaimDraftForPublicationWithPolicyResult = {
  outcome: Exclude<PolicyPublicationOutcome, "blocked">;
  draft: DraftRow | null;
};

export type BlockDraftPublicationInput = {
  draftId: string;
  channelId: string;
  stage: "final_publication";
  publicationPath: PublicationPath;
  topicCode: string;
  classification: PublicationPolicyClassification;
  settingsVersion: number;
  outboundText: string;
  outboundTextSha256: string;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  reasonCode: string;
};

export type BlockDraftPublicationResult = {
  outcome: Exclude<PolicyPublicationOutcome, "claimed">;
  blockId: string | null;
  draftId: string | null;
  articleId: string | null;
  draftStatus: DraftStatus | null;
  reasonCode: string | null;
  createdAt: string | null;
};


/**
 * Editorial persistence boundary. Ordinary reads and compatibility mutations
 * use typed Drizzle queries. Review, approval, rejection, publication and
 * recovery keep their PostgreSQL functions as the atomic state-machine fence.
 */
export interface EditorialPersistence {
  createDraft(input: CreateDraftInput): Promise<DraftRow>;
  createReviewDraft(
    input: CreateReviewDraftInput,
  ): Promise<DraftRow | undefined>;
  getDraft(id: string): Promise<DraftWithArticleRow>;
  listDrafts(status?: DraftStatus): Promise<DraftListRow[]>;
  transitionDraft(
    id: string,
    from: DraftStatus,
    to: DraftStatus,
    changes?: DraftTransitionChanges,
  ): Promise<DraftRow>;
  approveDraft(id: string): Promise<DraftRow | undefined>;
  rejectDraft(
    id: string,
    reason?: string | null,
  ): Promise<DraftRow | undefined>;
  claimDraftForPublication(
    id: string,
    channelId: string,
  ): Promise<DraftRow | undefined>;
  claimDraftForPublicationWithPolicy(
    input: ClaimDraftForPublicationWithPolicyInput,
  ): Promise<ClaimDraftForPublicationWithPolicyResult>;
  blockDraftPublication(
    input: BlockDraftPublicationInput,
  ): Promise<BlockDraftPublicationResult>;
  findPublicationPolicyBlockByDraft(
    draftId: string,
    channelId: string,
  ): Promise<PublicationPolicyBlockRow | null>;
  finalizeDraftPublication(
    input: FinalizeDraftPublicationInput,
  ): Promise<PublishedPostRow | undefined>;
  findPublicationByDraft(draftId: string): Promise<PublishedPostRow | null>;
  resetDraftPublication(
    id: string,
    confirmation: string,
  ): Promise<DraftRow | undefined>;
  releaseRejectedDraftPublication(
    id: string,
  ): Promise<DraftRow | undefined>;
  recordPublication(input: RecordPublicationInput): Promise<PublishedPostRow>;
}
