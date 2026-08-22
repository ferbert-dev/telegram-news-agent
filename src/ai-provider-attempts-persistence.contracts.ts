export type AiProviderAttemptStatus = "started" | "succeeded" | "failed";

export type StartAiProviderAttemptInput = {
  id: string;
  correlationId: string;
  operation: string;
  provider: string;
  model?: string | null;
  attemptNumber: number;
  startedAt: string;
};

export type CompleteAiProviderAttemptInput = {
  id: string;
  status: Exclude<AiProviderAttemptStatus, "started">;
  completedAt: string;
  latencyMs: number;
  errorCode?: string | null;
  httpStatus?: number | null;
  providerResponseId?: string | null;
  responseStatus?: string | null;
  incompleteReason?: string | null;
  refusal?: boolean | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  errorFingerprint?: string | null;
};

export interface AiProviderAttemptsPersistence {
  startAiProviderAttempt(input: StartAiProviderAttemptInput): Promise<unknown>;
  completeAiProviderAttempt(input: CompleteAiProviderAttemptInput): Promise<unknown>;
  getLatestAiProviderAttemptHealth(): Promise<unknown[]>;
}
