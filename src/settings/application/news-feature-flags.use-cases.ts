import { Inject, Injectable } from "@nestjs/common";

import type {
  GetOrCreateNewsFeatureFlagsInput,
  NewsFeatureFlagRow,
  NewsFeatureFlagsPersistence,
  UpdateNewsFeatureFlagInput,
} from "../settings.contracts.js";
import { NEWS_FEATURE_FLAGS_REPOSITORY } from "../settings.tokens.js";

/** Transport-neutral Labs feature-flag use cases. */
@Injectable()
export class NewsFeatureFlagsUseCases {
  constructor(
    @Inject(NEWS_FEATURE_FLAGS_REPOSITORY)
    private readonly featureFlags: NewsFeatureFlagsPersistence,
  ) {}

  getOrCreate(
    input: GetOrCreateNewsFeatureFlagsInput,
  ): Promise<NewsFeatureFlagRow[]> {
    return this.featureFlags.getOrCreateNewsFeatureFlags(input);
  }

  get(channelId: string): Promise<NewsFeatureFlagRow[]> {
    return this.featureFlags.getNewsFeatureFlags(channelId);
  }

  update(
    input: UpdateNewsFeatureFlagInput,
  ): Promise<NewsFeatureFlagRow | null> {
    return this.featureFlags.updateNewsFeatureFlag(input);
  }
}
