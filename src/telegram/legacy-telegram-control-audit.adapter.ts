import type {
  TelegramControlAuditContext,
  TelegramControlAuditGateway,
} from "./telegram-application.contracts.js";

export type TelegramControlAuditLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Structured-logging audit gateway for the Telegram control path.
 *
 * This is the last unimplemented dependency of TelegramControlApplicationModule,
 * and it is deliberately observability-only rather than a Notion-backed audit:
 * control updates are high-frequency and already durably tracked in PostgreSQL
 * via claim/finish, so a per-update remote audit write would add a network
 * failure mode to every button press for no recovery benefit. The scheduled
 * pipeline, which is low-frequency and genuinely needs an external record, keeps
 * its Notion audit (see LegacySchedulerAuditAdapter).
 *
 * Observability is best effort and must never change the routed outcome, so a
 * throwing logger is swallowed — matching how the excluded-topic policy and the
 * research engine already treat their own audit logging. The operation's own
 * error is always rethrown unchanged.
 */
export class LegacyTelegramControlAuditAdapter implements TelegramControlAuditGateway {
  constructor(private readonly log: TelegramControlAuditLog = console) {}

  private emit(event: Record<string, unknown>): void {
    try {
      this.log.info?.(JSON.stringify(event));
    } catch {
      // Observability must not alter control routing.
    }
  }

  async run<T>(
    context: TelegramControlAuditContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    this.emit({
      event: "telegram_control_update_started",
      update_id: context.updateId,
      update_kind: context.updateKind,
      route_kind: context.routeKind,
    });
    try {
      const outcome = await operation();
      this.emit({
        event: "telegram_control_update_completed",
        update_id: context.updateId,
        update_kind: context.updateKind,
        route_kind: context.routeKind,
        duration_ms: Date.now() - startedAt,
        status: (outcome as { status?: unknown } | null)?.status ?? null,
      });
      return outcome;
    } catch (error) {
      // Log only a coarse error identity: control payloads carry private
      // message content, so the message itself is never audited.
      this.emit({
        event: "telegram_control_update_failed",
        update_id: context.updateId,
        update_kind: context.updateKind,
        route_kind: context.routeKind,
        duration_ms: Date.now() - startedAt,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }
}
