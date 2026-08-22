import type { RecordAiUsageInput } from "../../usage/usage-persistence.contracts.js";
import type {
  RecentPublishedStoryRow,
  StoryDecisionSource,
  StoryRelation,
} from "../../story-deduplication/story-deduplication.contracts.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type DnsAddress = { address: string; family: number };
export type DnsLookupPort = (hostname: string, options: { all: true; verbatim: true }) => Promise<DnsAddress[]>;
export type HttpResponsePort = { ok: boolean; status: number; headers: Headers; text(): Promise<string>; body?: { cancel(): Promise<void> | void } | null };
export interface HttpPort { fetch(url: URL, init: RequestInit): Promise<HttpResponsePort>; }
export interface SleepPort { sleep(delayMs: number): Promise<void>; }
export type StructuredGeneration = { value: unknown; provider?: string | null; model?: string | null; usageEvents?: RecordAiUsageInput[] };
export interface StructuredGenerationPort { generateStructured(input: { systemInstruction: string; input: JsonValue; schemaName: string; usageOperation: string }): Promise<StructuredGeneration>; }
export type FactSearchResult = {
  value: unknown;
  sourceUrls: string[];
  provider?: string | null;
  model?: string | null;
  usageEvents?: RecordAiUsageInput[];
};
export interface FactSearchPort {
  searchFact(input: {
    query: string;
    expectedClaim: string;
    languageCode?: string;
  }): Promise<FactSearchResult>;
}

export type CurationCandidate = { canonicalUrl: string; title?: string | null; summary?: string | null; publisher?: string | null; publishedAt?: string | null; score?: number; source?: { name?: string | null; topic_codes?: string[]; reliability_score?: number | null; is_primary?: boolean } };
export type FactEvidence = { fact: null | { claim: string; sourceUrl: string; sourceTitle: string; sourceKind: "official" | "government" | "academic" | "reputable_news"; evidenceText: string } };
export type FactSearchOutcome = FactEvidence & { provider: string | null; model: string | null; usageEvents: RecordAiUsageInput[] };
export type ArticleEvidence = { text: string; contentHash: string; finalUrl: string };
export type StoryDecision = { fingerprint: string; relation: StoryRelation; duplicateOfArticleId: string | null; confidence: number; reason: string; decisionSource: StoryDecisionSource; usageEvents: RecordAiUsageInput[]; classifierAttempted: boolean; shortlist: Array<{ articleId: string; similarity: number }> };
export type StoryCandidate = Pick<CurationCandidate, "title" | "summary" | "publisher" | "publishedAt">;
export type NewsSettings = { languageCode?: string; topicCodes?: string[]; customTopics?: string[] };
export type RetryOptions = { attempts?: number; baseDelayMs?: number; shouldRetry?: (error: unknown) => boolean };
export type FetchOptions = { timeoutMs?: number; maxRedirects?: number; headers?: HeadersInit; maxBytes?: number };
export type CurationResult = { candidates: CurationCandidate[]; consideredCount: number; rankedCount?: number; provider: string | null; model: string | null; usageEvents: RecordAiUsageInput[] };
export type { RecentPublishedStoryRow };
