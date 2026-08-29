import assert from "node:assert/strict";
import test from "node:test";
import { Inject, Injectable, Module } from "@nestjs/common";

import { bootstrapRuntime } from "../../src/runtime/runtime-bootstrap.js";
import { RuntimeModule } from "../../src/runtime/runtime-module.js";
import type { RuntimeWorker } from "../../src/runtime/runtime-coordinator.js";

const silentSignals = { on() {}, off() {} };

/**
 * Stands in for a real application port: a Nest-managed singleton living
 * inside another module, which a worker cannot obtain before the container
 * exists. This is the exact dependency shape that made the composition root
 * circular under the old instances-only API.
 */
const APPLICATION_PORT = Symbol("APPLICATION_PORT");

type ApplicationPort = { run(): string };

@Injectable()
class PortDependentWorker implements RuntimeWorker {
  readonly name = "port-dependent";
  started: string | null = null;

  constructor(@Inject(APPLICATION_PORT) private readonly port: ApplicationPort) {}

  async start(): Promise<void> {
    this.started = this.port.run();
  }

  async stop(): Promise<void> {}
}

@Injectable()
class SecondWorker implements RuntimeWorker {
  readonly name = "second";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

@Module({
  providers: [
    { provide: APPLICATION_PORT, useValue: { run: () => "resolved-from-container" } },
    PortDependentWorker,
    SecondWorker,
  ],
  exports: [PortDependentWorker, SecondWorker],
})
class FakeApplicationModule {}

test("register rejects supplying both workers and workerTokens, or neither", () => {
  assert.throws(
    () => RuntimeModule.register({ workers: [], workerTokens: [] }),
    /exactly one of workers or workerTokens/,
  );
  assert.throws(
    () => RuntimeModule.register({}),
    /exactly one of workers or workerTokens/,
  );
});

test("workerTokens resolve workers whose dependencies only exist inside the container", async () => {
  // The point of the whole change: this worker needs an application port that
  // is a Nest singleton in another module. Under the instances-only API the
  // caller would have had to construct it before the context existed, which is
  // impossible — that was the composition-root blocker.
  const run = await bootstrapRuntime({
    applicationModule: FakeApplicationModule,
    workerTokens: [PortDependentWorker],
    signalSource: silentSignals,
    stopGracePeriodMs: 5_000,
  });

  try {
    const worker = run.application.get(PortDependentWorker) as PortDependentWorker;
    assert.equal(worker.started, "resolved-from-container");
  } finally {
    await run.stop();
  }
});

test("workerTokens preserve declared start order, which the readiness contract depends on", async () => {
  // The poller must reach readiness before the scheduler starts, so the order
  // of workerTokens has to survive DI resolution rather than being incidental.
  const order: string[] = [];

  @Injectable()
  class First implements RuntimeWorker {
    readonly name = "first";
    async start(): Promise<void> { order.push("first"); }
    async stop(): Promise<void> {}
  }

  @Injectable()
  class Second implements RuntimeWorker {
    readonly name = "second";
    async start(): Promise<void> { order.push("second"); }
    async stop(): Promise<void> {}
  }

  @Module({ providers: [First, Second], exports: [First, Second] })
  class OrderedModule {}

  const run = await bootstrapRuntime({
    applicationModule: OrderedModule,
    workerTokens: [First, Second],
    signalSource: silentSignals,
    stopGracePeriodMs: 5_000,
  });
  await run.stop();

  assert.deepEqual(order, ["first", "second"]);

  order.length = 0;
  const reversed = await bootstrapRuntime({
    applicationModule: OrderedModule,
    workerTokens: [Second, First],
    signalSource: silentSignals,
    stopGracePeriodMs: 5_000,
  });
  await reversed.stop();

  assert.deepEqual(order, ["second", "first"]);
});

test("pre-constructed workers still work unchanged, so existing callers are unaffected", async () => {
  const events: string[] = [];
  const worker: RuntimeWorker = {
    name: "instance",
    async start() { events.push("start"); },
    async stop() { events.push("stop"); },
  };

  @Module({})
  class EmptyModule {}

  const run = await bootstrapRuntime({
    applicationModule: EmptyModule,
    workers: [worker],
    signalSource: silentSignals,
    stopGracePeriodMs: 5_000,
  });
  await run.stop();

  assert.deepEqual(events, ["start", "stop"]);
});

test("token-resolved workers are drained by the coordinator on stop", async () => {
  const stopped: string[] = [];

  @Injectable()
  class Drainable implements RuntimeWorker {
    readonly name = "drainable";
    async start(): Promise<void> {}
    async stop(): Promise<void> { stopped.push("drainable"); }
  }

  @Module({ providers: [Drainable], exports: [Drainable] })
  class DrainModule {}

  const run = await bootstrapRuntime({
    applicationModule: DrainModule,
    workerTokens: [Drainable],
    signalSource: silentSignals,
    stopGracePeriodMs: 5_000,
  });
  await run.stop();

  assert.deepEqual(stopped, ["drainable"]);
  assert.equal(run.coordinator.lifecycleState, "stopped");
});
