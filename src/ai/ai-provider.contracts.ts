export type AiProviderOperation =
  | "generateStructured"
  | "searchNews"
  | "searchFeeds"
  | "searchFact";

export type AiProviderResult = {
  provider?: string;
  model?: string;
  usageEvents?: unknown[];
  providerDiagnostics?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type AiProviderPort = {
  name: "openai" | "gemini" | "exa";
  model?: string | null;
  generateStructured?: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchNews?: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchFeeds?: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchFact?: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  testConnection?: () => Promise<AiProviderResult>;
};

import type { AiProviderAttemptsPersistence } from "../ai-provider-attempts-persistence.contracts.js";

export type AiProviderAttemptWriter = Pick<
  AiProviderAttemptsPersistence,
  "startAiProviderAttempt" | "completeAiProviderAttempt"
>;

export type AiProviderLogger = { warn?: (message: string) => void };

export type OpenAiSdkPort = unknown;
export type GeminiSdkPort = unknown;
export type ExaSdkPort = unknown;

export type GeminiClientPort = { client: GeminiSdkPort; model: string };
