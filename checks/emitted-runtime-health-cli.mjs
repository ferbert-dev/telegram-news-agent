import assert from "node:assert/strict";

// The health CLI is the one piece meant to run as its own process against the
// compiled output, so a broken emit here would only ever show up as a failing
// container health check in production.
const cli = await import("../dist/composition/health-cli.js");
const check = await import("../dist/runtime/runtime-health-check.js");
const health = await import("../dist/runtime/runtime-health.js");

assert.equal(typeof cli.runHealthCli, "function");
assert.equal(typeof check.checkRuntimeHealth, "function");
assert.equal(typeof health.RuntimeHealthWorker, "function");
assert.equal(health.RUNTIME_HEALTH_SCHEMA_VERSION, 2);

// No readiness file, no database contact: the check must decide "unhealthy"
// rather than throw, because a probe that throws is indistinguishable from a
// broken probe.
const result = await check.checkRuntimeHealth({
  filePath: "/nonexistent/telegram-news-agent-runtime-health.json",
  leases: {
    async readPipelineLease() {
      throw new Error("the check must not reach the database without a file");
    },
  },
});
assert.equal(result.healthy, false);
assert.match(result.reason, /no readiness file/);
