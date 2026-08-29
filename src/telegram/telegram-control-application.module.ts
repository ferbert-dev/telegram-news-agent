import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";
import { randomBytes } from "node:crypto";

import type { EditorialWorkflowApplicationPort } from "../editorial/editorial-application.contracts.js";
import { EditorialPersistenceModule } from "../editorial/editorial-persistence.module.js";
import { SettingsApplicationModule } from "../settings/settings-application.module.js";
import { DecideTelegramReviewUseCase } from "./application/decide-telegram-review.use-case.js";
import { DeliverTelegramReviewUseCase } from "./application/deliver-telegram-review.use-case.js";
import { GetTelegramStatsUseCase } from "./application/get-telegram-stats.use-case.js";
import { HandleTelegramControlUpdateUseCase } from "./application/handle-telegram-control-update.use-case.js";
import { HandleTelegramLabsUseCase } from "./application/handle-telegram-labs.use-case.js";
import { HandleTelegramSettingsUseCase } from "./application/handle-telegram-settings.use-case.js";
import { HandleTelegramStatusUseCase } from "./application/handle-telegram-status.use-case.js";
import { RunTelegramNewsUseCase } from "./application/run-telegram-news.use-case.js";
import { TelegramControlService } from "./application/telegram-control.service.js";
import type {
  TelegramAdminAuthorizationGateway,
  TelegramControlAuditGateway,
  TelegramControlClock,
  TelegramControlFeatureGateway,
  TelegramControlIdGenerator,
  TelegramReviewPresentationGateway,
} from "./telegram-application.contracts.js";
import {
  TELEGRAM_ADMIN_AUTHORIZATION,
  TELEGRAM_CONTROL_APPLICATION,
  TELEGRAM_CONTROL_AUDIT,
  TELEGRAM_CONTROL_CLOCK,
  TELEGRAM_CONTROL_ID_GENERATOR,
  TELEGRAM_EDITORIAL_WORKFLOW,
  TELEGRAM_LABS_CONTROL,
  TELEGRAM_REVIEW_DELIVERY,
  TELEGRAM_REVIEW_PRESENTATION,
  TELEGRAM_SETTINGS_CONTROL,
  TELEGRAM_STATS_CONTROL,
  TELEGRAM_STATUS_CONTROL,
} from "./telegram-application.tokens.js";
import { TelegramPersistenceModule } from "./telegram-persistence.module.js";

export type TelegramControlApplicationGateways = {
  authorization: TelegramAdminAuthorizationGateway;
  audit: TelegramControlAuditGateway;
  editorial: EditorialWorkflowApplicationPort;
  reviewPresentation: TelegramReviewPresentationGateway;
  settings: TelegramControlFeatureGateway;
  labs: TelegramControlFeatureGateway;
  stats: TelegramControlFeatureGateway;
  status: TelegramControlFeatureGateway;
  ids?: TelegramControlIdGenerator;
  clock?: TelegramControlClock;
};

@Module({})
export class TelegramControlApplicationModule {
  static register(gateways: TelegramControlApplicationGateways): DynamicModule {
    return {
      module: TelegramControlApplicationModule,
      imports: [
        TelegramPersistenceModule,
        EditorialPersistenceModule,
        SettingsApplicationModule,
      ],
      providers: [
        { provide: TELEGRAM_ADMIN_AUTHORIZATION, useValue: gateways.authorization },
        { provide: TELEGRAM_CONTROL_AUDIT, useValue: gateways.audit },
        { provide: TELEGRAM_EDITORIAL_WORKFLOW, useValue: gateways.editorial },
        { provide: TELEGRAM_REVIEW_PRESENTATION, useValue: gateways.reviewPresentation },
        { provide: TELEGRAM_SETTINGS_CONTROL, useValue: gateways.settings },
        { provide: TELEGRAM_LABS_CONTROL, useValue: gateways.labs },
        { provide: TELEGRAM_STATS_CONTROL, useValue: gateways.stats },
        { provide: TELEGRAM_STATUS_CONTROL, useValue: gateways.status },
        {
          provide: TELEGRAM_CONTROL_ID_GENERATOR,
          useValue: gateways.ids ?? {
            next: () => randomBytes(24).toString("hex"),
          },
        },
        {
          provide: TELEGRAM_CONTROL_CLOCK,
          useValue: gateways.clock ?? { now: () => new Date() },
        },
        RunTelegramNewsUseCase,
        DecideTelegramReviewUseCase,
        // Registered so the scheduler's review-delivery adapter can resolve it.
        // It implements review-session create/rebind/renew but was previously
        // unreachable: @Injectable with no provider entry in any module.
        DeliverTelegramReviewUseCase,
        {
          provide: TELEGRAM_REVIEW_DELIVERY,
          useExisting: DeliverTelegramReviewUseCase,
        },
        HandleTelegramSettingsUseCase,
        HandleTelegramLabsUseCase,
        GetTelegramStatsUseCase,
        HandleTelegramStatusUseCase,
        HandleTelegramControlUpdateUseCase,
        TelegramControlService,
        {
          provide: TELEGRAM_CONTROL_APPLICATION,
          useExisting: TelegramControlService,
        },
      ],
      exports: [TELEGRAM_CONTROL_APPLICATION, TELEGRAM_REVIEW_DELIVERY],
    };
  }
}
