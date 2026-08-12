import { Inject, Injectable } from "@nestjs/common";

import type {
  DeliverNotionAuditOutboxInput,
  DeliverNotionAuditOutboxResult,
  NotionAuditDeliveryApplicationPort,
  NotionAuditFinalization,
  NotionAuditGateway,
} from "../operations-application.contracts.js";
import { NOTION_AUDIT_GATEWAY } from "../operations-application.tokens.js";
import type {
  EnqueueNotionAuditBackfillInput,
  NotionAuditOutboxRepositoryPort,
  NotionAuditOutboxRow,
} from "../operations.interfaces.js";
import { NOTION_AUDIT_OUTBOX_REPOSITORY } from "../operations.tokens.js";

const INVALID_OUTBOX_PAYLOAD_ERROR =
  "Invalid persisted Notion audit outbox payload";
const STRICT_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidOutboxPayload(): Error {
  return new Error(INVALID_OUTBOX_PAYLOAD_ERROR);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatedDelivery(record: NotionAuditOutboxRow): {
  run: { pageId: string; startedAt: Date };
  finalization: NotionAuditFinalization;
} {
  if (
    typeof record.notion_page_id !== "string" ||
    record.notion_page_id.trim().length === 0 ||
    !isPlainObject(record.payload)
  ) {
    throw invalidOutboxPayload();
  }

  const startedAtValue = record.payload.started_at;
  if (
    typeof startedAtValue !== "string" ||
    !STRICT_ISO_TIMESTAMP.test(startedAtValue)
  ) {
    throw invalidOutboxPayload();
  }
  const timestamp = Date.parse(startedAtValue);
  if (!Number.isFinite(timestamp)) {
    throw invalidOutboxPayload();
  }
  const startedAt = new Date(timestamp);
  if (startedAt.toISOString() !== startedAtValue) {
    throw invalidOutboxPayload();
  }

  const finalization = record.payload.finalization;
  if (!isPlainObject(finalization)) {
    throw invalidOutboxPayload();
  }

  return {
    run: { pageId: record.notion_page_id, startedAt },
    finalization,
  };
}

@Injectable()
export class NotionAuditDeliveryService
  implements NotionAuditDeliveryApplicationPort
{
  constructor(
    @Inject(NOTION_AUDIT_OUTBOX_REPOSITORY)
    private readonly outbox: NotionAuditOutboxRepositoryPort,
    @Inject(NOTION_AUDIT_GATEWAY)
    private readonly gateway: NotionAuditGateway,
  ) {}

  enqueue(
    record: EnqueueNotionAuditBackfillInput,
  ): Promise<NotionAuditOutboxRow> {
    return this.outbox.enqueueNotionAuditBackfill(record);
  }

  async deliverPending(
    input: DeliverNotionAuditOutboxInput = {},
  ): Promise<DeliverNotionAuditOutboxResult> {
    const { limit = 25, signal } = input;
    signal?.throwIfAborted();

    const records = await this.outbox.claimNotionAuditBackfill(limit);
    const result = {
      claimed: records.length,
      completed: 0,
      failed: 0,
    };

    for (const record of records) {
      try {
        signal?.throwIfAborted();
        const delivery = validatedDelivery(record);
        await this.gateway.finalize(delivery.run, delivery.finalization, signal);
        await this.outbox.completeNotionAuditBackfill(record.id);
        result.completed += 1;
      } catch (error) {
        await this.outbox.retryNotionAuditBackfill(record.id, error);
        result.failed += 1;
        if (signal?.aborted) {
          signal.throwIfAborted();
        }
      }
    }

    return result;
  }
}
