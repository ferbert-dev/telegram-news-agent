import assert from "node:assert/strict";
import { bootstrapRuntime } from "../dist/runtime/runtime-bootstrap.js";

class CloseAware {
  called = 0;

  onModuleDestroy() {
    this.called += 1;
  }
}

const RuntimeRootModule = {
  module: class RuntimeRootModule {},
  providers: [CloseAware],
};

const events = [];
const stopSequence = [];
let escalationCalls = 0;

const signalSource = {
  on: () => {},
  off: () => {},
};

const workers = [
  {
    name: "runtime-emit",
    start: async () => {
      events.push("worker.start");
    },
    stop: async () => {
      stopSequence.push("worker.stop");
    },
  },
];

const application = await bootstrapRuntime({
  applicationModule: RuntimeRootModule,
  workers,
  stopGracePeriodMs: 15_000,
  signalSource,
  onSecondSignal: async () => {
    escalationCalls += 1;
  },
});

const closeAware = application.application.get(CloseAware);

assert.equal(typeof bootstrapRuntime, "function");
assert.equal(events[0], "worker.start");
assert.equal(typeof closeAware.listen, "undefined");
assert.equal(closeAware.called, 0);

await application.stop();
assert.equal(closeAware.called, 1);
assert.equal(stopSequence[0], "worker.stop");
assert.equal(await application.stop(), undefined);
assert.equal(await application.stop(), undefined);
assert.equal(typeof application.stop, "function");
assert.equal(application.coordinator.lifecycleState, "stopped");
assert.equal(closeAware.called, 1);
assert.equal(escalationCalls, 0);
