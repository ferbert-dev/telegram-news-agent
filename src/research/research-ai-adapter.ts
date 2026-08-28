import { NewsCandidateCuration, NEWS_CANDIDATE_CURATION_JSON_SCHEMA } from "../news-curation.js";
import { SemanticStoryDecision, SEMANTIC_STORY_DECISION_JSON_SCHEMA } from "../story-deduplication.js";

import type { FallbackAiProvider } from "../ai/ai-provider-composition.js";
import type {
  NewsDiscoveryResponse,
  SourceDiscoveryProvider,
  SourceDiscoveryResponse,
} from "./source-acquisition.contracts.js";
import type { StructuredGeneration, StructuredGenerationPort } from "./curation/evidence-curation.contracts.js";

/**
 * Structured-generation calls made through EvidenceCurationService pass only
 * {systemInstruction, input, schemaName, usageOperation} — the zod/JSON
 * schema pair each call needs was dropped from that port on purpose (it's a
 * DI-time concern, not a per-call one). The concrete provider adapters
 * (openai-provider.js, gemini-provider.js) still require a zodSchema to
 * build their response format, so this registry restores it by schemaName,
 * reusing the exact schema constants the legacy news-curation.js and
 * story-deduplication.js callers already exported and validated.
 */
const SCHEMA_REGISTRY: Record<string, { zodSchema: unknown; jsonSchema: unknown }> = {
  news_candidate_curation: {
    zodSchema: NewsCandidateCuration,
    jsonSchema: NEWS_CANDIDATE_CURATION_JSON_SCHEMA,
  },
  semantic_story_deduplication: {
    zodSchema: SemanticStoryDecision,
    jsonSchema: SEMANTIC_STORY_DECISION_JSON_SCHEMA,
  },
};

/** Bridges FallbackAiProvider.generateStructured to EvidenceCurationService's StructuredGenerationPort. */
export class FallbackStructuredGenerationAdapter implements StructuredGenerationPort {
  constructor(private readonly ai: FallbackAiProvider) {}

  async generateStructured(input: {
    systemInstruction: string;
    input: unknown;
    schemaName: string;
    usageOperation: string;
  }): Promise<StructuredGeneration> {
    const schema = SCHEMA_REGISTRY[input.schemaName];
    if (!schema) {
      throw new Error(`No zod/JSON schema registered for schemaName "${input.schemaName}"`);
    }
    const result = await this.ai.generateStructured({
      systemInstruction: input.systemInstruction,
      input: input.input,
      zodSchema: schema.zodSchema,
      jsonSchema: schema.jsonSchema,
      schemaName: input.schemaName,
      usageOperation: input.usageOperation,
    });
    return {
      value: result.value,
      provider: result.provider ?? null,
      model: result.model ?? null,
      usageEvents: (result.usageEvents as StructuredGeneration["usageEvents"]) ?? [],
    };
  }
}

/**
 * Bridges FallbackAiProvider.searchFeeds/searchNews to SourceAcquisitionGateway's
 * SourceDiscoveryProvider port. The underlying provider adapters already
 * return items/provider/model/usageEvents in this shape (research.js relied
 * on the same values through its own untyped discoveryProvider parameter) —
 * FallbackAiProvider's return type is just looser (AiProviderResult), so this
 * is a type-level bridge, not a behavioral one.
 */
export class FallbackSourceDiscoveryAdapter implements SourceDiscoveryProvider {
  constructor(private readonly ai: FallbackAiProvider) {}

  searchFeeds(input: {
    topicCodes: string[];
    customTopics: string[];
    languageCode: string;
    limit: number;
  }): Promise<SourceDiscoveryResponse> {
    return this.ai.searchFeeds(input) as unknown as Promise<SourceDiscoveryResponse>;
  }

  searchNews(input: {
    query: string;
    windowHours: number;
    limit: number;
    languageCode?: string;
    topicCodes?: string[];
    customTopics?: string[];
    excludedTopics?: Array<{ code: string; name: string; description?: string }>;
  }): Promise<NewsDiscoveryResponse> {
    return this.ai.searchNews(input) as unknown as Promise<NewsDiscoveryResponse>;
  }
}
