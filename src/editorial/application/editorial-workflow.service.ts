import { Inject, Injectable } from "@nestjs/common";

import type {
  EditorialWorkflowApplicationPort,
  GenerateReviewDraftInput,
  GenerateReviewDraftResult,
  PublishApprovedDraftInput,
  PublishApprovedDraftResult,
  ReconcilePublicationInput,
  ReconcilePublicationResult,
} from "../editorial-application.contracts.js";
import { GenerateReviewDraftUseCase } from "./generate-review-draft.use-case.js";
import { PublishApprovedDraftUseCase } from "./publish-approved-draft.use-case.js";
import { ReconcilePublicationUseCase } from "./reconcile-publication.use-case.js";

@Injectable()
export class EditorialWorkflowService
  implements EditorialWorkflowApplicationPort
{
  constructor(
    @Inject(GenerateReviewDraftUseCase)
    private readonly generateUseCase: GenerateReviewDraftUseCase,
    @Inject(PublishApprovedDraftUseCase)
    private readonly publishUseCase: PublishApprovedDraftUseCase,
    @Inject(ReconcilePublicationUseCase)
    private readonly reconcileUseCase: ReconcilePublicationUseCase,
  ) {}

  generateReviewDraft(
    input: GenerateReviewDraftInput,
    signal?: AbortSignal,
  ): Promise<GenerateReviewDraftResult> {
    return this.generateUseCase.execute(input, signal);
  }

  publishApprovedDraft(
    input: PublishApprovedDraftInput,
  ): Promise<PublishApprovedDraftResult> {
    return this.publishUseCase.execute(input);
  }

  reconcilePublication(
    input: ReconcilePublicationInput,
  ): Promise<ReconcilePublicationResult> {
    return this.reconcileUseCase.execute(input);
  }
}
