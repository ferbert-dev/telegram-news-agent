import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// A real SIGTERM to a real process, against the compiled output.
//
// Every other signal test injects a fake RuntimeSignal, which proves the
// coordinator's logic but not that `createProcessSignalSource` reaches
// `process.on`, that the handler survives `tsc` emit, or that the process
// actually exits instead of hanging on a ref'd handle. Those are exactly the
// failures that only appear in a container, where the symptom is a deploy that
// sits out its 45-second grace period on every release.

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./fixtures/runtime-signal-child.mjs", import.meta.url))],
  { stdio: ["ignore", "pipe", "pipe"] },
);

// Whatever happens below, the child must not outlive this process. Without
// this a ready-path timeout leaves a node process holding a ref'd interval
// forever -- in CI for the job's lifetime, and locally they accumulate.
process.on("exit", () => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

const lines = [];
let stderr = "";
let buffered = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const ready = new Promise((resolve, reject) => {
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index !== -1) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      // Guarded: an unexpected stdout line would otherwise crash this handler
      // with a SyntaxError instead of failing an assertion you can read.
      if (line.trim().startsWith("{")) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          reject(new Error(`unparseable child output: ${line}`));
          return;
        }
      }
      if (line.includes('"ready"')) resolve();
      index = buffered.indexOf("\n");
    }
  });
  child.on("exit", (code) => reject(new Error(`child exited early with ${code}: ${stderr}`)));
  setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("child never reported ready"));
  }, 20_000).unref();
});

await ready;

const startedAt = Date.now();
assert.equal(child.kill("SIGTERM"), true);

const exitCode = await new Promise((resolve, reject) => {
  child.on("exit", (code, signal) => resolve(code ?? `signal:${signal}`));
  setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("the runtime did not exit after SIGTERM"));
  }, 20_000).unref();
});
const elapsed = Date.now() - startedAt;

// Exited on its own rather than being killed: a runtime that has to be SIGKILLed
// loses whatever its workers were draining.
assert.equal(exitCode, 0, `expected a clean exit, got ${exitCode}. stderr: ${stderr}`);

// Comfortably inside compose's stop_grace_period of 45s. The child uses a 5s
// coordinator grace, so anything approaching that means the drain is not
// completing on its own.
assert.ok(elapsed < 10_000, `shutdown took ${elapsed}ms`);

const events = lines.map((line) => line.event);
assert.deepEqual(
  events.filter((event) => event === "started").length,
  2,
  "both workers should have started",
);

const drained = lines.find((line) => line.event === "drained");
assert.ok(drained, `no drain record; saw ${JSON.stringify(events)}`);
// Reverse of start order. The poller must stop after the scheduler in the real
// runtime, and this is the mechanism that guarantees it.
assert.deepEqual(drained.order, ["second", "first"]);

// Both workers ran their stop() to completion. (That the context is not closed
// before they finish is asserted with fakes in checks/runtime/runtime-lifecycle.ts;
// this cannot distinguish that case, because the pending drain timer keeps the
// process alive either way.)
const stopped = lines.filter((line) => line.event === "stopped").map((line) => line.name);
assert.deepEqual(stopped.sort(), ["first", "second"]);

// A second signal escalates immediately instead of waiting out the drain.
//
// This is the only test anywhere that reaches the real
// createProcessSecondSignalEscalation body -- every other one injects a fake
// onSecondSignal, so `process.exit(1)` itself was covered by nothing. The
// failure it guards is an operator pressing Ctrl-C twice, or an orchestrator
// re-sending SIGTERM, on a runtime whose drain is wedged.
const second = spawn(
  process.execPath,
  [fileURLToPath(new URL("./fixtures/runtime-signal-child.mjs", import.meta.url))],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SLOW_DRAIN_MS: "30000" } },
);
process.on("exit", () => {
  if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
});

let secondBuffer = "";
second.stdout.setEncoding("utf8");
await new Promise((resolve, reject) => {
  second.stdout.on("data", (chunk) => {
    secondBuffer += chunk;
    if (secondBuffer.includes('"ready"')) resolve();
  });
  second.on("exit", (code) => reject(new Error(`second child exited early with ${code}`)));
  setTimeout(() => {
    second.kill("SIGKILL");
    reject(new Error("second child never reported ready"));
  }, 20_000).unref();
});

second.kill("SIGTERM");
// Long enough that the first signal's drain is genuinely still in flight.
await new Promise((resolve) => setTimeout(resolve, 250));
second.kill("SIGTERM");

const escalated = await new Promise((resolve, reject) => {
  second.on("exit", (code, signal) => resolve(code ?? `signal:${signal}`));
  setTimeout(() => {
    second.kill("SIGKILL");
    reject(new Error("a second signal did not escalate; the runtime sat out its drain"));
  }, 15_000).unref();
});
// Exit 1, not 0 and not a kill: escalation is a deliberate failed shutdown.
assert.equal(escalated, 1, `expected escalation to exit 1, got ${escalated}`);
