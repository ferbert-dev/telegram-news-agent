export type NotionAuditOutboxRow = {
  id: string;
  notion_page_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  last_error: string;
  attempt_count: number;
  available_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
};

export type EnqueueNotionAuditBackfillInput = {
  notion_page_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  last_error: string;
  attempt_count?: number;
  available_at?: string | Date;
  completed_at?: string | Date | null;
  claimed_at?: string | Date | null;
};

export interface PipelineLeasesRepositoryPort {
  acquirePipelineLease(
    name: string,
    ownerId: string,
    ttlSeconds?: number,
  ): Promise<boolean>;
  renewPipelineLease(
    name: string,
    ownerId: string,
    ttlSeconds?: number,
  ): Promise<boolean>;
  releasePipelineLease(name: string, ownerId: string): Promise<boolean>;
}

/**
 * Read-only lease inspection for the readiness check.
 *
 * A separate port rather than a fourth method on PipelineLeasesRepositoryPort,
 * for two reasons. Health must never mutate the lease it is asserting about --
 * a probe that could renew would be a way to steal one. And the legacy
 * persistence facade unions over that port, so widening it would drag a
 * health-only method into the NewsRepository-shaped compatibility surface that
 * exists to shrink, not grow.
 */
export interface PipelineLeaseReadPort {
  readPipelineLease(name: string): Promise<PipelineLeaseSnapshot | null>;
}

export type PipelineLeaseSnapshot = {
  name: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  /**
   * PostgreSQL's clock, read in the same statement as the lease.
   *
   * `expires_at` is generated server-side, so comparing it against the
   * probe's own clock crosses two clocks. The renewal margin is only 40
   * seconds (20s renew against a 60s TTL), so under a minute of skew a
   * healthy runtime would read as expired on every probe -- a healthcheck
   * driven restart loop -- and with the skew the other way an expired lease
   * would read as valid. Comparing both values from the same clock removes
   * the question.
   */
  serverNowAt: string;
};

export interface NotionAuditOutboxRepositoryPort {
  enqueueNotionAuditBackfill(
    record: EnqueueNotionAuditBackfillInput,
  ): Promise<NotionAuditOutboxRow>;
  claimNotionAuditBackfill(limit?: number): Promise<NotionAuditOutboxRow[]>;
  completeNotionAuditBackfill(id: string): Promise<boolean>;
  retryNotionAuditBackfill(id: string, error: unknown): Promise<boolean>;
}
