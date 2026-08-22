import { Module, type DynamicModule } from "@nestjs/common";

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

export type RuntimeModuleOptions = {
  workers: readonly RuntimeWorker[];
  signalSource?: RuntimeSignal;
  stopGracePeriodMs?: number;
  onSecondSignal?: (signalName: string) => Promise<void> | void;
};

@Module({})
export class RuntimeModule {
  static register({
    workers,
    signalSource,
    stopGracePeriodMs = DEFAULT_STOP_GRACE_PERIOD_MS,
    onSecondSignal = createProcessSecondSignalEscalation(),
  }: RuntimeModuleOptions): DynamicModule {
    if (!Number.isInteger(stopGracePeriodMs)) {
      throw new Error("stopGracePeriodMs must be an integer");
    }
    if (stopGracePeriodMs <= 0 || stopGracePeriodMs >= MAX_STOP_GRACE_PERIOD_MS) {
      throw new Error(
        `stopGracePeriodMs must be > ${MIN_STOP_GRACE_PERIOD_MS - 1} and < ${MAX_STOP_GRACE_PERIOD_MS}`,
      );
    }

    return {
      module: RuntimeModule,
      providers: [
        { provide: RUNTIME_WORKERS, useValue: workers },
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
