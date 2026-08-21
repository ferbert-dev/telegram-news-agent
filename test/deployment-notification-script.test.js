import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("deployment notification script suppresses the same immutable image", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "deploy-notify-"));
  const script = path.join(fixture, "notify-deployment.sh");
  const docker = path.join(fixture, "docker");
  const calls = path.join(fixture, "docker.calls");
  const state = path.join(fixture, "notification.state");
  cpSync("ops/notify-deployment.sh", script);
  chmodSync(script, 0o755);
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
printf 'call\\n' >> "$MOCK_DOCKER_CALLS"
printf '{"event":"deployment_notification","sent":1}\\n'
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${fixture}:${process.env.PATH}`,
    MOCK_DOCKER_CALLS: calls,
    DEPLOYMENT_NOTIFICATION_STATE_FILE: state,
  };
  const first = spawnSync(script, ["bot-id", "image:sha"], {
    cwd: fixture,
    env,
    encoding: "utf8",
  });
  const second = spawnSync(script, ["bot-id", "image:sha"], {
    cwd: fixture,
    env,
    encoding: "utf8",
  });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(readFileSync(calls, "utf8"), "call\n");
  assert.equal(readFileSync(state, "utf8"), "image:sha\n");
  assert.match(second.stdout, /already recorded/);
});
