import { Inject, Injectable } from "@nestjs/common";

import type {
  ArticleRow,
  ArticleStatus,
  ArticleTopicRow,
  ArticleTransitionChanges,
  CreateOrResumeArticleCandidateInput,
  FinishSearchRunInput,
  RawContentRow,
  ReplaceArticleTopicsInput,
  ResearchIngestionPersistence,
  SaveRawContentInput,
  SearchRunRow,
  StartSearchRunInput,
} from "../research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../research-persistence.tokens.js";
import type {
  ResearchExecutionInput,
  RunResearchResult,
} from "../research-gateway.contracts.js";
import type {
  AiUsageEventRow,
  RecordAiUsageInput,
  UsageReportingPersistence,
} from "../../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../usage/usage-persistence.tokens.js";
import { RunResearchUseCase } from "./run-research.use-case.js";

/** Public application facade for research ingestion and execution. */
@Injectable()
export class ResearchService implements ResearchIngestionPersistence {
  constructor(
    @Inject(RESEARCH_INGESTION_PERSISTENCE)
    private readonly research: ResearchIngestionPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usage: UsageReportingPersistence,
    @Inject(RunResearchUseCase)
    private readonly runResearchUseCase: RunResearchUseCase,
  ) {}

  runResearch(
    input: ResearchExecutionInput,
    signal?: AbortSignal,
  ): Promise<RunResearchResult> {
    return this.runResearchUseCase.execute(input, signal);
  }

  recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageEventRow> {
    return this.usage.recordAiUsage(input);
  }

  startSearchRun(input: StartSearchRunInput): Promise<SearchRunRow> {
    return this.research.startSearchRun(input);
  }

  finishSearchRun(
    id: string,
    input: FinishSearchRunInput,
  ): Promise<SearchRunRow> {
    return this.research.finishSearchRun(id, input);
  }

  failSearchRun(id: string, error: unknown): Promise<SearchRunRow> {
    return this.research.failSearchRun(id, error);
  }

  createOrResumeArticleCandidate(
    input: CreateOrResumeArticleCandidateInput,
  ): Promise<ArticleRow | null> {
    return this.research.createOrResumeArticleCandidate(input);
  }

  saveRawContent(input: SaveRawContentInput): Promise<RawContentRow> {
    return this.research.saveRawContent(input);
  }

  transitionArticle(
    id: string,
    from: ArticleStatus,
    to: ArticleStatus,
    changes?: ArticleTransitionChanges,
  ): Promise<ArticleRow> {
    return this.research.transitionArticle(id, from, to, changes);
  }

  replaceArticleTopics(
    input: ReplaceArticleTopicsInput,
  ): Promise<ArticleTopicRow[]> {
    return this.research.replaceArticleTopics(input);
  }
}
