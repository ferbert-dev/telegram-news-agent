import { Module, type DynamicModule } from "@nestjs/common";

import { EDITORIAL_DRAFT_GATEWAY } from "./editorial-application.tokens.js";
import {
  LegacyEditorialDraftGateway,
  type LegacyEditorialDraftGatewayDependencies,
} from "./legacy-editorial-draft.gateway.js";

@Module({})
export class LegacyEditorialDraftGatewayModule {
  static register(
    dependencies: LegacyEditorialDraftGatewayDependencies,
    provide?: typeof EDITORIAL_DRAFT_GATEWAY,
  ): DynamicModule {
    return {
      module: LegacyEditorialDraftGatewayModule,
      providers: [
        {
          provide: provide ?? EDITORIAL_DRAFT_GATEWAY,
          useValue: new LegacyEditorialDraftGateway(dependencies),
        },
      ],
      exports: [provide ?? EDITORIAL_DRAFT_GATEWAY],
    };
  }
}
