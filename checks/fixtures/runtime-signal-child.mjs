// Child process for checks/emitted-runtime-signals.mjs.
//
// Runs the compiled runtime with two fake workers so a REAL SIGTERM can be
// delivered to a real process. Everything else about signal handling is tested
// against an injected fake signal source, which cannot prove that
// createProcessSignalSource actually reaches process.on, that the handler
// survives into the emitted build, or that the process exits rather than
// hanging with a ref'd handle.
import { bootstrapRuntime } from "../../dist/runtime/runtime-bootstrap.js";

const drained = [];

/** Records its own lifecycle and holds a ref'd handle while running. */
function fakeWorker(name, drainMs) {
  let hold = null;
  return {
    name,
    async start() {
      process.stdout.write(`${JSON.stringify({ event: "started", name })}\n`);
      // Ref'd on purpose: without it the process could exit for reasons that
      // have nothing to do with the shutdown path, and the test would pass
      // while proving nothing.
      hold = setInterval(() => {}, 60_000);
    },
    async stop() {
      drained.push(name);
      if (drainMs) await new Promise((resolve) => setTimeout(resolve, drainMs));
      if (hold !== null) {
        clearInterval(hold);
        hold = null;
      }
      process.stdout.write(`${JSON.stringify({ event: "stopped", name })}\n`);
    },
  };
}

// A DynamicModule literal rather than a decorated class: decorators are not
// valid in a plain .mjs, and this file has to be plain JavaScript because it
// runs the compiled output the way production would.
const run = await bootstrapRuntime({
  applicationModule: { module: class EmptyApplicationModule {} },
  workers: [fakeWorker("first", 0), fakeWorker("second", 50)],
  stopGracePeriodMs: 5_000,
});

process.stdout.write(`${JSON.stringify({ event: "ready" })}\n`);

// The coordinator owns the signal handlers; this only observes the outcome.
run.coordinator.stopSignal.addEventListener("abort", () => {
  void run.stop().then(() => {
    process.stdout.write(`${JSON.stringify({ event: "drained", order: drained })}\n`);
  });
});
