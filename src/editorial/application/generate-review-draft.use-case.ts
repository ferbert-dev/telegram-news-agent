import { Inject, Injectable } from "@nestjs/common";

import type { EditorialPersistence } from "../editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../editorial-persistence.tokens.js";
import type { UsageReportingPersistence } from "../../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../usage/usage-persistence.tokens.js";
import type {
  EditorialDraftGateway,
  GenerateReviewDraftInput,
  GenerateReviewDraftResult,
} from "../editorial-application.contracts.js";
import { EDITORIAL_DRAFT_GATEWAY } from "../editorial-application.tokens.js";

@Injectable()
export class GenerateReviewDraftUseCase {
  constructor(
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorial: EditorialPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usage: UsageReportingPersistence,
    @Inject(EDITORIAL_DRAFT_GATEWAY)
    private readonly gateway: EditorialDraftGateway,
  ) {}

  async execute(
    input: GenerateReviewDraftInput,
    signal?: AbortSignal,
  ): Promise<GenerateReviewDraftResult> {
    signal?.throwIfAborted();
    const generation = await this.gateway.generate(input, signal);

    const usageEvents = [];
    for (const event of generation.usageEvents) {
      try {
        usageEvents.push(await this.usage.recordAiUsage(event));
      } catch {
        // Grounded generation already succeeded. Preserve the legacy
        // best-effort usage ledger boundary rather than losing the draft.
      }
    }

    signal?.throwIfAborted();
    if (generation.draft.article_id !== input.article.id) {
      throw new Error("Generated review draft does not match the requested article");
    }
    const draft = await this.editorial.createReviewDraft(generation.draft);
    if (draft === undefined) {
      throw new Error("Review draft was not created");
    }
    return { draft, generation, usageEvents };
  }
}
