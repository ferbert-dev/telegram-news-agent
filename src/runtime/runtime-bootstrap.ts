import "reflect-metadata";

import { type DynamicModule, type INestApplicationContext, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RuntimeModule, type RuntimeWorkerToken } from "./runtime-module.js";

import { RuntimeCoordinator, type RuntimeSignal, type RuntimeWorker } from "./runtime-coordinator.js";

export type RuntimeBootstrapOptions = {
  applicationModule: Type | DynamicModule;
  /** Pre-constructed workers. Mutually exclusive with `workerTokens`. */
  workers?: readonly RuntimeWorker[];
  /**
   * Workers resolved from the application module's own exports, in start
   * order. This is the path a real composition root takes: workers depend on
   * application ports that only exist inside the container, so they cannot be
   * constructed before it.
   */
  workerTokens?: readonly RuntimeWorkerToken[];
  signalSource?: RuntimeSignal;
  stopGracePeriodMs?: number;
  onSecondSignal?: (signalName: string) => Promise<void> | void;
};

export type RuntimeBootstrapRun = {
  /**
   * The standalone context. Typed as the real INestApplicationContext rather
   * than just `{ close() }` so callers can resolve providers from it — a
   * composition root needs that to reach the coordinator's own workers, and
   * the narrower type was hiding a capability the value always had.
   */
  application: INestApplicationContext;
  coordinator: RuntimeCoordinator;
  stop: () => Promise<void>;
};

export function createRuntimeApplicationContext(
  module: Type | DynamicModule,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, { logger: false });
}

export async function bootstrapRuntime(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapRun> {
  const runtimeModule = RuntimeModule.register({
    ...(options.workerTokens
      ? {
          workerTokens: options.workerTokens,
          // RuntimeModule resolves the tokens itself, so it must import the
          // module that exports them rather than relying on the shared root.
          imports: [options.applicationModule],
        }
      : { workers: options.workers }),
    signalSource: options.signalSource,
    stopGracePeriodMs: options.stopGracePeriodMs,
    onSecondSignal: options.onSecondSignal,
  });
  const resolvedApplication = await createRuntimeApplicationContext({
    module: class RuntimeBootstrapModule {},
    imports: [options.applicationModule, runtimeModule],
  });
  const resolvedCoordinator = resolvedApplication.get(RuntimeCoordinator);
  resolvedCoordinator.bindApplicationClose(() => resolvedApplication.close());
  await resolvedCoordinator.start();

  return {
    application: resolvedApplication,
    coordinator: resolvedCoordinator,
    stop: () => resolvedCoordinator.close(),
  };
}
