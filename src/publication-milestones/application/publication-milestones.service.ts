import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import type {
  ArticlePublishedEventBus,
  ArticlePublishedEventSubscriber,
} from "../../editorial/editorial-application.contracts.js";
import { ARTICLE_PUBLISHED_EVENT_PUBLISHER } from "../../editorial/editorial-application.tokens.js";
import type {
  NewsFeatureFlagsPersistence,
  NewsSettingsPersistence,
} from "../../settings/settings.contracts.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
} from "../../settings/settings.tokens.js";
import { renderPublicationMilestoneMessage } from "../domain/publication-milestone-message.js";
import {
  PUBLICATION_MILESTONE_FEATURE_KEY,
  PublicationMilestoneDeliveryError,
  type PublicationMilestoneDeliveryGateway,
  type PublicationMilestoneRow,
  type PublicationMilestonesModuleOptions,
  type PublicationMilestonesPersistence,
} from "../publication-milestones.contracts.js";
import {
  PUBLICATION_MILESTONE_DELIVERY_GATEWAY,
  PUBLICATION_MILESTONES_OPTIONS,
  PUBLICATION_MILESTONES_REPOSITORY,
} from "../publication-milestones.tokens.js";

function rootErrorMessage(error: unknown): string {
  let current = error;
  while (
    current instanceof Error &&
    current.cause instanceof Error &&
    current.cause !== current
  ) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}

@Injectable()
export class PublicationMilestonesService
  implements ArticlePublishedEventSubscriber, OnModuleInit, OnModuleDestroy
{
  private unsubscribe?: () => void;

  constructor(
    @Inject(PUBLICATION_MILESTONES_REPOSITORY)
    private readonly milestones: PublicationMilestonesPersistence,
    @Inject(NEWS_SETTINGS_REPOSITORY)
    private readonly settings: NewsSettingsPersistence,
    @Inject(NEWS_FEATURE_FLAGS_REPOSITORY)
    private readonly featureFlags: NewsFeatureFlagsPersistence,
    @Inject(PUBLICATION_MILESTONE_DELIVERY_GATEWAY)
    private readonly delivery: PublicationMilestoneDeliveryGateway,
    @Inject(PUBLICATION_MILESTONES_OPTIONS)
    private readonly options: PublicationMilestonesModuleOptions,
    @Inject(ARTICLE_PUBLISHED_EVENT_PUBLISHER)
    private readonly events: ArticlePublishedEventBus,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe(this);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async handle(
    event: Parameters<ArticlePublishedEventSubscriber["handle"]>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    const channelId = event.publication.telegram_channel_id;
    const settings = await this.settings.getNewsSettings(channelId);
    if (settings === null) return;

    const featureFlag = (
      await this.featureFlags.getNewsFeatureFlags(channelId)
    ).find((row) => row.feature_key === PUBLICATION_MILESTONE_FEATURE_KEY);
    if (featureFlag?.state !== "enabled") return;

    const milestone = await this.milestones.claim({
      publicationId: event.publication.id,
      languageCode: settings.language_code,
      editorName: this.options.editorName,
    });
    if (milestone === null) return;
    await this.deliver(milestone, signal);
  }

  async retry(milestoneId: string, signal?: AbortSignal): Promise<void> {
    const milestone = await this.milestones.retry(milestoneId);
    if (milestone === null) return;
    await this.deliver(milestone, signal);
  }

  async reconcileSent(
    milestoneId: string,
    telegramMessageId: number,
  ): Promise<PublicationMilestoneRow | null> {
    return this.milestones.reconcileSent({ milestoneId, telegramMessageId });
  }

  async reconcileNotSentAndRetry(
    milestoneId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const reconciled = await this.milestones.reconcileNotSent(milestoneId);
    if (reconciled === null) return;
    await this.retry(milestoneId, signal);
  }

  private async deliver(
    milestone: PublicationMilestoneRow,
    signal?: AbortSignal,
  ): Promise<void> {
    if (milestone.state !== "sending" || milestone.claim_token === null) return;

    let receipt;
    try {
      receipt = await this.delivery.send(
        {
          channelId: milestone.telegram_channel_id,
          text: renderPublicationMilestoneMessage({
            ordinal: milestone.ordinal,
            languageCode: milestone.language_code,
            editorName: milestone.editor_name,
          }),
        },
        signal,
      );
    } catch (error) {
      const transition =
        error instanceof PublicationMilestoneDeliveryError &&
        error.outcome === "rejected"
          ? this.milestones.markFailed.bind(this.milestones)
          : this.milestones.markUncertain.bind(this.milestones);
      await transition({
        milestoneId: milestone.id,
        claimToken: milestone.claim_token,
        errorMessage: rootErrorMessage(error),
      });
      throw error;
    }

    const finalized = await this.milestones.markSent({
      milestoneId: milestone.id,
      claimToken: milestone.claim_token,
      telegramMessageId: receipt.messageId,
    });
    if (finalized === null) {
      throw new Error(
        "Milestone delivery was accepted but its fenced receipt was not persisted; operator reconciliation is required",
      );
    }
  }
}
