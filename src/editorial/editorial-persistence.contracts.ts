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
