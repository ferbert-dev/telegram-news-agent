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

export interface NotionAuditOutboxRepositoryPort {
  enqueueNotionAuditBackfill(
    record: EnqueueNotionAuditBackfillInput,
  ): Promise<NotionAuditOutboxRow>;
  claimNotionAuditBackfill(limit?: number): Promise<NotionAuditOutboxRow[]>;
  completeNotionAuditBackfill(id: string): Promise<boolean>;
  retryNotionAuditBackfill(id: string, error: unknown): Promise<boolean>;
}
