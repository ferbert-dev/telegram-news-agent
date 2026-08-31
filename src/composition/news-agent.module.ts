import "reflect-metadata";

import { Inject, Injectable, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";

import { callTelegram } from "../telegram.js";
import { getNewsEditor } from "../editor.js";
import { getOpenAiConfig } from "../openai-provider.js";
import { getGeminiProviderConfig } from "../gemini-provider.js";
import { NotionAuditLogger, getNotionAuditConfig } from "../notion-audit.js";
import { createAiProvider } from "../ai-provider.js";

import { DatabaseModule } from "../database/database.module.js";
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
import { TELEGRAM_UPDATES_PERSISTENCE } from "../telegram/telegram-persistence.tokens.js";
import type { TelegramUpdatesPersistence } from "../telegram/telegram-persistence.contracts.js";
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

import { RuntimeHealthWorker } from "../runtime/runtime-health.js";
import { PIPELINE_LEASES_REPOSITORY } from "../operations/operations.tokens.js";
import { randomUUID } from "node:crypto";

import { createLateBoundPort, LateBoundPortRegistry } from "./late-bound-port.js";

/** Worker tokens, in the coordinator's required start order. */
export const TELEGRAM_POLLING_WORKER = Symbol("TELEGRAM_POLLING_WORKER");
export const NEWS_SCHEDULER_WORKER = Symbol("NEWS_SCHEDULER_WORKER");
export const RUNTIME_HEALTH_WORKER = Symbol("RUNTIME_HEALTH_WORKER");

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
};

/**
 * The workers this module registers ahead of the health worker.
 *
 * Exported so the health CLI can require exactly this set rather than
 * hardcoding names: a runtime that came up without its scheduler polls fine and
 * silently runs nothing on a schedule, and start order cannot express that --
 * the health worker is last either way.
 */
export const RUNTIME_STARTED_WORKERS = ["telegram-polling", "news-scheduler"] as const;

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
    const { token, identity } = options;
    const appVersion = options.appVersion ?? env.APP_VERSION ?? "local";
    const runtimeId = options.runtimeId ?? randomUUID();
    // Generated here rather than left to the worker's own default, because the
    // readiness file must name the same owner id the lease row will carry --
    // that equality is what makes the health check verifiable rather than
    // self-asserted.
    const pollerOwnerId = randomUUID();

    // --- Late-bound ports -------------------------------------------------
    // Each of these is required by a `register()` call that runs before the
    // container exists, but is satisfied by a singleton that only exists
    // inside it. `RuntimeBinder.onModuleInit` fills them, which Nest runs
    // during context creation and therefore strictly before any worker starts.
    // Every port created against this registry is automatically covered by the
    // unbound check below -- there is no list to keep in step.
    const ports = new LateBoundPortRegistry();
    const legacyPersistence = createLateBoundPort<LegacyPersistence>("legacy-persistence", ports);
    const editorialWorkflow = createLateBoundPort<EditorialWorkflowApplicationPort>(
      "editorial-workflow",
      ports,
    );
    const pipelineLease = createLateBoundPort<PipelineLeaseApplicationPort>(
      "pipeline-lease",
      ports,
    );
    const reviewDelivery = createLateBoundPort<{
      execute(input: Record<string, unknown>): Promise<{ status: string }>;
    }>("telegram-review-delivery", ports);
    const researchExecution = createLateBoundPort<{
      execute(request: never, signal?: AbortSignal): Promise<never>;
    }>("research-execution", ports);


    // Eagerly constructible: these depend only on configuration, not on the
    // container. Everything that needs a container singleton goes through a
    // late-bound port instead (see below).
    // The attempt repository matters: without it every provider fallback,
    // retry and quota exhaustion goes unrecorded, so the usage dashboard and
    // any fallback-rate alerting show nothing. Legacy passes it
    // (src/telegram-bot.js: createAiProvider(env, { attemptRepository })), and
    // the late-bound facade is filled long before the first AI call.
    const aiProvider = createAiProvider(env, {
      attemptRepository: legacyPersistence.port as never,
    }) as Record<string, unknown> & { names: string[]; generateStructured?: unknown };
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

        TypedResearchExecutionGatewayModule.register({
          aiProvider: aiProvider as never,
        }),

        OperationsApplicationModule.register({ notionAudit }),

        EditorialApplicationModule.register({
          draft: new LegacyEditorialDraftGateway({
            aiProvider,
            model: draftModel,
            repository: legacyPersistence.port as never,
            editor: getNewsEditor(env),
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
            aiProvider.names ?? [],
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
        // Exposed so a check can count what the root actually created; a sixth
        // port added without the registry would otherwise lose its coverage
        // quietly.
        { provide: LateBoundPortRegistry, useValue: ports },
        {
          provide: RuntimeBinder,
          inject: [
            LEGACY_PERSISTENCE,
            EDITORIAL_WORKFLOW_APPLICATION,
            PIPELINE_LEASE_APPLICATION,
            TELEGRAM_REVIEW_DELIVERY,
            RESEARCH_EXECUTION_GATEWAY,
          ],
          useFactory: (
            persistence: LegacyPersistence,
            editorial: EditorialWorkflowApplicationPort,
            lease: PipelineLeaseApplicationPort,
            delivery: never,
            research: never,
          ) =>
            new RuntimeBinder(() => {
              legacyPersistence.bind(persistence);
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
              // Not a constant dressed as data: getPollingConfig throws unless
              // this is "polling", and runtime-entry calls it before the
              // container is built, so recording it states what was validated.
              updateMode: env.TELEGRAM_UPDATE_MODE?.trim().toLowerCase() ?? "polling",
              startedWorkers: RUNTIME_STARTED_WORKERS,
              ...(options.healthFilePath ? { filePath: options.healthFilePath } : {}),
            }),
        },
      ],
      exports: [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER, RUNTIME_HEALTH_WORKER],
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
