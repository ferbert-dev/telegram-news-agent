import assert from "node:assert/strict";
import test from "node:test";
import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { createLateBoundPort } from "../../src/composition/late-bound-port.js";

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
