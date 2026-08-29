import type {
  SchedulerAuditApplicationPort,
  SchedulerAuditContext,
  SchedulerRunResult,
} from "./scheduler-application.contracts.js";

export type NotionAuditRun = {
  pageId: string;
  pageUrl: string;
  startedAt: Date;
};

export type NotionAuditLoggerPort = {
  start(input: { name: string; objective: string; links?: string }): Promise<NotionAuditRun>;
  finish(
    run: NotionAuditRun,
    finalization: { status: string; result: string; links?: string; error?: string },
  ): Promise<unknown>;
};

export type NotionAuditOutboxPort = {
  enqueueNotionAuditBackfill(record: {
    notion_page_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    last_error: string;
  }): Promise<unknown>;
};

/**
 * Decorator adapter around the scheduler's audited work, preserving the exact
 * semantics of legacy `withNotionAudit` (src/notion-audit.js:168):
 *
 * - fail-closed on the failure path: if the operation throws AND finalizing the
 *   audit record also throws, both are surfaced as an AggregateError rather
 *   than losing either;
 * - the operation's own error is rethrown unchanged when finalization succeeds;
 * - on the success path a finalization failure falls back to the durable
 *   `notion_audit_outbox` rather than failing the run, because the work already
 *   completed and the audit record is recoverable;
 * - with no outbox configured, a success-path finalization failure rethrows —
 *   audit loss is never silent.
 */
export class LegacySchedulerAuditAdapter implements SchedulerAuditApplicationPort {
  constructor(
    private readonly logger: NotionAuditLoggerPort,
    private readonly outbox?: NotionAuditOutboxPort | null,
  ) {}

  async run<T extends SchedulerRunResult>(
    context: SchedulerAuditContext,
    operation: () => Promise<T>,
    _signal?: AbortSignal,
  ): Promise<T> {
    const run = await this.logger.start({
      name: `Scheduled news run ${context.scheduleRunId}`,
      objective: `Automatic scheduled news pipeline for channel ${context.channelId} at settings version ${context.settingsVersion}.`,
    });

    let outcome: T;
    try {
      outcome = await operation();
    } catch (error) {
      try {
        await this.logger.finish(run, {
          status: "Failed",
          result: "Automated news pipeline did not complete.",
          links: run.pageUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          "Pipeline failed and its Notion audit record could not be finalized",
        );
      }
      throw error;
    }

    const finalization = {
      status: "Succeeded",
      result: `Scheduled news run finished with status ${outcome.status}.`,
      links: run.pageUrl,
    };
    try {
      await this.logger.finish(run, finalization);
    } catch (error) {
      if (!this.outbox) {
        throw error;
      }
      await this.outbox.enqueueNotionAuditBackfill({
        notion_page_id: run.pageId,
        event_type: "finalize_success",
        payload: {
          started_at: run.startedAt.toISOString(),
          finalization,
        },
        last_error: error instanceof Error ? error.message : String(error),
      });
    }

    return outcome;
  }
}
