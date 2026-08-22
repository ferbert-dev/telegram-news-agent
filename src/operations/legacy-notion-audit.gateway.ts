import type {
  NotionAuditFinalization,
  NotionAuditGateway,
  NotionAuditRun,
} from "./operations-application.contracts.js";

export type LegacyNotionAuditFinalizer = {
  finish(
    run: NotionAuditRun,
    finalization: NotionAuditFinalization,
  ): Promise<unknown>;
};

export class LegacyNotionAuditGateway implements NotionAuditGateway {
  constructor(private readonly finalizer: LegacyNotionAuditFinalizer) {}

  async finalize(
    run: NotionAuditRun,
    finalization: NotionAuditFinalization,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.finalizer.finish(run, finalization);
    signal?.throwIfAborted();
  }
}
