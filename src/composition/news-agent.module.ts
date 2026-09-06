import "reflect-metadata";

import { Inject, Injectable, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";

import { callTelegram } from "../telegram.js";
import { getNewsEditor } from "../editor.js";
import { getOpenAiConfig } from "../openai-provider.js";
import { getGeminiProviderConfig } from "../gemini-provider.js";
import { NotionAuditLogger, getNotionAuditConfig } from "../notion-audit.js";
import { AiProvidersModule } from "../ai/ai-providers.module.js";
import { BUILTIN_PROVIDER_DESCRIPTORS } from "../ai/providers/index.js";
import { AI_PROVIDER } from "../ai/ai-provider.tokens.js";
import type { FallbackAiProvider } from "../ai/ai-provider-composition.js";

import { DatabaseModule } from "../database/database.module.js";
import {
  DEFAULT_CORROBORATION_OPTIONS,
  EvidenceCorroborationService,
} from "../editorial/corroboration/evidence-corroboration.service.js";
import { FactPlanService } from "../editorial/corroboration/fact-plan.service.js";
import { buildArticleContentPort } from "../research/content/article-content.factory.js";
import { PersistenceFacadeModule } from "../persistence/persistence-facade.module.js";
import { LEGACY_PERSISTENCE } from "../persistence/legacy-persistence.tokens.js";
import type { LegacyPersistence } from "../persistence/legacy-persistence.contracts.js";

import { EditorialApplicationModule } from "../editorial/editorial-application.module.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../editorial/editorial-application.tokens.js";
import type { EditorialWorkflowApplicationPort } from "../editorial/editorial-application.contracts.js";
import { LegacyEditorialDraftGateway } from "../editorial/legacy-editorial-draft.gateway.js";
import { LegacyEditorialPublicationGateway } from "../editorial/legacy-editorial-publication.gateway.js";
import { LegacyEditorialPublicationPolicyGateway } from "../editorial/legacy-editorial-publication-policy.gateway.js";

import { OperationsApplicationModule } from "../operations/operations-application.module.js";
import { PIPELINE_LEASE_APPLICATION } from "../operations/operations-application.tokens.js";
import type { PipelineLeaseApplicationPort } from "../operations/operations-application.contracts.js";
import { LegacyNotionAuditGateway } from "../operations/legacy-notion-audit.gateway.js";

import { TelegramPersistenceModule } from "../telegram/telegram-persistence.module.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_NEWS_JOBS_PERSISTENCE,
  TELEGRAM_UPDATES_PERSISTENCE,
} from "../telegram/telegram-persistence.tokens.js";
import type {
  TelegramCheckpointsPersistence,
  TelegramNewsJobsPersistence,
  TelegramUpdatesPersistence,
} from "../telegram/telegram-persistence.contracts.js";
import { TelegramControlApplicationModule } from "../telegram/telegram-control-application.module.js";
import {
  TELEGRAM_CONTROL_APPLICATION,
  TELEGRAM_REVIEW_DELIVERY,
} from "../telegram/telegram-application.tokens.js";
import { LegacyTelegramControlAuditAdapter } from "../telegram/legacy-telegram-control-audit.adapter.js";
import {
  TelegramBotApiGateway,
  TelegramBotApiOutcomeRenderer,
  type TelegramBotApiCall,
} from "../telegram/transport/telegram-bot-api.gateway.js";
import {
  TelegramLegacyLabsGateway,
  TelegramLegacySettingsGateway,
  TelegramLegacyStatsGateway,
  TelegramLegacyStatusGateway,
} from "../telegram/transport/telegram-legacy-feature.gateways.js";
import { TelegramControlTransportHandler } from "../telegram/transport/telegram-control-transport.handler.js";
import { TelegramNewsJobWorker } from "../telegram/telegram-news-job-worker.js";
import { TypedNewsJobWorkflowAdapter } from "../telegram/typed-news-job-workflow.adapter.js";
import { TypedNewsJobDeliveryAdapter } from "../telegram/typed-news-job-delivery.adapter.js";
import {
  TELEGRAM_CONTROL_POLLER_LEASE_NAME,
  TelegramPollingWorker,
} from "../telegram/telegram-polling-worker.js";

