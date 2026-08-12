import type {
  EnqueueNotionAuditBackfillInput,
  NotionAuditOutboxRow,
} from "./operations.interfaces.js";

export type PipelineLeaseRequest = {
  name: string;
  ownerId: string;
  ttlSeconds?: number;
};

export type PipelineLeaseReleaseRequest = Omit<
  PipelineLeaseRequest,
  "ttlSeconds"
>;

export interface PipelineLeaseApplicationPort {
  acquire(request: PipelineLeaseRequest): Promise<boolean>;
  renew(request: PipelineLeaseRequest): Promise<boolean>;
  release(request: PipelineLeaseReleaseRequest): Promise<boolean>;
}

export type NotionAuditRun = {
  pageId: string;
  startedAt: Date;
};

export type NotionAuditFinalization = Record<string, unknown>;

/** Outbound-only boundary implemented by a future Notion transport adapter. */
export interface NotionAuditGateway {
  finalize(
    run: NotionAuditRun,
    finalization: NotionAuditFinalization,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type DeliverNotionAuditOutboxInput = {
  limit?: number;
  signal?: AbortSignal;
};

export type DeliverNotionAuditOutboxResult = {
  claimed: number;
  completed: number;
  failed: number;
};

export interface NotionAuditDeliveryApplicationPort {
  enqueue(
    record: EnqueueNotionAuditBackfillInput,
  ): Promise<NotionAuditOutboxRow>;
  deliverPending(
    input?: DeliverNotionAuditOutboxInput,
  ): Promise<DeliverNotionAuditOutboxResult>;
}
