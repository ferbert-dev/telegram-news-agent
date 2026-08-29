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
  return NestFactory.createApplicationContext(module, {
    logger: false,
    // Without this, Nest's default abortOnError catches a container wiring
    // failure inside its own ExceptionsZone, logs it to the disabled logger,
    // and terminates the process itself — a silent crash loop with no stdout,
    // no stderr, and no chance for our caller's try/catch to run. (Spelled
    // out rather than named, because the architecture guard reserves that
    // exact call for the escalation boundary in runtime-module.ts.)
    // Resolution failures only became possible once workers could be resolved
    // by token (an instance cannot fail to resolve), so this matters now in a
    // way it did not before. Surfacing a catchable throw lets the caller log
    // it and lets a health-gated rollback act on something.
    abortOnError: false,
  });
}

export async function bootstrapRuntime(
  options: RuntimeBootstrapOptions,
): Promise<RuntimeBootstrapRun> {
  // Validate here as well as in register(). The spread below forwards only
  // one of the two, so passing both would otherwise silently drop `workers`
  // and start a partial worker set with no error at all — exactly the failure
  // a half-finished cutover would produce.
  if ((options.workers !== undefined) === (options.workerTokens !== undefined)) {
    throw new Error(
      "bootstrapRuntime requires exactly one of workers or workerTokens",
    );
  }

  const runtimeModule = RuntimeModule.register({
    ...(options.workerTokens
      ? {
          workerTokens: options.workerTokens,
          // RuntimeModule resolves the tokens itself, so it must import the
          // module that exports them rather than relying on the shared root.
          // Passing the SAME reference Nest already keyed for the root import
          // is load-bearing: Nest's default module-key factory keys on object
          // reference, so this compiles to one module instance, not two. A
          // re-wrap here would duplicate DatabaseModule and give the process
          // two pg pools and two lease owners.
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
