import { Module, type DynamicModule } from "@nestjs/common";

import {
  EDITORIAL_PUBLICATION_GATEWAY,
  EXCLUDED_TOPIC_PUBLICATION_POLICY,
} from "./editorial-application.tokens.js";
import {
  LegacyEditorialPublicationGateway,
  type LegacyEditorialPublicationGatewayDependencies,
} from "./legacy-editorial-publication.gateway.js";
import {
  LegacyEditorialPublicationPolicyGateway,
  type LegacyEditorialPublicationPolicyGatewayDependencies,
} from "./legacy-editorial-publication-policy.gateway.js";

export type LegacyEditorialPublicationGatewayModuleDependencies = {
  publication: LegacyEditorialPublicationGatewayDependencies;
  excludedTopicPolicy: LegacyEditorialPublicationPolicyGatewayDependencies;
};

@Module({})
export class LegacyEditorialPublicationAdaptersModule {
  static register(
    dependencies: LegacyEditorialPublicationGatewayModuleDependencies,
    providePublication: symbol = EDITORIAL_PUBLICATION_GATEWAY,
    providePolicy: symbol = EXCLUDED_TOPIC_PUBLICATION_POLICY,
  ): DynamicModule {
    const publicationToken = providePublication ?? EDITORIAL_PUBLICATION_GATEWAY;
    const policyToken = providePolicy ?? EXCLUDED_TOPIC_PUBLICATION_POLICY;
    return {
      module: LegacyEditorialPublicationAdaptersModule,
      providers: [
        {
          provide: publicationToken,
          useValue: new LegacyEditorialPublicationGateway(
            dependencies.publication,
            dependencies.publication.sendMessage,
          ),
        },
        {
          provide: policyToken,
          useValue: new LegacyEditorialPublicationPolicyGateway(
            dependencies.excludedTopicPolicy,
          ),
        },
      ],
      exports: [publicationToken, policyToken],
    };
  }
}
