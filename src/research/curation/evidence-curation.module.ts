import { lookup } from "node:dns/promises";
import { Module, type DynamicModule } from "@nestjs/common";

import { StoryDeduplicationPersistenceModule } from "../../story-deduplication/story-deduplication-persistence.module.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../../story-deduplication/story-deduplication.tokens.js";
import { EvidenceCurationService } from "./evidence-curation.engine.js";
import type { DnsLookupPort, FactSearchPort, HttpPort, SleepPort, StructuredGenerationPort } from "./evidence-curation.contracts.js";
import {
  CURATION_DNS_LOOKUP,
  CURATION_FACT_SEARCH,
  CURATION_HTTP,
  CURATION_NOW,
  CURATION_SEMANTIC_ATTEMPT_LIMIT,
  CURATION_SLEEP,
  CURATION_STORY_DEDUPLICATION_PERSISTENCE,
  CURATION_STRUCTURED_GENERATION,
} from "./evidence-curation.tokens.js";

export type EvidenceCurationModuleOptions = {
  dns?: DnsLookupPort;
  http?: HttpPort;
  sleep?: SleepPort;
  structuredGeneration?: StructuredGenerationPort;
  factSearch?: FactSearchPort;
  now?: () => Date;
  semanticAttemptLimit?: number;
};

@Module({})
export class EvidenceCurationModule {
  static register(options: EvidenceCurationModuleOptions = {}): DynamicModule {
    return {
      module: EvidenceCurationModule,
      imports: [StoryDeduplicationPersistenceModule],
      providers: [
        EvidenceCurationService,
        {
          provide: CURATION_DNS_LOOKUP,
          useValue: options.dns ?? (async (hostname: string) => lookup(hostname, { all: true, verbatim: true })),
        },
        {
          provide: CURATION_HTTP,
          useValue: options.http ?? { fetch: async (url: URL, init: RequestInit) => fetch(url, init) },
        },
        {
          provide: CURATION_SLEEP,
          useValue: options.sleep ?? { sleep: (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)) },
        },
        { provide: CURATION_STRUCTURED_GENERATION, useValue: options.structuredGeneration ?? null },
        { provide: CURATION_FACT_SEARCH, useValue: options.factSearch ?? null },
        { provide: CURATION_STORY_DEDUPLICATION_PERSISTENCE, useExisting: STORY_DEDUPLICATION_PERSISTENCE },
        { provide: CURATION_NOW, useValue: options.now ?? (() => new Date()) },
        { provide: CURATION_SEMANTIC_ATTEMPT_LIMIT, useValue: Math.max(0, Math.min(3, Math.trunc(options.semanticAttemptLimit ?? 3))) },
      ],
      exports: [EvidenceCurationService],
    };
  }
}
