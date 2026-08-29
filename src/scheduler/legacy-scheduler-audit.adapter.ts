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
 * The audit record is written to a third-party Notion workspace, so the error
 * field must never carry a raw message: pipeline failures routinely embed
 * provider responses (which can include API keys), draft/article text and chat
 * ids. Production's legacy caller has always sanitized to this exact constant
 * (`src/telegram-bot.js` `withScheduledAudit` passes
 * `sanitizeError: () => "scheduled_run_failed"`), and the Telegram control path
 * does the same with an error code. Sanitizing is the convention on this seam,
 * not an optional extra.
 */
export const SCHEDULED_RUN_FAILURE_AUDIT_CODE = "scheduled_run_failed";

/**
 * Title of the Notion Agent Runs page. Constant on purpose: existing board
 * views, rollups and saved filters group scheduled runs by this exact string,
 * so the per-run identifier belongs in `objective`, never in `name`.
 */
export const SCHEDULED_RUN_AUDIT_NAME = "Telegram scheduler - news run";

/**
 * Decorator adapter around the scheduler's audited work, preserving the
 * semantics of legacy `withNotionAudit` (src/notion-audit.js:168) as invoked by
 * production's `withScheduledAudit`:
 *
 * - the recorded error is always the sanitized constant, never the raw message;
 * - fail-closed on the failure path: if the operation throws AND finalizing the
 *   audit record also throws, both are surfaced as an AggregateError rather
 *   than losing either;
 * - the operation's own error is rethrown unchanged when finalization succeeds;
 * - on the success path a finalization failure falls back to the durable
 *   `notion_audit_outbox` rather than failing the run, because the work already
 *   completed and the audit record is recoverable;
 * - with no outbox configured, a success-path finalization failure rethrows —
 *   audit loss is never silent.
 *
 * The abort signal is honored around each remote write, matching
 * LegacyNotionAuditGateway: without it a SIGTERM arriving here would still
 * issue two uncancellable Notion HTTP calls and could hold shutdown past
 * compose's 45s stop_grace_period.
 */
export class LegacySchedulerAuditAdapter implements SchedulerAuditApplicationPort {
  constructor(
    private readonly logger: NotionAuditLoggerPort,
    private readonly outbox?: NotionAuditOutboxPort | null,
  ) {}

  async run<T extends SchedulerRunResult>(
    context: SchedulerAuditContext,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const run = await this.logger.start({
      name: SCHEDULED_RUN_AUDIT_NAME,
      objective: `Run scheduled news occurrence ${context.scheduleRunId} for channel ${context.channelId} using settings version ${context.settingsVersion}.`,
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
          error: SCHEDULED_RUN_FAILURE_AUDIT_CODE,
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
      result: `Scheduled news outcome: ${outcome.status}.`,
      links: run.pageUrl,
    };
    try {
      // An abort here routes to the durable outbox below rather than issuing
      // an uncancellable Notion write during shutdown. The work already
      // succeeded, so losing the outcome to an abort would be worse than
      // deferring its audit record.
      signal?.throwIfAborted();
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
