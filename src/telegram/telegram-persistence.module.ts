import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { TelegramCheckpointsRepository } from "./telegram-checkpoints-repository.js";
import { TelegramReviewSessionsRepository } from "./telegram-review-sessions-repository.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
  TELEGRAM_UPDATES_PERSISTENCE,
} from "./telegram-persistence.tokens.js";
import { TelegramUpdatesRepository } from "./telegram-updates-repository.js";

const telegramPersistenceProviders: Provider[] = [
  TelegramUpdatesRepository,
  TelegramCheckpointsRepository,
  TelegramReviewSessionsRepository,
  {
    provide: TELEGRAM_UPDATES_PERSISTENCE,
    useExisting: TelegramUpdatesRepository,
  },
  {
    provide: TELEGRAM_CHECKPOINTS_PERSISTENCE,
    useExisting: TelegramCheckpointsRepository,
  },
  {
    provide: TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
    useExisting: TelegramReviewSessionsRepository,
  },
];

@Module({
  imports: [DatabaseModule],
  providers: telegramPersistenceProviders,
  exports: [
    TELEGRAM_UPDATES_PERSISTENCE,
    TELEGRAM_CHECKPOINTS_PERSISTENCE,
    TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
  ],
})
export class TelegramPersistenceModule {}
