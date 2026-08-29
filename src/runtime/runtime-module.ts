import { Module, type DynamicModule, type Provider } from "@nestjs/common";

import {
  RuntimeCoordinator,
  type RuntimeSignal,
  type RuntimeWorker,
} from "./runtime-coordinator.js";

export const RUNTIME_WORKERS = Symbol("RUNTIME_WORKERS");
export const RUNTIME_SIGNAL_SOURCE = Symbol("RUNTIME_SIGNAL_SOURCE");
export const RUNTIME_STOP_GRACE_PERIOD_MS = Symbol(
  "RUNTIME_STOP_GRACE_PERIOD_MS",
);
export const RUNTIME_SECOND_SIGNAL_ESCALATION = Symbol(
  "RUNTIME_SECOND_SIGNAL_ESCALATION",
);

export const DEFAULT_STOP_GRACE_PERIOD_MS = 40_000;
export const MAX_STOP_GRACE_PERIOD_MS = 45_000;
export const MIN_STOP_GRACE_PERIOD_MS = 1;

export function createProcessSecondSignalEscalation(): (
  signalName: string,
) => Promise<void> {
  return async (_signalName: string) => {
    process.exit(1);
  };
}

export function createProcessSignalSource(): RuntimeSignal {
  return {
    on: (signal, handler) => process.on(signal, handler),
    off: (signal, handler) => process.off(signal, handler),
  };
}

export type RuntimeWorkerToken = symbol | string | (new (...args: never[]) => RuntimeWorker);

export type RuntimeModuleOptions = {
  /**
   * Pre-constructed workers. Fine for tests and for workers with no container
   * dependencies, but a real worker needs application ports that only exist
   * once their modules are instantiated — use `workerTokens` for those.
   */
  workers?: readonly RuntimeWorker[];
  /**
   * Workers resolved from the DI container, in start order.
   *
   * This is what makes a real composition root possible. Workers need
   * application ports (SchedulerApplicationPort, TelegramControlTransport)
   * that are Nest-managed singletons inside other modules, but
   * `bootstrapRuntime` has to hand `RuntimeCoordinator` its worker list at
   * module-definition time — before any context exists. Resolving by token
   * defers construction into the container, which dissolves that ordering
   * problem without changing any application module's public `register()`
   * shape.
   *
   * Pass `imports` alongside these so the tokens are actually visible here.
   *
   * A worker resolved this way becomes a container-managed provider, so
   * `app.close()` will reach its Nest lifecycle hooks *after* the coordinator
   * has already called `stop()`. Runtime workers must therefore NOT implement
   * `OnModuleDestroy`/`OnApplicationShutdown` — the coordinator owns worker
   * lifecycle, and adding a hook that calls `stop()` again is only harmless
   * while every `stop()` happens to be idempotent.
   */
  workerTokens?: readonly RuntimeWorkerToken[];
  /** Modules whose exports supply `workerTokens`. */
  imports?: RuntimeModuleImport[];
  signalSource?: RuntimeSignal;
  stopGracePeriodMs?: number;
  onSecondSignal?: (signalName: string) => Promise<void> | void;
};

type RuntimeModuleImport = NonNullable<DynamicModule["imports"]>[number];

@Module({})
export class RuntimeModule {
  static register({
    workers,
    workerTokens,
    imports,
    signalSource,
    stopGracePeriodMs = DEFAULT_STOP_GRACE_PERIOD_MS,
    onSecondSignal = createProcessSecondSignalEscalation(),
  }: RuntimeModuleOptions): DynamicModule {
    // Exactly one source of workers. Accepting both would leave the start
    // order ambiguous, and accepting neither would silently start nothing.
    const hasInstances = workers !== undefined;
    const hasTokens = workerTokens !== undefined;
    if (hasInstances === hasTokens) {
      throw new Error(
        "RuntimeModule.register requires exactly one of workers or workerTokens",
      );
    }
    // An empty list is the same silent-nothing outcome as omitting it: the
    // coordinator reaches "running" with no workers, the process looks
    // healthy, and it does nothing forever. Easy to hit with a token list
    // built by a filter or a conditional.
    if (hasTokens && workerTokens.length === 0) {
      throw new Error("RuntimeModule.register requires at least one worker token");
    }
    if (!Number.isInteger(stopGracePeriodMs)) {
      throw new Error("stopGracePeriodMs must be an integer");
    }
    if (stopGracePeriodMs <= 0 || stopGracePeriodMs >= MAX_STOP_GRACE_PERIOD_MS) {
      throw new Error(
        `stopGracePeriodMs must be > ${MIN_STOP_GRACE_PERIOD_MS - 1} and < ${MAX_STOP_GRACE_PERIOD_MS}`,
      );
    }

    // Resolved workers keep the declared order: Nest passes injected
    // dependencies to useFactory positionally, so `workerTokens` order is the
    // coordinator's start order — which the poller-before-scheduler readiness
    // contract depends on.
    const workersProvider: Provider = hasTokens
      ? {
          provide: RUNTIME_WORKERS,
          inject: [...workerTokens],
          useFactory: (...resolved: RuntimeWorker[]) => resolved,
        }
      : { provide: RUNTIME_WORKERS, useValue: workers };

    return {
      module: RuntimeModule,
      ...(imports ? { imports } : {}),
      providers: [
        workersProvider,
        {
          provide: RUNTIME_SIGNAL_SOURCE,
          useValue: signalSource ?? createProcessSignalSource(),
        },
        {
          provide: RUNTIME_STOP_GRACE_PERIOD_MS,
          useValue: stopGracePeriodMs,
        },
        {
          provide: RUNTIME_SECOND_SIGNAL_ESCALATION,
          useValue: onSecondSignal,
        },
        {
          provide: RuntimeCoordinator,
          useFactory: (
            coordinatorWorkers: RuntimeWorker[],
            source: RuntimeSignal,
            stopGracePeriod: number,
            onSecond: (signalName: string) => Promise<void> | void,
          ): RuntimeCoordinator =>
            new RuntimeCoordinator({
              workers: coordinatorWorkers,
              signalSource: source,
              stopGracePeriodMs: stopGracePeriod,
              onSecondSignal: onSecond,
            }),
          inject: [
            RUNTIME_WORKERS,
            RUNTIME_SIGNAL_SOURCE,
            RUNTIME_STOP_GRACE_PERIOD_MS,
            RUNTIME_SECOND_SIGNAL_ESCALATION,
          ],
        },
      ],
      exports: [RuntimeCoordinator],
    };
  }
}
