import assert from "node:assert/strict";
import test from "node:test";
import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { LateBoundPortRegistry } from "../../src/composition/late-bound-port.js";

// Creation lives on the registry, so there is no un-registered constructor to
// forget. These tests go through it like the composition root does.
const createLateBoundPort = <T extends object>(name: string) =>
  new LateBoundPortRegistry().create<T>(name);

type Port = { work(value: string): string; label: string };

test("a bound port forwards calls to the real target with correct `this`", () => {
  const late = createLateBoundPort<Port>("example");
  const real = {
    label: "real",
    work(value: string) {
      // Reads `this` to prove the forwarded function is bound to the target,
      // not invoked bare off the proxy.
      return `${this.label}:${value}`;
    },
  };

  late.bind(real);

  assert.equal(late.isBound, true);
  assert.equal(late.port.work("x"), "real:x");
  assert.equal(late.port.label, "real");
});

test("using a port before it is bound throws naming the port, not undefined", () => {
  const late = createLateBoundPort<Port>("scheduler-editorial");

  assert.equal(late.isBound, false);
  assert.throws(
    () => late.port.work("x"),
    /Late-bound port "scheduler-editorial" was used before the container finished wiring it/,
  );
});

test("binding twice throws rather than silently swapping the target", () => {
  const late = createLateBoundPort<Port>("example");
  late.bind({ label: "first", work: () => "first" });

  assert.throws(() => late.bind({ label: "second", work: () => "second" }), /already bound/);
  assert.equal(late.port.work("x"), "first");
});

test("feature detection with `in` works unbound instead of throwing", () => {
  // Some consumers check `"method" in port` before calling. Throwing there
  // would report a wrong shape rather than a wiring error.
  const late = createLateBoundPort<Port>("example");
  assert.equal("work" in late.port, false);

  late.bind({ label: "real", work: () => "ok" });
  assert.equal("work" in late.port, true);
  assert.equal("missing" in late.port, false);
});

test("lifecycle hooks are hidden in both states, so app.close() cannot reach the target twice", async () => {
  // Each port is a useValue provider, and editorialWorkflow.port is registered
  // under two tokens. If the proxy forwarded onModuleDestroy, closing the
  // context would invoke the real singleton's hook once per proxy on top of
  // its own -- three times for that one.
  const hooks = ["onModuleInit", "onModuleDestroy", "onApplicationBootstrap", "beforeApplicationShutdown", "onApplicationShutdown"] as const;
  const late = createLateBoundPort<Record<string, unknown>>("hooks");

  for (const hook of hooks) {
    assert.equal(late.port[hook], undefined, `${hook} must be hidden while unbound`);
    assert.equal(hook in late.port, false);
  }

  let destroyed = 0;
  late.bind({ onModuleDestroy: () => { destroyed += 1; }, work: () => "ok" });

  for (const hook of hooks) {
    assert.equal(late.port[hook], undefined, `${hook} must stay hidden once bound`);
    assert.equal(hook in late.port, false);
  }
  assert.equal(destroyed, 0);
  // Real methods still forward.
  assert.equal((late.port.work as () => string)(), "ok");
});

test("onModuleInit binds before anything can use the port, inside a real container", async () => {
  // This is the ordering the whole approach rests on: NestFactory runs every
  // onModuleInit during context creation, and bootstrapRuntime awaits that
  // strictly before starting any worker.
  const REAL_PORT = Symbol("REAL_PORT");
  const late = createLateBoundPort<Port>("container-example");
  const observed: string[] = [];

  @Injectable()
  class Binder implements OnModuleInit {
    constructor(@Inject(REAL_PORT) private readonly real: Port) {}
    onModuleInit(): void {
      late.bind(this.real);
    }
  }

  /** Stands in for a worker: constructed with the port, uses it only later. */
  @Injectable()
  class Consumer {
    constructor() {}
    run(): string {
      return late.port.work("call");
    }
  }

  @Module({
    providers: [
      { provide: REAL_PORT, useValue: { label: "container", work: (v: string) => `container:${v}` } },
      Binder,
      Consumer,
    ],
    exports: [Consumer],
  })
  class ExampleModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ExampleModule] }).compile();
  // .compile() alone does not run lifecycle hooks; .init() does, matching what
  // NestFactory.createApplicationContext performs internally.
  await moduleRef.init();

  try {
    assert.equal(late.isBound, true, "onModuleInit must have run during init");
    observed.push(moduleRef.get(Consumer).run());
    assert.deepEqual(observed, ["container:call"]);
  } finally {
    await moduleRef.close();
  }
});
