import "reflect-metadata";

import { type DynamicModule, type INestApplicationContext, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { RuntimeModule } from "./runtime-module.js";

import { RuntimeCoordinator, type RuntimeSignal, type RuntimeWorker } from "./runtime-coordinator.js";

export type RuntimeBootstrapOptions = {
  applicationModule: Type | DynamicModule;
  workers: readonly RuntimeWorker[];
  signalSource?: RuntimeSignal;
  stopGracePeriodMs?: number;
  onSecondSignal?: (signalName: string) => Promise<void> | void;
};

export type RuntimeBootstrapRun = {
  application: { close(): Promise<void> };
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
    workers: options.workers,
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
