import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Module, type DynamicModule } from "@nestjs/common";

import type { EditorialWorkflowApplicationPort } from "../editorial/editorial-application.contracts.js";
import { EditorialPersistenceModule } from "../editorial/editorial-persistence.module.js";
import type { PipelineLeaseApplicationPort } from "../operations/operations-application.contracts.js";
import { TelegramPersistenceModule } from "../telegram/telegram-persistence.module.js";
import { RunScheduledNewsOnceUseCase } from "./application/run-scheduled-news-once.use-case.js";
import { SchedulerService } from "./application/scheduler.service.js";
import type {
  SchedulerAuditApplicationPort,
  SchedulerClock,
  SchedulerIdGenerator,
  SchedulerNewsWorkflowApplicationPort,
  SchedulerNotificationApplicationPort,
  SchedulerReviewDeliveryApplicationPort,
  SchedulerTimer,
} from "./scheduler-application.contracts.js";
import {
  SCHEDULER_APPLICATION,
  SCHEDULER_AUDIT_APPLICATION,
  SCHEDULER_CLOCK,
  SCHEDULER_EDITORIAL_WORKFLOW_APPLICATION,
  SCHEDULER_ID_GENERATOR,
  SCHEDULER_NEWS_WORKFLOW_APPLICATION,
  SCHEDULER_NOTIFICATION_APPLICATION,
  SCHEDULER_PIPELINE_LEASE_APPLICATION,
  SCHEDULER_REVIEW_DELIVERY_APPLICATION,
  SCHEDULER_TIMER,
} from "./scheduler-application.tokens.js";
import { SchedulerPersistenceModule } from "./scheduler-persistence.module.js";

export type SchedulerApplicationGateways = {
  newsWorkflow: SchedulerNewsWorkflowApplicationPort;
  editorial: EditorialWorkflowApplicationPort;
  pipelineLease: PipelineLeaseApplicationPort;
  reviewDelivery: SchedulerReviewDeliveryApplicationPort;
  audit: SchedulerAuditApplicationPort;
  notification: SchedulerNotificationApplicationPort;
  ids?: SchedulerIdGenerator;
  clock?: SchedulerClock;
  timer?: SchedulerTimer;
};

/**
 * Finite scheduled-news composition boundary. It exposes one one-shot Symbol
 * port and deliberately starts no cron, interval loop, poller or runtime.
 */
@Module({})
export class SchedulerApplicationModule {
  static register(gateways: SchedulerApplicationGateways): DynamicModule {
    return {
      module: SchedulerApplicationModule,
      imports: [
        SchedulerPersistenceModule,
        TelegramPersistenceModule,
        EditorialPersistenceModule,
      ],
      providers: [
        {
          provide: SCHEDULER_NEWS_WORKFLOW_APPLICATION,
          useValue: gateways.newsWorkflow,
        },
        {
          provide: SCHEDULER_EDITORIAL_WORKFLOW_APPLICATION,
          useValue: gateways.editorial,
        },
        {
          provide: SCHEDULER_PIPELINE_LEASE_APPLICATION,
          useValue: gateways.pipelineLease,
        },
        {
          provide: SCHEDULER_REVIEW_DELIVERY_APPLICATION,
          useValue: gateways.reviewDelivery,
        },
        {
          provide: SCHEDULER_AUDIT_APPLICATION,
          useValue: gateways.audit,
        },
        {
          provide: SCHEDULER_NOTIFICATION_APPLICATION,
          useValue: gateways.notification,
        },
        {
          provide: SCHEDULER_ID_GENERATOR,
          useValue: gateways.ids ?? { next: () => randomUUID() },
        },
        {
          provide: SCHEDULER_CLOCK,
          useValue: gateways.clock ?? { now: () => new Date() },
        },
        {
          provide: SCHEDULER_TIMER,
          useValue:
            gateways.timer ??
            ({
              setInterval: (callback, intervalMs) => {
                const handle = setInterval(callback, intervalMs);
                handle.unref();
                return handle;
              },
              clearInterval: (handle) =>
                clearInterval(handle as NodeJS.Timeout),
            } satisfies SchedulerTimer),
        },
        RunScheduledNewsOnceUseCase,
        SchedulerService,
        {
          provide: SCHEDULER_APPLICATION,
          useExisting: SchedulerService,
        },
      ],
      exports: [SCHEDULER_APPLICATION],
    };
  }
}
