import "reflect-metadata";

import { DynamicModule, Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { PublicationMilestonesRepository } from "../database/repositories/publication-milestones-repository.js";
import { EditorialIntegrationEventsModule } from "../editorial/editorial-integration-events.module.js";
import { SettingsPersistenceModule } from "../settings/settings-persistence.module.js";
import { PublicationMilestonesService } from "./application/publication-milestones.service.js";
import type { PublicationMilestonesModuleOptions } from "./publication-milestones.contracts.js";
import {
  PUBLICATION_MILESTONE_DELIVERY_GATEWAY,
  PUBLICATION_MILESTONES_OPTIONS,
  PUBLICATION_MILESTONES_REPOSITORY,
} from "./publication-milestones.tokens.js";

@Module({})
export class PublicationMilestonesModule {
  static register(options: PublicationMilestonesModuleOptions): DynamicModule {
    return {
      module: PublicationMilestonesModule,
      imports: [
        DatabaseModule,
        SettingsPersistenceModule,
        EditorialIntegrationEventsModule,
      ],
      providers: [
        PublicationMilestonesRepository,
        PublicationMilestonesService,
        {
          provide: PUBLICATION_MILESTONES_REPOSITORY,
          useExisting: PublicationMilestonesRepository,
        },
        {
          provide: PUBLICATION_MILESTONE_DELIVERY_GATEWAY,
          useValue: options.deliveryGateway,
        },
        {
          provide: PUBLICATION_MILESTONES_OPTIONS,
          useValue: options,
        },
      ],
      exports: [
        PUBLICATION_MILESTONES_REPOSITORY,
        PublicationMilestonesService,
      ],
    };
  }
}
