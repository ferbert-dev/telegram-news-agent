import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, eq } from "drizzle-orm";
import type { Pool } from "pg";

import type {
  AiProviderAttemptsPersistence,
  CompleteAiProviderAttemptInput,
  StartAiProviderAttemptInput,
} from "../../ai-provider-attempts-persistence.contracts.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { aiProviderAttempts } from "../schema/research.js";
import { RepositorySupport, toIsoTimestamp } from "./repository-support.js";

@Injectable()
export class AiProviderAttemptsRepository
  extends RepositorySupport
  implements AiProviderAttemptsPersistence
{
  constructor(@Inject(PG_POOL) pool: Pool, @Inject(DRIZZLE_DB) database: DrizzleDatabase) {
    super(pool, database);
  }

  startAiProviderAttempt(input: StartAiProviderAttemptInput) {
    return this.operation("Start AI provider attempt", () =>
      this.database.insert(aiProviderAttempts).values({
        id: input.id,
        correlationId: input.correlationId,
        operation: input.operation,
        provider: input.provider,
        model: input.model ?? null,
        attemptNumber: input.attemptNumber,
        status: "started",
        startedAt: toIsoTimestamp(input.startedAt),
      }).returning(),
    );
  }

  completeAiProviderAttempt(input: CompleteAiProviderAttemptInput) {
    const { id, completedAt, ...values } = input;
    return this.operation("Complete AI provider attempt", () =>
      this.database.update(aiProviderAttempts).set({
        ...values,
        completedAt: toIsoTimestamp(completedAt),
      }).where(eq(aiProviderAttempts.id, id)).returning(),
    );
  }

  getLatestAiProviderAttemptHealth() {
    return this.operation("Get latest AI provider attempt health", () =>
      this.database.selectDistinctOn([aiProviderAttempts.provider], {
        provider: aiProviderAttempts.provider,
        status: aiProviderAttempts.status,
        error_code: aiProviderAttempts.errorCode,
        operation: aiProviderAttempts.operation,
        started_at: aiProviderAttempts.startedAt,
        completed_at: aiProviderAttempts.completedAt,
        latency_ms: aiProviderAttempts.latencyMs,
        correlation_id: aiProviderAttempts.correlationId,
      }).from(aiProviderAttempts).orderBy(
        asc(aiProviderAttempts.provider), desc(aiProviderAttempts.startedAt),
        desc(aiProviderAttempts.attemptNumber), desc(aiProviderAttempts.id),
      ),
    );
  }
}
