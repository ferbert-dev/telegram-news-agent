import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function legacyEnvironment(appPassword) {
  return [
    "POSTGRES_PASSWORD=postgres-secret",
    `POSTGRES_APP_PASSWORD=${appPassword}`,
    "TELEGRAM_BOT_TOKEN=telegram-secret",
    "TELEGRAM_CHANNEL_ID=placeholder",
    "TELEGRAM_UPDATE_MODE=polling",
    "AI_PROVIDER_ORDER=exa,openai,gemini",
    "EXA_ENABLED=true",
    "OPENAI_API_KEY=openai-secret",
    "EXA_API_KEY=exa-secret",
    "GEMINI_API_KEY=placeholder",
    "NOTION_API_KEY=placeholder",
    "NOTION_AGENT_RUNS_DATA_SOURCE_ID=placeholder",
    "NOTION_PIPELINE_AGENT_PAGE_ID=placeholder",
    "",
  ].join("\n");
}

function completeEnvironment(appPassword) {
  return [
    "POSTGRES_PASSWORD=postgres-secret",
    `POSTGRES_APP_PASSWORD=${appPassword}`,
    "POSTGRES_SSH_TUNNEL_PORT=55432",
    "TELEGRAM_BOT_TOKEN=telegram-secret",
    "TELEGRAM_CHANNEL_ID=@channel",
    "TELEGRAM_UPDATE_MODE=polling",
    "TELEGRAM_POLLING_MIGRATE_WEBHOOK=false",
    "TELEGRAM_NEWS_JOB_MODE=off",
    "APPROVAL_POLICY=manual",
    "AI_PROVIDER_ORDER=exa,openai,gemini",
    "EXA_ENABLED=true",
    "EXA_SEARCH_TYPE=auto",
    "EXA_MODEL=",
    "EXA_DAILY_SEARCH_CAP=20",
    "EXA_MAX_RESULTS=8",
    "OPENAI_API_KEY=openai-secret",
    "OPENAI_MODEL=gpt-5.4-2026-03-05",
    "OPENAI_REASONING_EFFORT=medium",
    "EXA_API_KEY=exa-secret",
    "GEMINI_API_KEY=gemini-secret",
    "GEMINI_MODEL=gemini-2.5-flash",
    "NOTION_API_KEY=notion-secret",
    "NOTION_AGENT_RUNS_DATA_SOURCE_ID=runs-id",
    "NOTION_PIPELINE_AGENT_PAGE_ID=agent-id",
    "NOTION_PIPELINE_TICKET_PAGE_ID=",
    "",
  ].join("\n");
}

