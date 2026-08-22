import type { ArticleRow } from "./research-persistence.contracts.js";
import type { RecordAiUsageInput } from "../usage/usage-persistence.contracts.js";

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

export type ResearchExecutionInput = {
  query: string;
  keywords?: string[];
  windowHours?: number;
  newsSettings?: ResearchJsonObject | null;
};

export type ResearchExecutionRequest = {
  input: ResearchExecutionInput;
};

export type ResearchExecutionSource = {
  id: string | null;
  name: string;
  homepage_url: string | null;
  feed_url: string | null;
  source_type: string;
  reliability_score: number | null;
  is_primary: boolean;
  [key: string]: unknown;
};

export type ResearchExecutionCandidate = {
  article: ArticleRow;
  source: ResearchExecutionSource;
  canonicalUrl: string;
  title: string;
  summary: string;
  author: string | null;
  publishedAt: string | null;
  contentHash: string;
  score: number;
  evidenceText?: string;
  evidenceUrl?: string;
  evidenceKind?: string;
  publisher?: string;
  verificationStatus?: string;
  discoveryUrl?: string | null;
  discoveryKind?: string;
  searchRank?: number | null;
  unverified?: boolean;
  [key: string]: unknown;
};

export type RunResearchResult = {
  runId: string;
  selected: ResearchExecutionCandidate;
  candidates: ResearchExecutionCandidate[];
  feedErrors: Array<{ source_id: string; error: string }>;
  extractionErrors: Array<{
    article_id: string;
    source_url: string;
    error: string;
  }>;
};

/**
 * Stateful compatibility seam around the legacy research engine. The gateway
 * is the sole owner of the search-run and article mutation lifecycle. A signal
 * may prevent starting legacy execution; the legacy engine does not yet
 * support safe mid-flight cancellation.
 */
export interface ResearchExecutionGateway {
  execute(
    request: ResearchExecutionRequest,
    signal?: AbortSignal,
  ): Promise<RunResearchResult>;
}
