import {
  buildSearchPlan,
  newsSettingsSnapshot,
  normalizeNewsSettings,
} from "../settings/domain/news-settings.js";

import type {
  EditorialWorkflowApplicationPort,
  PublishApprovedDraftResult,
} from "../editorial/editorial-application.contracts.js";
import type { EditorialPersistence } from "../editorial/editorial-persistence.contracts.js";
import type { PipelineLeaseApplicationPort } from "../operations/operations-application.contracts.js";
import type { JsonObject } from "../database/schema/common.js";

import {
  buildDraftEvidence,
  type NewsWorkflowResearchPort,
  type ResearchSelection,
} from "../scheduler/typed-scheduler-news-workflow.adapter.js";

import type {
  TelegramCheckpointsPersistence,
  TelegramNewsCheckpointRow,
  TelegramNewsCheckpointStatus,
  TelegramNewsJobClaimRow,
} from "./telegram-persistence.contracts.js";
import type {
  TelegramNewsJobOutcome,
  TelegramNewsJobWorkflowPort,
} from "./telegram-news-job-worker.js";

/** Legacy defaults from src/pipeline.js:180-181, which /news inherits. */
const PIPELINE_LEASE_NAME = "daily-news-pipeline";
const PIPELINE_LEASE_TTL_SECONDS = 15 * 60;

/** Thrown by the research engine when a tier yields nothing. Matched by name
 *  rather than by class, for the same reason the scheduler adapter does: this
 *  file must not import either research implementation. */
function isNoCandidates(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NoResearchCandidatesError";
}

type NormalizedSettings = {
  approvalPolicy: string;
  channelId?: string | null;
  languageCode: "en" | "uk" | "de";
  [key: string]: unknown;
};

