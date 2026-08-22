import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";

import { SettingsPersistenceModule } from "../settings/settings-persistence.module.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import { EditorialWorkflowService } from "./application/editorial-workflow.service.js";
import { GenerateReviewDraftUseCase } from "./application/generate-review-draft.use-case.js";
import { PublishApprovedDraftUseCase } from "./application/publish-approved-draft.use-case.js";
import { ReconcilePublicationUseCase } from "./application/reconcile-publication.use-case.js";
import type {
  EditorialDraftGateway,
  EditorialPublicationGateway,
  ExcludedTopicPublicationPolicy,
} from "./editorial-application.contracts.js";
import {
  EDITORIAL_DRAFT_GATEWAY,
  EDITORIAL_PUBLICATION_GATEWAY,
  EDITORIAL_WORKFLOW_APPLICATION,
  EXCLUDED_TOPIC_PUBLICATION_POLICY,
} from "./editorial-application.tokens.js";
import { EditorialIntegrationEventsModule } from "./editorial-integration-events.module.js";
import { EditorialPersistenceModule } from "./editorial-persistence.module.js";

export type EditorialApplicationGateways = {
  draft: EditorialDraftGateway;
  publication: EditorialPublicationGateway;
  excludedTopics: ExcludedTopicPublicationPolicy;
};

/**
 * Additive application boundary only. Provider, policy and publication
 * adapters are selected by a future standalone runtime composition ticket.
 */
@Module({})
export class EditorialApplicationModule {
  static register(gateways: EditorialApplicationGateways): DynamicModule {
    return {
      module: EditorialApplicationModule,
      imports: [
        EditorialPersistenceModule,
        UsagePersistenceModule,
        SettingsPersistenceModule,
        EditorialIntegrationEventsModule,
      ],
      providers: [
        { provide: EDITORIAL_DRAFT_GATEWAY, useValue: gateways.draft },
        {
          provide: EDITORIAL_PUBLICATION_GATEWAY,
          useValue: gateways.publication,
        },
        {
          provide: EXCLUDED_TOPIC_PUBLICATION_POLICY,
          useValue: gateways.excludedTopics,
        },
        GenerateReviewDraftUseCase,
        PublishApprovedDraftUseCase,
        ReconcilePublicationUseCase,
        EditorialWorkflowService,
        {
          provide: EDITORIAL_WORKFLOW_APPLICATION,
          useExisting: EditorialWorkflowService,
        },
      ],
      exports: [EDITORIAL_WORKFLOW_APPLICATION],
    };
  }
}
