import type {
  ArticleRow,
  CreateOrResumeArticleCandidateInput,
  FinishSearchRunInput,
  RawContentRow,
  SaveRawContentInput,
  SearchRunRow,
  StartSearchRunInput,
} from "./research-persistence.contracts.js";
import type {
  AiUsageEventRow,
  RecordAiUsageInput,
} from "../usage/usage-persistence.contracts.js";
import type { SourceWithTopics } from "../catalog/catalog-persistence.js";

export type ResearchJsonValue =
  | string
  | number
  | boolean
  | null
  | ResearchJsonObject
  | ResearchJsonValue[];

export type ResearchJsonObject = {
  [key: string]: ResearchJsonValue;
};

/** Transport-neutral AI generation request for a future provider adapter. */
export type ResearchAiRequest = {
  operation: string;
  input: ResearchJsonObject;
};

export type ResearchAiResponse = {
  output: ResearchJsonObject;
  usageEvents: RecordAiUsageInput[];
};

export interface ResearchAiGateway {
  generate(
    request: ResearchAiRequest,
    signal?: AbortSignal,
  ): Promise<ResearchAiResponse>;
}

/** Transport-neutral public-web search request for a future adapter. */
export type ResearchSearchRequest = {
  query: string;
  windowHours: number;
  limit: number;
  languageCode?: string;
  topicCodes?: string[];
  customTopics?: string[];
};

export type ResearchSearchItem = {
  url: string;
  title: string;
  summary: string;
  author?: string | null;
  publishedAt?: string | null;
  metadata?: ResearchJsonObject;
};

export type ResearchSearchResponse = {
  items: ResearchSearchItem[];
  usageEvents: RecordAiUsageInput[];
};

export interface ResearchSearchGateway {
  search(
    request: ResearchSearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchSearchResponse>;
}

/** Transport-neutral HTTP evidence request for a future safe-fetch adapter. */
export type ResearchFetchRequest = {
  url: string;
  kind: "feed" | "article";
};

export type ResearchFetchResponse = {
  finalUrl: string;
  content: string;
  contentType: "text" | "html" | "json";
  contentHash: string;
  metadata?: ResearchJsonObject;
};

export interface ResearchFetchGateway {
  fetch(
    request: ResearchFetchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchFetchResponse>;
}

export type ResearchExecutionCandidate = {
  article: CreateOrResumeArticleCandidateInput;
  rawContents: Array<Omit<SaveRawContentInput, "article_id">>;
};

/**
 * The bounded seam around the existing legacy discovery/ranking algorithm.
 * The legacy implementation remains unchanged; a later adapter can translate
 * its result into this persistence-level plan without duplicating it here.
 */
export type ResearchExecutionRequest = {
  searchRun: SearchRunRow;
  input: StartSearchRunInput;
  sources: SourceWithTopics[];
};

export type ResearchExecutionResult = {
  candidates: ResearchExecutionCandidate[];
  usageEvents: RecordAiUsageInput[];
  finish: Omit<FinishSearchRunInput, "resultCount">;
  output?: ResearchJsonObject;
};

export interface ResearchExecutionGateway {
  execute(
    request: ResearchExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ResearchExecutionResult>;
}

export type PersistedResearchCandidate = {
  article: ArticleRow;
  rawContents: RawContentRow[];
};

export type RunResearchResult = {
  run: SearchRunRow;
  completedRun: SearchRunRow;
  execution: ResearchExecutionResult;
  usageEvents: AiUsageEventRow[];
  candidates: PersistedResearchCandidate[];
};