export type TypedNewsJobWorkflowOptions = {
  research: NewsWorkflowResearchPort;
  editorial: EditorialWorkflowApplicationPort;
  editorialPersistence: EditorialPersistence;
  checkpoints: TelegramCheckpointsPersistence;
  pipelineLease: PipelineLeaseApplicationPort;
  /** Distinct per process, so a lease this runtime holds is attributable. */
  ownerId: string;
  leaseName?: string;
  leaseTtlSeconds?: number;
  leaseHeartbeatIntervalMs?: number;
  now?: () => Date;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

/**
 * The `/news` research phase for the typed runtime.
 *
 * A port-for-port reproduction of `runCheckpointedNewsSearch`
 * (src/news-search.js), which is what legacy's durable `/news` job runs. It is
 * reproduced rather than wrapped because the legacy function takes a
 * `NewsRepository`-shaped object and a `runWorkflow` callback that reaches
 * `src/pipeline.js`, and pointing the typed runtime at those would be exactly
 * the "clean up a legacy module by aiming it at the Nest layer" that CLAUDE.md
 * forbids -- in the other direction.
 *
 * The four behaviours that carry the guarantees, and are the reason this is not
 * a thin call-through:
 *
 * 1. **The checkpoint is read first.** A job whose research already produced a
 *    draft must not research again on a retry: the work is done and paid for.
 *    This is the same money-protection the worker's `outcomePersisted` guard
 *    gives at the outcome level, one layer down.
 * 2. **The pipeline lease is held across research and generation**, under the
 *    same name and TTL as legacy, so a `/news` run and a scheduled run cannot
 *    both drive the pipeline. Failure to acquire raises "already running",
 *    which the worker's classifier maps to a non-terminal `pipeline_busy`
 *    retry -- matching `defaultExecutionError` in src/telegram-news-jobs.js.
 * 3. **An automatic-approval channel still generates a *manual* draft first**,
 *    then publishes it as a second step. Generating an auto-published draft
 *    would publish before the checkpoint existed, so a crash between the two
 *    would leave a published article with no record that `/news` produced it.
 * 4. **Every terminal state is written to the checkpoint before it is
 *    returned.** The delivery phase reads the checkpoint, not the return value,
 *    so a status that never reached the checkpoint is a job that can never be
 *    delivered.
 *
 * The ownership heartbeat is local rather than shared with the scheduler's:
 * that one is built on `SchedulerTimer`, a scheduler-domain port, and importing
 * it here would drag that port into the telegram domain to save twenty lines.
 */
export class TypedNewsJobWorkflowAdapter implements TelegramNewsJobWorkflowPort {
  private readonly leaseName: string;
  private readonly leaseTtlSeconds: number;
  private readonly leaseHeartbeatIntervalMs: number;
  private readonly now: () => Date;
  private readonly setIntervalImpl: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;

  constructor(private readonly options: TypedNewsJobWorkflowOptions) {
    this.leaseName = options.leaseName ?? PIPELINE_LEASE_NAME;
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? PIPELINE_LEASE_TTL_SECONDS;
    this.leaseHeartbeatIntervalMs =
      options.leaseHeartbeatIntervalMs ??
      Math.max(1_000, Math.floor((this.leaseTtlSeconds * 1_000) / 3));
    this.now = options.now ?? (() => new Date());
    this.setIntervalImpl =
      options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalImpl =
      options.clearIntervalImpl ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  async run(
    job: TelegramNewsJobClaimRow,
    context: { signal?: AbortSignal },
  ): Promise<TelegramNewsJobOutcome> {
    const { signal } = context;
    signal?.throwIfAborted();
    const updateId = job.request_update_id;

    const existing = await this.options.checkpoints.getTelegramNewsCheckpoint(updateId);
    if (existing) {
      // Resume, exactly as legacy does. The one case that is not simply
      // reported back is a review-ready draft on an automatic channel: the
      // research finished but the publish did not, so the publish is what
      // resumes.
      const existingSettings = this.normalize(
        (existing.settings_snapshot as JsonObject | null) ?? job.settings_snapshot,
      );
      if (
        existing.status === "review_ready" &&
        existingSettings.approvalPolicy === "automatic"
      ) {
        return this.publishCheckpointedDraft(job, existing, existingSettings, signal);
      }
      return this.outcomeFromCheckpoint(existing);
    }

    const settings = this.normalize(job.settings_snapshot);
    const snapshot = newsSettingsSnapshot(settings) as JsonObject;

    let generated: { draftId: string; preview: string; windowHours: number } | null = null;
    try {
      generated = await this.research(
        job.telegram_channel_id,
        settings,
        snapshot,
        signal,
      );
    } catch (error) {
      if (!isNoCandidates(error)) throw error;
      // A dry run is a normal terminal outcome, not a failure -- but it must be
      // checkpointed, or a delivery retry would research all over again.
      const checkpoint = await this.options.checkpoints.saveTelegramNewsCheckpoint({
        update_id: updateId,
        status: "no_candidates",
        draft_id: null,
        preview: null,
        window_hours: null,
        publication_message_id: null,
        settings_snapshot: snapshot,
        updated_at: this.now().toISOString(),
      });
      return this.outcomeFromCheckpoint(checkpoint);
    }

    const checkpoint = await this.options.checkpoints.saveTelegramNewsCheckpoint({
      update_id: updateId,
      status: "review_ready",
      draft_id: generated.draftId,
      preview: generated.preview,
      window_hours: generated.windowHours,
      publication_message_id: null,
      settings_snapshot: snapshot,
      updated_at: this.now().toISOString(),
    });

    if (settings.approvalPolicy === "automatic") {
      return this.publishCheckpointedDraft(job, checkpoint, settings, signal);
    }
    return this.outcomeFromCheckpoint(checkpoint);
  }

  /**
   * The tier loop, under the pipeline lease.
   *
   * `approvalPolicy` is forced to "manual" for the generation call even on an
   * automatic channel, matching legacy's `pipelineSettings` override: the
   * publish is a separate, checkpointed step.
   */
  private async research(
    channelId: string,
    settings: NormalizedSettings,
    snapshot: JsonObject,
    signal?: AbortSignal,
  ): Promise<{ draftId: string; preview: string; windowHours: number }> {
    const acquired = await this.options.pipelineLease.acquire({
      name: this.leaseName,
      ownerId: this.options.ownerId,
      ttlSeconds: this.leaseTtlSeconds,
    });
    if (!acquired) {
      // Wording matched to legacy's, because the worker's error classifier
      // matches on it to choose a non-terminal `pipeline_busy` retry.
      throw new Error(`Pipeline "${this.leaseName}" is already running`);
    }

    const heartbeat = this.startLeaseHeartbeat();
    const generationSettings: JsonObject = { ...snapshot, approvalPolicy: "manual" };
    try {
      const tiers = buildSearchPlan(settings as unknown as Record<string, unknown>) as Array<{
        query: string;
        keywords: string[];
        windowHours: number;
      }>;
      let lastEmpty: unknown;
      for (const tier of tiers) {
        signal?.throwIfAborted();
        heartbeat.assertOwned();
        let selected: ResearchSelection;
        try {
          const research = await this.options.research.execute(
            {
              input: {
                query: tier.query,
                keywords: tier.keywords,
                windowHours: tier.windowHours,
                newsSettings: generationSettings,
              },
            },
            signal,
          );
          selected = research.selected;
        } catch (error) {
          // Only an empty tier escalates to a wider window. Anything else --
          // provider exhaustion, persistence failure, cancellation -- surfaces
          // immediately rather than being retried against more data.
          if (!isNoCandidates(error)) throw error;
          lastEmpty = error;
          continue;
        }

        signal?.throwIfAborted();
        // Checked between research and generation, matching src/pipeline.js: a
        // lease lost during a long research pass must fail before any
        // generation tokens are spent.
        heartbeat.assertOwned();
        const draft = await this.options.editorial.generateReviewDraft(
          {
            article: selected.article,
            evidence: buildDraftEvidence(selected),
            allowUnverified: !selected.source.is_primary,
            lease: { name: this.leaseName, ownerId: this.options.ownerId },
            languageCode: settings.languageCode,
            channelId,
            settingsSnapshot: generationSettings,
          } as never,
          signal,
        );
        heartbeat.assertOwned();
        return {
          draftId: draft.draft.id,
          preview: draft.generation.draft.body,
          windowHours: tier.windowHours,
        };
      }
      // Every tier came back empty. Rethrowing the engine's own error keeps the
      // `no_candidates` classification in one place -- the caller's catch.
      throw lastEmpty ?? new Error("No research tiers were planned");
    } finally {
      let heartbeatError: unknown;
      try {
        await heartbeat.stop();
      } catch (error) {
        heartbeatError = error;
      }
      // Released even when the heartbeat teardown failed: holding the lease for
      // its full TTL would block the scheduler as well as the next /news.
      await this.options.pipelineLease
        .release({ name: this.leaseName, ownerId: this.options.ownerId })
        .catch(() => undefined);
      if (heartbeatError) throw heartbeatError;
    }
  }

  /**
   * The automatic-approval publish, run after the review-ready checkpoint
   * exists. Reproduces `publishCheckpointedDraft` in src/news-search.js.
   */
  private async publishCheckpointedDraft(
    job: TelegramNewsJobClaimRow,
    checkpoint: TelegramNewsCheckpointRow,
    settings: NormalizedSettings,
    signal?: AbortSignal,
  ): Promise<TelegramNewsJobOutcome> {
    signal?.throwIfAborted();
    const draftId = checkpoint.draft_id;
    if (!draftId) {
      throw new Error("Automatic approval requires a checkpointed draft");
    }
    // The job row's channel, not the settings snapshot's. The snapshot is a
    // point-in-time copy taken at enqueue; the row is what the atomic function
    // recorded the request against, and it is what the suppression rule and
    // the policy-block lookup are keyed on. They agree today, and when they
    // stop agreeing the row is the one that is right.
    const channelId = job.telegram_channel_id;
    if (!channelId) {
      throw new Error("Automatic approval requires Telegram configuration");
    }

    const draft = await this.options.editorialPersistence.getDraft(draftId);
    if (draft.status === "review") {
      // `claim_draft_for_publication_with_policy` refuses anything but
      // `approved`, so this is a precondition of publishing, not a courtesy.
      await this.options.editorialPersistence.approveDraft(draftId);
    } else if (!new Set(["approved", "publishing", "published"]).has(draft.status)) {
      // Deliberately narrower than the scheduler's equivalent, which also
      // tolerates `rejected`. Legacy's /news path does not, and a rejected
      // draft reaching publication is the failure that matters most here.
      throw new Error(`Draft ${draftId} is not publishable`);
    }

    signal?.throwIfAborted();
    const published: PublishApprovedDraftResult =
      await this.options.editorial.publishApprovedDraft({
        draftId,
        channelId,
        publicationPath: "automatic_news",
        ...(signal ? { signal } : {}),
      });

    const snapshot = newsSettingsSnapshot(settings) as JsonObject;
    if (published.status === "blocked" || published.status === "already_blocked") {
      const saved = await this.options.checkpoints.saveTelegramNewsCheckpoint({
        update_id: checkpoint.update_id,
        status: "blocked_by_policy",
        draft_id: draftId,
        preview: checkpoint.preview,
        window_hours: checkpoint.window_hours,
        publication_message_id: null,
        settings_snapshot: snapshot,
        updated_at: this.now().toISOString(),
      });
      return this.outcomeFromCheckpoint(saved);
    }

    if (!published.publication) {
      // The compiler will not narrow this union across the two-literal status
      // check above, so the receipt is asserted rather than assumed -- the same
      // reason RunScheduledNewsOnceUseCase asserts it. It is also the right
      // failure: a "published" outcome with no message id would be checkpointed
      // as published and then reported to the operator with no message to point
      // at, and the worker's outcome validation would reject it anyway.
      throw new Error("Published outcome has no publication receipt");
    }
    const publicationMessageId = published.publication.telegram_message_id;
    const saved = await this.options.checkpoints.saveTelegramNewsCheckpoint({
      update_id: checkpoint.update_id,
      status: "published",
      draft_id: draftId,
      preview: checkpoint.preview,
      window_hours: checkpoint.window_hours,
      publication_message_id: publicationMessageId,
      settings_snapshot: snapshot,
      updated_at: this.now().toISOString(),
    });
    return this.outcomeFromCheckpoint(saved);
  }

  private outcomeFromCheckpoint(
    checkpoint: TelegramNewsCheckpointRow,
  ): TelegramNewsJobOutcome {
    return {
      status: checkpoint.status satisfies TelegramNewsCheckpointStatus,
      draftId: checkpoint.draft_id,
      publicationMessageId: checkpoint.publication_message_id,
    };
  }

  private normalize(snapshot: JsonObject): NormalizedSettings {
    return normalizeNewsSettings(snapshot) as unknown as NormalizedSettings;
  }

  /**
   * Renews the pipeline lease while research runs, and remembers a lost or
   * failed renewal so `assertOwned` can stop the run at the next checkpoint.
   * Once ownership is lost it stays lost: a later renewal succeeding would mean
   * some other holder's lease had expired in between, not that this run is
   * still the owner.
   */
  private startLeaseHeartbeat(): {
    assertOwned: () => void;
    stop: () => Promise<void>;
  } {
    let lostError: Error | null = null;
    let renewal: Promise<void> | null = null;
    let stopped = false;

    const renew = (): Promise<void> => {
      if (lostError) return Promise.reject(lostError);
      if (renewal) return renewal;
      renewal = (async () => {
        try {
          const renewed = await this.options.pipelineLease.renew({
            name: this.leaseName,
            ownerId: this.options.ownerId,
            ttlSeconds: this.leaseTtlSeconds,
          });
          if (!renewed) {
            lostError = new Error(
              `Pipeline lease "${this.leaseName}" ownership was lost`,
            );
            throw lostError;
          }
        } catch (error) {
          lostError ??= new Error(
            `Pipeline lease "${this.leaseName}" could not be renewed`,
            { cause: error },
          );
          throw lostError;
        } finally {
          renewal = null;
        }
      })();
      return renewal;
    };

    const handle = this.setIntervalImpl(() => {
      renew().catch(() => undefined);
    }, this.leaseHeartbeatIntervalMs);
    (handle as { unref?: () => void } | null)?.unref?.();

    return {
      assertOwned: () => {
        if (lostError) throw lostError;
      },
      stop: async () => {
        if (!stopped) {
          stopped = true;
          this.clearIntervalImpl(handle);
        }
        // Awaited before asserting, so a renewal already in flight when stop
        // was called is what decides the verdict rather than being ignored.
        await renewal?.catch(() => undefined);
        if (lostError) throw lostError;
      },
    };
  }
}
