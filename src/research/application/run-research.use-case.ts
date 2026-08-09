import { Inject, Injectable } from "@nestjs/common";

import type { CatalogPersistence } from "../../catalog/catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "../../catalog/catalog-persistence.tokens.js";
import type { ResearchIngestionPersistence } from "../research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../research-persistence.tokens.js";
import type {
  ResearchExecutionGateway,
  RunResearchResult,
} from "../research-gateway.contracts.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../research-gateway.tokens.js";
import type { UsageReportingPersistence } from "../../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../usage/usage-persistence.tokens.js";

/**
 * Owns only the persistence lifecycle around an explicit execution seam. It
 * intentionally does not reimplement the legacy discovery/ranking pipeline.
 */
@Injectable()
export class RunResearchUseCase {
  constructor(
    @Inject(RESEARCH_INGESTION_PERSISTENCE)
    private readonly research: ResearchIngestionPersistence,
    @Inject(CATALOG_PERSISTENCE)
    private readonly catalog: CatalogPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usage: UsageReportingPersistence,
    @Inject(RESEARCH_EXECUTION_GATEWAY)
    private readonly execution: ResearchExecutionGateway,
  ) {}

  async execute(
    input: Parameters<ResearchIngestionPersistence["startSearchRun"]>[0],
    signal?: AbortSignal,
  ): Promise<RunResearchResult> {
    const run = await this.research.startSearchRun(input);

    try {
      const sources = await this.catalog.listEnabledSources();
      const execution = await this.execution.execute(
        { searchRun: run, input, sources },
        signal,
      );
      const usageEvents = [];
      for (const event of execution.usageEvents) {
        try {
          usageEvents.push(await this.usage.recordAiUsage(event));
        } catch {
          // Legacy usage accounting is best effort: one telemetry write must
          // never turn otherwise successful research into a failed run.
        }
      }

      const candidates = [];
      for (const candidate of execution.candidates) {
        const article = await this.research.createOrResumeArticleCandidate(
          candidate.article,
        );
        if (article === null) continue;

        const rawContents = [];
        for (const content of candidate.rawContents) {
          rawContents.push(
            await this.research.saveRawContent({
              ...content,
              article_id: article.id,
            }),
          );
        }
        candidates.push({ article, rawContents });
      }

      const completedRun = await this.research.finishSearchRun(run.id, {
        ...execution.finish,
        resultCount: candidates.length,
      });
      return {
        run,
        completedRun,
        execution,
        usageEvents,
        candidates,
      };
    } catch (error) {
      await this.research.failSearchRun(run.id, error);
      throw error;
    }
  }
}