function runDeployment({
  active,
  incoming,
  rollback,
  failRollbackInstall = false,
  botRunning = false,
  runtimePlaceholder = false,
  botHealth = "healthy",
  healthAfterStarting = null,
  startingChecks = 0,
  healthTimeoutSeconds = 5,
  notificationFails = false,
}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "deploy-rollback-"));
  const ops = path.join(fixture, "ops");
  const bin = path.join(fixture, "bin");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin, { recursive: true });

  cpSync("ops/deploy.sh", path.join(ops, "deploy.sh"));
  // deploy.sh sources this. Staging it here is not incidental: this harness is
  // a miniature of the deployment bundle, which also names every file
  // explicitly, and it caught the extraction of the gate the moment it landed.
  mkdirSync(path.join(ops, "lib"), { recursive: true });
  cpSync("ops/lib/deploy-gate.sh", path.join(ops, "lib", "deploy-gate.sh"));
  cpSync("ops/validate-production-env.sh", path.join(ops, "validate-production-env.sh"));
  cpSync("ops/verify-production-runtime.sh", path.join(ops, "verify-production-runtime.sh"));
  const notificationLog = path.join(fixture, "notification.log");
  writeFileSync(
    path.join(ops, "notify-deployment.sh"),
    `#!/usr/bin/env bash
printf '%s|%s\n' "$1" "$2" >> "$MOCK_NOTIFICATION_LOG"
exit "${notificationFails ? 88 : 0}"
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(fixture, ".env.production"), active, { mode: 0o600 });
  writeFileSync(path.join(fixture, ".env.production.incoming"), incoming, { mode: 0o600 });
  if (rollback !== undefined) {
    writeFileSync(path.join(fixture, ".env.production.rollback"), rollback, { mode: 0o600 });
  }

  const dockerLog = path.join(fixture, "docker.log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\\n' "\${APP_IMAGE:-}" "$*" >> "$MOCK_DOCKER_LOG"
printf 'APP_VERSION=%s\\n' "\${APP_VERSION:-}" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == "inspect" && "$*" == *"{{.Config.Image}}"* ]]; then
  printf 'old-image\\n'
elif [[ "$1" == "inspect" && "$*" == *"{{range .Config.Env}}"* ]]; then
  cat <<ENV
DATABASE_URL=postgresql://configured
TELEGRAM_BOT_TOKEN=telegram-secret
TELEGRAM_CHANNEL_ID=\${MOCK_RUNTIME_CHANNEL_ID:-@channel}
OPENAI_API_KEY=openai-secret
GEMINI_API_KEY=gemini-secret
EXA_API_KEY=exa-secret
NOTION_API_KEY=notion-secret
NOTION_AGENT_RUNS_DATA_SOURCE_ID=runs-id
NOTION_PIPELINE_AGENT_PAGE_ID=agent-id
ENV
elif [[ "$1" == "inspect" && "$*" == *"db-id"* ]]; then
  printf 'healthy\\n'
elif [[ "$1" == "inspect" && "$*" == *"{{.State.Running}}"* ]]; then
  printf '%s\\n' "\${MOCK_BOT_RUNNING:-false}"
elif [[ "$1" == "inspect" && "$*" == *"{{.RestartCount}}"* ]]; then
  printf '0\n'
elif [[ "$1" == "inspect" && "$*" == *"State.Health"* ]]; then
  if [[ -n "\${MOCK_BOT_HEALTH_AFTER:-}" ]]; then
    count=0
    [[ -f "\$MOCK_HEALTH_COUNTER" ]] && count="\$(cat "\$MOCK_HEALTH_COUNTER")"
    count=\$((count + 1))
    printf '%s' "\$count" > "\$MOCK_HEALTH_COUNTER"
    if (( count > \${MOCK_BOT_HEALTH_STARTING_FOR:-0} )); then
      printf '%s\n' "\$MOCK_BOT_HEALTH_AFTER"
    else
      printf 'starting\n'
    fi
  else
    printf '%s\n' "\${MOCK_BOT_HEALTH:-healthy}"
  fi
elif [[ "$1" == "exec" ]]; then
  cat >/dev/null
elif [[ "$1" == "compose" && "$*" == *" ps -q bot"* ]]; then
  printf 'bot-id\\n'
elif [[ "$1" == "compose" && "$*" == *" ps -q db"* ]]; then
  printf 'db-id\\n'
fi
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    path.join(bin, "sha256sum"),
    `#!/usr/bin/env bash
if [[ -x /usr/bin/sha256sum ]]; then
  exec /usr/bin/sha256sum "$@"
fi
exec /usr/bin/shasum -a 256 "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "install"),
    `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ "\${MOCK_INSTALL_FAIL_ROLLBACK:-false}" == "true" && "$destination" == *.env.production.rollback.write.* ]]; then
  exit 73
fi
exec /usr/bin/install "$@"
`,
    { mode: 0o755 },
  );

  const result = spawnSync(path.join(ops, "deploy.sh"), ["new-image"], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_DOCKER_LOG: dockerLog,
      MOCK_INSTALL_FAIL_ROLLBACK: String(failRollbackInstall),
      MOCK_BOT_RUNNING: String(botRunning),
      MOCK_BOT_HEALTH: botHealth,
      MOCK_BOT_HEALTH_AFTER: healthAfterStarting ?? "",
      MOCK_BOT_HEALTH_STARTING_FOR: String(startingChecks),
      MOCK_HEALTH_COUNTER: path.join(fixture, "health-counter"),
      // Production waits up to five minutes for a runtime that needs two to
      // become healthy. The test does not need to.
      DEPLOY_HEALTH_POLL_SECONDS: "0",
      DEPLOY_HEALTH_TIMEOUT_SECONDS: String(healthTimeoutSeconds),
      MOCK_RUNTIME_CHANNEL_ID: runtimePlaceholder ? "placeholder" : "@channel",
      MOCK_NOTIFICATION_LOG: notificationLog,
    },
  });

  return { dockerLog, fixture, notificationLog, result };
}

test("first SOPS deploy accepts legacy active env and restores it after health failure", () => {
  const oldEnvironment = legacyEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { dockerLog, fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /New bot container failed its health gate/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);
  assert.equal(readFileSync(path.join(fixture, ".env.production.rollback"), "utf8"), oldEnvironment);
  assert.equal(existsSync(path.join(fixture, ".env.production.incoming")), false);

  const log = readFileSync(dockerLog, "utf8");
  assert.match(log, /old-image\|compose .* up -d db/);
  assert.match(log, /old-image\|compose .* exec -T db \/docker-entrypoint-initdb\.d\/00-create-app-role\.sh/);
  assert.match(log, /old-image\|compose .* up -d --force-recreate --no-deps bot/);
});

