import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { StoryDeduplicationRepository } from "../database/repositories/story-deduplication-repository.js";
import type { StoryDeduplicationPersistence } from "./story-deduplication.contracts.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "./story-deduplication.tokens.js";

const storyDeduplicationProvider: Provider<StoryDeduplicationPersistence> = {
  provide: STORY_DEDUPLICATION_PERSISTENCE,
  useExisting: StoryDeduplicationRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [StoryDeduplicationRepository, storyDeduplicationProvider],
  exports: [STORY_DEDUPLICATION_PERSISTENCE],
})
export class StoryDeduplicationPersistenceModule {}
