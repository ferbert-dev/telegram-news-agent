import type { NewsLanguageCode } from "../settings/settings.contracts.js";

export const PUBLICATION_MILESTONE_FEATURE_KEY = "publication_milestones";

export type PublicationMilestoneState =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain";

export type PublicationMilestoneRow = {
  id: string;
  telegram_channel_id: string;
  ordinal: number;
  published_post_id: string;
  language_code: NewsLanguageCode;
  editor_name: string;
  state: PublicationMilestoneState;
  claim_token: string | null;
  telegram_message_id: number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  uncertain_at: string | null;
};

export type ClaimPublicationMilestoneInput = {
  publicationId: string;
  languageCode: NewsLanguageCode;
  editorName: string;
};

export type MarkPublicationMilestoneSentInput = {
  milestoneId: string;
  claimToken: string;
  telegramMessageId: number;
};

export type MarkPublicationMilestoneFailedInput = {
  milestoneId: string;
  claimToken: string;
  errorMessage: string;
};

export type MarkPublicationMilestoneUncertainInput =
  MarkPublicationMilestoneFailedInput;

export type ReconcilePublicationMilestoneSentInput = {
  milestoneId: string;
  telegramMessageId: number;
};

export interface PublicationMilestonesPersistence {
  claim(input: ClaimPublicationMilestoneInput): Promise<PublicationMilestoneRow | null>;
  retry(milestoneId: string): Promise<PublicationMilestoneRow | null>;
  markSent(
    input: MarkPublicationMilestoneSentInput,
  ): Promise<PublicationMilestoneRow | null>;
  markFailed(
    input: MarkPublicationMilestoneFailedInput,
  ): Promise<PublicationMilestoneRow | null>;
  markUncertain(
    input: MarkPublicationMilestoneUncertainInput,
  ): Promise<PublicationMilestoneRow | null>;
  reconcileSent(
    input: ReconcilePublicationMilestoneSentInput,
  ): Promise<PublicationMilestoneRow | null>;
  reconcileNotSent(
    milestoneId: string,
  ): Promise<PublicationMilestoneRow | null>;
}

export type PublicationMilestoneDeliveryRequest = {
  channelId: string;
  text: string;
};

export type PublicationMilestoneDeliveryReceipt = {
  messageId: number;
};

export interface PublicationMilestoneDeliveryGateway {
  send(
    request: PublicationMilestoneDeliveryRequest,
    signal?: AbortSignal,
  ): Promise<PublicationMilestoneDeliveryReceipt>;
}

export type PublicationMilestoneDeliveryOutcome = "rejected" | "uncertain";

export class PublicationMilestoneDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: PublicationMilestoneDeliveryOutcome,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicationMilestoneDeliveryError";
  }
}

export type PublicationMilestonesModuleOptions = {
  editorName: string;
  deliveryGateway: PublicationMilestoneDeliveryGateway;
};