test("a running container that is unhealthy is rolled back, not accepted", () => {
  // The gate this test exists for. Until it read health, the release condition
  // was three consecutive passes of "the process exists" -- which the typed
  // runtime satisfies while holding no poller lease and serving nothing. The
  // container here is running and has never restarted; only the probe says no.
  const oldEnvironment = legacyEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { dockerLog, fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    botHealth: "unhealthy",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /New bot container failed its health gate/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);

  const log = readFileSync(dockerLog, "utf8");
  assert.match(log, /old-image\|compose .* up -d --force-recreate --no-deps bot/);
});

test("a container that is still starting is waited out, not refused", () => {
  // The regression this test exists for, and it was merged before it was
  // caught. The old loop gave 30 seconds, which was fine when the gate asked
  // only whether the process existed. Asking about health, 30 seconds is less
  // than the healthcheck's own start period -- so the gate could never see
  // "healthy", and every production deploy would have failed and rolled back.
  //
  // The container here reports "starting" for the first three checks, exactly
  // as docker does before a start period elapses, and healthy after.
  const oldEnvironment = completeEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    healthAfterStarting: "healthy",
    startingChecks: 3,
    healthTimeoutSeconds: 30,
  });

  assert.equal(
    result.status,
    0,
    `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  // Only the two facts this test is about. Whether the environment file is
  // promoted is a different rule with its own tests, and asserting it here
  // would tie a timing test to semantics it does not exercise.
  assert.match(result.stdout, /Deployment healthy/);
});

test("a container that never leaves starting is rolled back, with the reason", () => {
  // The other side of the same rule: waiting is bounded. A runtime that never
  // becomes healthy must still be rolled back, and the message has to say what
  // the gate was looking at rather than "failed its health gate".
  const oldEnvironment = legacyEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    botHealth: "starting",
    healthTimeoutSeconds: 2,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed its health gate: .*health is starting/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);
});

test("a container whose healthcheck was lost is refused rather than waved through", () => {
  // compose.yaml declares a healthcheck for the bot on both runtimes, so a
  // container reporting none means the definition was lost -- and accepting it
  // would silently return the gate to what it was.
  const oldEnvironment = legacyEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    botHealth: "none",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /New bot container failed its health gate/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);
});

test("equal hashes do not rewrite active env or rollback backup", () => {
  const environment = completeEnvironment("same-app-secret");
  const staleRollback = "previous-rollback-sentinel\n";
  const { dockerLog, fixture, result } = runDeployment({
    active: environment,
    incoming: environment,
    rollback: staleRollback,
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), environment);
  assert.equal(readFileSync(path.join(fixture, ".env.production.rollback"), "utf8"), staleRollback);
  assert.equal(existsSync(path.join(fixture, ".env.production.incoming")), false);

  const log = readFileSync(dockerLog, "utf8");
  assert.doesNotMatch(log, /old-image\|compose .* up -d db/);
  assert.match(log, /old-image\|compose .* up -d --force-recreate --no-deps bot/);
});

test("rollback-backup failure leaves active env and stale backup untouched", () => {
  const oldEnvironment = completeEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const staleRollback = "stale-rollback-sentinel\n";
  const { dockerLog, fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    rollback: staleRollback,
    failRollbackInstall: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active production is unchanged/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);
  assert.equal(readFileSync(path.join(fixture, ".env.production.rollback"), "utf8"), staleRollback);
  assert.equal(readFileSync(path.join(fixture, ".env.production.incoming"), "utf8"), newEnvironment);

  const log = readFileSync(dockerLog, "utf8");
  assert.doesNotMatch(log, / up -d db/);
  assert.doesNotMatch(log, /force-recreate/);
});

test("runtime credential failure restores the previous environment and image", () => {
  const oldEnvironment = completeEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { fixture, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    runtimePlaceholder: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime credential gate/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), oldEnvironment);
  assert.equal(readFileSync(path.join(fixture, ".env.production.rollback"), "utf8"), oldEnvironment);
});

test("notification failure preserves a healthy release and passes immutable version to the bot", () => {
  const oldEnvironment = completeEnvironment("old-app-secret");
  const newEnvironment = completeEnvironment("new-app-secret");
  const { dockerLog, fixture, notificationLog, result } = runDeployment({
    active: oldEnvironment,
    incoming: newEnvironment,
    botRunning: true,
    notificationFails: true,
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /healthy release was not rolled back/);
  assert.equal(readFileSync(path.join(fixture, ".env.production"), "utf8"), newEnvironment);
  assert.equal(readFileSync(path.join(fixture, ".env.production.rollback"), "utf8"), oldEnvironment);
  assert.equal(readFileSync(notificationLog, "utf8"), "bot-id|new-image\n");

  const log = readFileSync(dockerLog, "utf8");
  assert.match(log, /new-image\|compose .* up -d --no-deps bot/);
  assert.match(log, /APP_VERSION=v0\.1\.0\+new-ima/);
  assert.doesNotMatch(log, /old-image\|compose .*force-recreate/);
});
