import { Inject, Injectable } from "@nestjs/common";

import type {
  ResearchExecutionInput,
  ResearchExecutionGateway,
  RunResearchResult,
} from "../research-gateway.contracts.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../research-gateway.tokens.js";

/**
 * Delegates once to the stateful execution owner. Persistence must not be
 * duplicated around this seam because the legacy engine needs database-issued
 * article identifiers before evidence, policy and story-deduplication writes.
 */
@Injectable()
export class RunResearchUseCase {
  constructor(
    @Inject(RESEARCH_EXECUTION_GATEWAY)
    private readonly execution: ResearchExecutionGateway,
  ) {}

  async execute(
    input: ResearchExecutionInput,
    signal?: AbortSignal,
  ): Promise<RunResearchResult> {
    return this.execution.execute({ input }, signal);
  }
}