import { SchedulerApplicationModule } from "../scheduler/scheduler-application.module.js";
import { SCHEDULER_APPLICATION } from "../scheduler/scheduler-application.tokens.js";
import type { SchedulerApplicationPort } from "../scheduler/scheduler-application.contracts.js";
import { NewsSchedulerWorker } from "../scheduler/news-scheduler-worker.js";
import { LegacySchedulerAuditAdapter } from "../scheduler/legacy-scheduler-audit.adapter.js";
import { TelegramSchedulerNotificationAdapter } from "../scheduler/telegram-scheduler-notification.adapter.js";
import { TelegramSchedulerReviewDeliveryAdapter } from "../scheduler/telegram-scheduler-review-delivery.adapter.js";
import { TypedSchedulerNewsWorkflowAdapter } from "../scheduler/typed-scheduler-news-workflow.adapter.js";

import { TypedResearchExecutionGatewayModule } from "../research/typed-research-execution.module.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../research/research-gateway.tokens.js";

import { EditorialPersistenceModule } from "../editorial/editorial-persistence.module.js";
import { EDITORIAL_PERSISTENCE } from "../editorial/editorial-persistence.tokens.js";
import type { EditorialPersistence } from "../editorial/editorial-persistence.contracts.js";

import { RuntimeHealthWorker } from "../runtime/runtime-health.js";
import { PIPELINE_LEASES_REPOSITORY } from "../operations/operations.tokens.js";
import { randomUUID } from "node:crypto";

import { LateBoundPortRegistry } from "./late-bound-port.js";

/** Worker tokens, in the coordinator's required start order. */
export const TELEGRAM_POLLING_WORKER = Symbol("TELEGRAM_POLLING_WORKER");
export const NEWS_SCHEDULER_WORKER = Symbol("NEWS_SCHEDULER_WORKER");
export const TELEGRAM_NEWS_JOB_WORKER = Symbol("TELEGRAM_NEWS_JOB_WORKER");
export const RUNTIME_HEALTH_WORKER = Symbol("RUNTIME_HEALTH_WORKER");

/**
 * The durable-`/news` worker's tunables, read the way legacy reads them.
 *
 * Bounds are legacy's, from `getTelegramNewsJobsConfig`, and an out-of-range or
 * unparseable value is ignored rather than thrown on: this runs inside module
 * registration, and refusing to boot over a mistyped poll interval would take
 * the bot down for a setting the default already covers. An unset variable and
 * a nonsense one therefore behave the same way -- the worker's default.
 *
 * `TELEGRAM_NEWS_JOB_MODE` is deliberately NOT read. On this runtime there is
 * no inline `/news` path to fall back to, so honouring an "off" mode would
 * reproduce the dead queue rather than disable a feature.
 */
