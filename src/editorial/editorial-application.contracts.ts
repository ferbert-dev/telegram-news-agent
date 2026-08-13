import type {
  CreateReviewDraftInput,
  DraftRow,
  PublishedPostRow,
} from "./editorial-persistence.contracts.js";
import type { ArticleRow } from "../research/research-persistence.contracts.js";
import type {
  AiUsageEventRow,
  RecordAiUsageInput,
} from "../usage/usage-persistence.contracts.js";

export type EditorialJsonValue =
  | string
  | number
  | boolean
  | null
  | EditorialJsonObject
  | EditorialJsonValue[];

export type EditorialJsonObject = {
  [key: string]: EditorialJsonValue;
};

export type EditorialEvidence = {
  url: string;
  title?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  text: string;
  primary: boolean;
  verificationStatus?: string | null;
};

export type GenerateReviewDraftInput = {
  article: ArticleRow;
  evidence: EditorialEvidence[];
  languageCode: "en" | "uk" | "de";
  channelId?: string | null;
  allowUnverified?: boolean;
  lease?: { name: string; ownerId: string } | null;
  settingsSnapshot?: EditorialJsonObject | null;
  featureFlags?: EditorialJsonObject | null;
};

export type EditorialDraftGenerationResult = {
  draft: CreateReviewDraftInput;
  usageEvents: RecordAiUsageInput[];
  output?: EditorialJsonObject;
};

/** Adapter seam around the existing grounded draft and enrichment workflow. */
export interface EditorialDraftGateway {
  generate(
    input: GenerateReviewDraftInput,
    signal?: AbortSignal,
  ): Promise<EditorialDraftGenerationResult>;
}

export type GenerateReviewDraftResult = {
  draft: DraftRow;
  generation: EditorialDraftGenerationResult;
  usageEvents: AiUsageEventRow[];
};

export type EditorialPublicationRequest = {
  channelId: string;
  text: string;
  disableNotification: boolean;
};

export type EditorialPublicationReceipt = {
  messageId: number;
  messageDate?: number | null;
};

export interface EditorialPublicationGateway {
  publish(
    request: EditorialPublicationRequest,
    signal?: AbortSignal,
  ): Promise<EditorialPublicationReceipt>;
}

export type PublicationDeliveryOutcome = "rejected" | "uncertain";

/** Transport adapters use this error to distinguish a definitive rejection. */
export class PublicationDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: PublicationDeliveryOutcome,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicationDeliveryError";
  }
}

export type ExcludedTopicPolicyInput = {
  draftId: string;
  articleId: string;
  channelId: string;
  content: { text: string };
  settings: {
    version: number;
    excludedTopicCodes: string[];
  };
};

export type ExcludedTopicPolicyDecision =
  | { decision: "allow"; usageEvents?: RecordAiUsageInput[] }
  | {
      decision: "block" | "uncertain" | "error";
      reasonCode: string;
      topicCode?: string;
      provider?: string | null;
      model?: string | null;
      promptVersion?: string | null;
      usageEvents?: RecordAiUsageInput[];
    };

export interface ExcludedTopicPublicationPolicy {
  evaluate(
    input: ExcludedTopicPolicyInput,
    signal?: AbortSignal,
  ): Promise<ExcludedTopicPolicyDecision>;
}

export type PublishApprovedDraftInput = {
  draftId: string;
  channelId: string;
  publicationPath?: import("./editorial-persistence.contracts.js").PublicationPath;
  signal?: AbortSignal;
};

export type PublishApprovedDraftResult =
  | {
      status: "published";
      publication: PublishedPostRow;
      alreadyPublished: false;
    }
  | {
      status: "already_published";
      publication: PublishedPostRow;
      alreadyPublished: true;
    }
  | {
      status: "blocked" | "already_blocked";
      reasonCode: string;
      publication: null;
      draft: DraftRow;
    };

export type ReconcilePublicationInput =
  | {
      draftId: string;
      outcome: "sent";
      channelId: string;
      messageId: number;
    }
  | {
      draftId: string;
      outcome: "not-sent";
    };

export type ReconcilePublicationResult =
  | {
      outcome: "sent";
      publication: PublishedPostRow | undefined;
      draft: null;
    }
  | {
      outcome: "not-sent";
      publication: null;
      draft: DraftRow | undefined;
    };

export interface EditorialWorkflowApplicationPort {
  generateReviewDraft(
    input: GenerateReviewDraftInput,
    signal?: AbortSignal,
  ): Promise<GenerateReviewDraftResult>;
  publishApprovedDraft(
    input: PublishApprovedDraftInput,
  ): Promise<PublishApprovedDraftResult>;
  reconcilePublication(
    input: ReconcilePublicationInput,
  ): Promise<ReconcilePublicationResult>;
}