export function readNewsJobSettings(env: NodeJS.ProcessEnv): {
  pollIntervalMs?: number;
  staleAfterSeconds?: number;
  maxExecutionAttempts?: number;
  maxDeliveryAttempts?: number;
} {
  const bounded = (raw: string | undefined, min: number, max: number): number | undefined => {
    if (raw == null || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return undefined;
    return parsed;
  };
  const settings: Record<string, number> = {};
  const pollIntervalMs = bounded(env.TELEGRAM_NEWS_JOB_POLL_INTERVAL_MS, 100, 60_000);
  if (pollIntervalMs !== undefined) settings.pollIntervalMs = pollIntervalMs;
  const staleAfterSeconds = bounded(env.TELEGRAM_NEWS_JOB_STALE_AFTER_SECONDS, 30, 3_600);
  if (staleAfterSeconds !== undefined) settings.staleAfterSeconds = staleAfterSeconds;
  const maxExecutionAttempts = bounded(env.TELEGRAM_NEWS_JOB_MAX_EXECUTION_ATTEMPTS, 1, 20);
  if (maxExecutionAttempts !== undefined) settings.maxExecutionAttempts = maxExecutionAttempts;
  const maxDeliveryAttempts = bounded(env.TELEGRAM_NEWS_JOB_MAX_DELIVERY_ATTEMPTS, 1, 50);
  if (maxDeliveryAttempts !== undefined) settings.maxDeliveryAttempts = maxDeliveryAttempts;
  return settings;
}

export type NewsAgentRuntimeIdentity = {
  botUsername: string;
  botId: number;
  channelId: string;
};

export type NewsAgentModuleOptions = {
  token: string;
  /** Stable identity for this process, echoed into the readiness file. */
  runtimeId?: string;
  healthFilePath?: string;
  /** Resolved by the entry point via a getMe call before the container is built. */
  identity: NewsAgentRuntimeIdentity;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  /**
   * The workers that will start before the health worker, and the update mode
   * the entry point validated. Both are passed in rather than assumed, so the
   * readiness file describes the runtime that was actually started.
   */
  startedWorkers?: readonly string[];
  updateMode?: string;
};

/** The name each worker token resolves to, so a token list can be described. */
export const RUNTIME_WORKER_NAMES: ReadonlyMap<symbol, string> = new Map([
  [TELEGRAM_POLLING_WORKER, "telegram-polling"],
  [NEWS_SCHEDULER_WORKER, "news-scheduler"],
  [TELEGRAM_NEWS_JOB_WORKER, "telegram-news-jobs"],
  [RUNTIME_HEALTH_WORKER, "runtime-health"],
]);

/**
 * The workers that will have started by the time the health worker publishes.
 *
 * Derived from the token list the runtime is actually about to start, not
 * declared separately. That distinction is the whole point: a hardcoded
 * constant compared against a hardcoded expectation is a tautology, and the
 * failure this field exists to catch -- a token list built by a filter or a
 * conditional that drops the scheduler -- would not change either side of it.
 * Here, dropping a token drops a name.
 */
export function startedWorkerNames(tokens: readonly symbol[]): string[] {
  return tokens
    .filter((token) => token !== RUNTIME_HEALTH_WORKER)
    .map((token) => RUNTIME_WORKER_NAMES.get(token) ?? String(token.description ?? token));
}

/**
 * The composition root: the one place that assembles every application module
 * with real adapters and registers both runtime workers.
 *
 * Deliberately named `*.module.ts` under `src/composition/` rather than
 * `*-application.module.ts`. The architecture guard treats an
 * `-application`-suffixed file as application-layer and forbids it from
 * importing transport, provider SDKs, or legacy runtime modules — all of which
 * a composition root must import by definition. This is the one file whose job
 * is to know about everything.
 */
@Module({})
export class NewsAgentModule {
  static register(options: NewsAgentModuleOptions): DynamicModule {
    const env = options.env ?? process.env;
    const newsJobSettings = readNewsJobSettings(env);
    const { token, identity } = options;
    const appVersion = options.appVersion ?? env.APP_VERSION ?? "local";
    const runtimeId = options.runtimeId ?? randomUUID();
    // Generated here rather than left to the worker's own default, because the
    // readiness file must name the same owner id the lease row will carry --
    // that equality is what makes the health check verifiable rather than
    // self-asserted.
    const pollerOwnerId = randomUUID();
    const newsJobOwnerId = randomUUID();

    // --- Late-bound ports -------------------------------------------------
    // Each of these is required by a `register()` call that runs before the
    // container exists, but is satisfied by a singleton that only exists
    // inside it. `RuntimeBinder.onModuleInit` fills them, which Nest runs
    // during context creation and therefore strictly before any worker starts.
    // The only way to make a late-bound port, so every one is covered by the
    // unbound check below. There is no list, and no count, to keep in step.
    const ports = new LateBoundPortRegistry();
    const legacyPersistence = ports.create<LegacyPersistence>("legacy-persistence");
    const editorialWorkflow = ports.create<EditorialWorkflowApplicationPort>(
      "editorial-workflow",
    );
    const pipelineLease = ports.create<PipelineLeaseApplicationPort>(
      "pipeline-lease",
    );
    const reviewDelivery = ports.create<{
      execute(input: Record<string, unknown>): Promise<{ status: string }>;
    }>("telegram-review-delivery");
    const researchExecution = ports.create<{
      execute(request: never, signal?: AbortSignal): Promise<never>;
    }>("research-execution");


    // The migrated provider, not `createAiProvider` from src/ai-provider.js.
    //
    // Both built the same three adapters, but legacy's own fallback loop has
    // per-call retry and nothing across calls, while the typed composition adds
    // the per-provider circuit breaker. Pointing this runtime at legacy meant
    // the breaker was tested, shipped, and never executed -- measured on the
    // integration stage as 2,131 rate-limited attempts against 708 useful
    // calls, a ratio of exactly the 3-attempt retry budget firing on every
    // call with nothing bounding it.
    //
    // Late-bound because AI_PROVIDER is a container singleton and these
    // consumers take instances at register() time, the same reason the
    // persistence facade is late-bound. The attempt repository still matters:
    // without it every fallback, retry and throttle goes unrecorded.
    // Refuse at registration rather than letting the container fail later.
    //
    // `createFallbackAiProvider` raises this same message when it is built, so
    // the runtime would not start either way -- but that happens inside
    // NestFactory.createApplicationContext, after Telegram has been contacted
    // and the whole graph assembled. A misconfigured deployment should be told
    // before any of that, and the message should name the cause rather than
    // arrive wrapped in a DI failure.
    //
    // The same descriptors the module uses decide this, so there is one rule
    // for "configured", not two that can disagree.
    const configuredProviders = BUILTIN_PROVIDER_DESCRIPTORS.filter(
      (descriptor) => descriptor.configure(env) !== null,
    );
    if (configuredProviders.length === 0) {
      throw new Error(
        "No AI provider is configured; enable Exa or set an OpenAI/Gemini API key",
      );
    }

    const aiProviderPort = ports.create<FallbackAiProvider>("ai-provider");
    const aiProvider = aiProviderPort.port as unknown as Record<string, unknown> & {
      names: string[];
      generateStructured?: unknown;
    };
    // src/draft.js reads `model` only on the branch taken when no aiProvider
    // is supplied -- unreachable here, since createAiProvider throws when
    // nothing is configured. Legacy passes undefined all the way down, so
    // refusing to boot over an unresolvable model would reject a working
    // Exa-plus-provider deployment over a value nothing reads.
    const draftModel =
      getOpenAiConfig(env)?.model ?? getGeminiProviderConfig(env)?.model ?? "";
    const botApi = new TelegramBotApiGateway(
      token,
      identity.channelId,
      callTelegram as unknown as TelegramBotApiCall,
    );
    const outcomeRenderer = new TelegramBotApiOutcomeRenderer(
      token,
      callTelegram as unknown as TelegramBotApiCall,
    );
    // NotionAuditLogger.finish requires {status, result} while the port types
    // finalization as an open Record. Adapt at the seam rather than widening
    // the port: every caller in this file supplies both fields.
    const auditLogger = new NotionAuditLogger(getNotionAuditConfig(env));
    const notionAudit = new LegacyNotionAuditGateway({
      finish: (run, finalization) =>
        auditLogger.finish(run, finalization as never) as Promise<unknown>,
    });

    const legacyFeatureArgs = [
      token,
      identity.channelId,
      legacyPersistence.port as unknown as Record<string, unknown>,
      callTelegram as unknown as TelegramBotApiCall,
    ] as const;

    return {
      module: NewsAgentModule,
      imports: [
        DatabaseModule,
        PersistenceFacadeModule,
        TelegramPersistenceModule,

        AiProvidersModule.register({
          env,
          attemptRepository: legacyPersistence.port as never,
        }),
        // The news-job workflow needs the draft row itself, to approve a
        // review-status draft before publishing it on an automatic channel.
        // `claim_draft_for_publication_with_policy` accepts only `approved`,
        // so without this the automatic path could not publish at all.
        EditorialPersistenceModule,

        TypedResearchExecutionGatewayModule.register({
          aiProvider: aiProvider as never,
          // Null unless Exa is configured, and the gateway then extracts
          // exactly as it did before. Nothing here reaches for a provider that
          // the environment has not set up.
          articleContent: buildArticleContentPort(env),
        }),

        OperationsApplicationModule.register({ notionAudit }),

        EditorialApplicationModule.register({
          draft: new LegacyEditorialDraftGateway({
            aiProvider,
            model: draftModel,
            repository: legacyPersistence.port as never,
            editor: getNewsEditor(env),
            // Corroboration runs before drafting: the unverified caveat is
            // derived from the evidence, so this is the only point that can
            // affect it without editing the frozen legacy draft module.
            //
            // Both are constructed here rather than injected as ports because
            // the gateway is itself built here by hand -- the same seam the
            // other legacy gateways use.
            factPlan: new FactPlanService(),
            corroboration: new EvidenceCorroborationService(
              DEFAULT_CORROBORATION_OPTIONS,
            ),
          }),
          publication: new LegacyEditorialPublicationGateway({ token }),
          excludedTopics: new LegacyEditorialPublicationPolicyGateway({
            aiProvider: aiProvider as never,
          }),
        }),

        TelegramControlApplicationModule.register({
          authorization: botApi,
          audit: new LegacyTelegramControlAuditAdapter(),
          editorial: editorialWorkflow.port,
          reviewPresentation: botApi,
          settings: new TelegramLegacySettingsGateway(...legacyFeatureArgs),
          labs: new TelegramLegacyLabsGateway(...legacyFeatureArgs),
          stats: new TelegramLegacyStatsGateway(...legacyFeatureArgs),
          status: new TelegramLegacyStatusGateway(
            ...legacyFeatureArgs,
            aiProvider,
            // Read through the port at call time rather than here: `names` is a
            // property of the bound singleton, and this runs before the
            // container exists.
            () => aiProviderPort.port.names ?? [],
            appVersion,
          ),
        }),

        SchedulerApplicationModule.register({
          newsWorkflow: new TypedSchedulerNewsWorkflowAdapter(
            researchExecution.port as never,
            editorialWorkflow.port as never,
          ),
          editorial: editorialWorkflow.port,
          pipelineLease: pipelineLease.port,
          reviewDelivery: new TelegramSchedulerReviewDeliveryAdapter(reviewDelivery.port as never),
          audit: new LegacySchedulerAuditAdapter(
            // Same logger instance as the operations gateway above, so the two
            // audit paths cannot drift in configuration.
            auditLogger as never,
            legacyPersistence.port as never,
          ),
          notification: new TelegramSchedulerNotificationAdapter(
            token,
            callTelegram as unknown as never,
          ),
        }),
      ],
      providers: [
        {
          provide: RuntimeBinder,
          inject: [
            LEGACY_PERSISTENCE,
            EDITORIAL_WORKFLOW_APPLICATION,
            PIPELINE_LEASE_APPLICATION,
            TELEGRAM_REVIEW_DELIVERY,
            RESEARCH_EXECUTION_GATEWAY,
            AI_PROVIDER,
          ],
          useFactory: (
            persistence: LegacyPersistence,
            editorial: EditorialWorkflowApplicationPort,
            lease: PipelineLeaseApplicationPort,
            delivery: never,
            research: never,
            ai: FallbackAiProvider,
          ) =>
            new RuntimeBinder(() => {
              legacyPersistence.bind(persistence);
              aiProviderPort.bind(ai);
              editorialWorkflow.bind(editorial);
              pipelineLease.bind(lease);
              reviewDelivery.bind(delivery);
              researchExecution.bind(research);

              // Refuse to finish booting with a port left unbound. Without
              // this, dropping a bind above is silent: the container starts,
              // the workers start, and the first call through that port throws
              // deep inside a poll or a scheduled run. For the persistence port
              // it is worse than a late crash -- it is what the AI provider's
              // attempt recording is built with, so a missed bind would take
              // out usage accounting and fallback-rate alerting at the first
              // provider call.
              ports.assertAllBound();
            }),
        },
        {
          provide: TELEGRAM_POLLING_WORKER,
          inject: [TELEGRAM_CONTROL_APPLICATION, TELEGRAM_UPDATES_PERSISTENCE, PIPELINE_LEASE_APPLICATION],
          useFactory: (
            application: never,
            updates: TelegramUpdatesPersistence,
            leaseApplication: PipelineLeaseApplicationPort,
          ) =>
            new TelegramPollingWorker({
              token,
              callTelegram: callTelegram as never,
              ownerId: pollerOwnerId,
              transport: new TelegramControlTransportHandler(application, outcomeRenderer, identity),
              updates,
              leaseApplication,
            }),
        },
        {
          provide: NEWS_SCHEDULER_WORKER,
          inject: [SCHEDULER_APPLICATION],
          useFactory: (scheduler: SchedulerApplicationPort) =>
            new NewsSchedulerWorker({ scheduler }),
        },
        {
          provide: TELEGRAM_NEWS_JOB_WORKER,
          inject: [
            TELEGRAM_NEWS_JOBS_PERSISTENCE,
            TELEGRAM_CHECKPOINTS_PERSISTENCE,
            EDITORIAL_PERSISTENCE,
            EDITORIAL_WORKFLOW_APPLICATION,
            PIPELINE_LEASE_APPLICATION,
            RESEARCH_EXECUTION_GATEWAY,
            TELEGRAM_REVIEW_DELIVERY,
          ],
          useFactory: (
            jobs: TelegramNewsJobsPersistence,
            checkpoints: TelegramCheckpointsPersistence,
            editorialPersistence: EditorialPersistence,
            editorial: EditorialWorkflowApplicationPort,
            leases: PipelineLeaseApplicationPort,
            research: never,
            delivery: never,
          ) =>
            // Registered unconditionally, with no equivalent of legacy's
            // TELEGRAM_NEWS_JOB_MODE gate. On this runtime the gate would be a
            // trap rather than a switch: RunTelegramNewsUseCase has no inline
            // branch, so every `/news` enqueues a durable job. With no consumer
            // the command answers "Research queued", nothing ever runs it, and
            // the channel's next `/news` is suppressed as already-running --
            // which is exactly the state the live test found the runtime in.
            new TelegramNewsJobWorker({
              jobs,
              workflow: new TypedNewsJobWorkflowAdapter({
                research: research as never,
                editorial,
                editorialPersistence,
                checkpoints,
                pipelineLease: leases,
                // The same id the poller uses would let one worker renew the
                // other's lease; a per-worker id keeps the holder identifiable.
                ownerId: newsJobOwnerId,
              }),
              delivery: new TypedNewsJobDeliveryAdapter({
                checkpoints,
                reviewDelivery: delivery as never,
                adminMessages: new TelegramSchedulerNotificationAdapter(
                  token,
                  callTelegram as unknown as never,
                ),
              }),
              newClaimToken: () => randomUUID(),
              // Legacy reads these from the environment
              // (getTelegramNewsJobsConfig in src/telegram-news-jobs.js); this
              // runtime was taking the worker's own defaults and ignoring them,
              // so a deployment could not tune them at all.
              //
              // The stale window matters most. It is how long a claim held by a
              // container that died mid-research is honoured before another
              // worker may take the job -- 30 minutes by default, during which
              // every `/news` on that channel is suppressed as already-running.
              //
              // It must not be set below the pipeline lease's TTL (15 minutes).
              // The lease is what actually prevents two research passes; a
              // shorter stale window only makes the job reclaimable while its
              // own lease is still held, so every reclaim is refused as
              // "already running" and the queue churns rather than recovering.
              ...newsJobSettings,
            }),
        },
        {
          // Started last and therefore stopped first: it only reports ready
          // once the poller owns its lease and the scheduler is running, and
          // it marks itself stopping before either begins draining.
          provide: RUNTIME_HEALTH_WORKER,
          useFactory: () =>
            new RuntimeHealthWorker({
              runtimeId,
              botId: identity.botId,
              channelId: identity.channelId,
              pollerLeaseName: TELEGRAM_CONTROL_POLLER_LEASE_NAME,
              pollerLeaseOwnerId: pollerOwnerId,
              // Both are supplied by the entry point, which is what validated
              // the mode and owns the token list. Absence fails closed rather
              // than defaulting: a default here would be a constant claiming
              // something nothing checked, which is the tautology this field
              // exists to avoid. An empty worker set fails the probe's required
              // set, so a caller that did not say is reported unhealthy.
              updateMode: options.updateMode ?? "unknown",
              startedWorkers: options.startedWorkers ?? [],
              ...(options.healthFilePath ? { filePath: options.healthFilePath } : {}),
            }),
        },
      ],
      exports: [
        TELEGRAM_POLLING_WORKER,
        NEWS_SCHEDULER_WORKER,
        TELEGRAM_NEWS_JOB_WORKER,
        RUNTIME_HEALTH_WORKER,
      ],
    };
  }
}

/**
 * Fills every late-bound port during `onModuleInit`, which Nest runs while the
 * context is being created — strictly before `bootstrapRuntime` starts any
 * worker. Exists only for that side effect.
 */
@Injectable()
export class RuntimeBinder implements OnModuleInit {
  constructor(private readonly bindAll: () => void) {}

  onModuleInit(): void {
    this.bindAll();
  }
}
