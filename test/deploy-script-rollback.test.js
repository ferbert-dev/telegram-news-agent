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
    "TELEGRAM_CHANNEL_ID=@channel",
    "TELEGRAM_UPDATE_MODE=polling",
    "AI_PROVIDER_ORDER=exa,openai,gemini",
    "EXA_ENABLED=true",
    "OPENAI_API_KEY=openai-secret",
    "EXA_API_KEY=exa-secret",
    "GEMINI_API_KEY=gemini-secret",
    "NOTION_API_KEY=notion-secret",
    "NOTION_AGENT_RUNS_DATA_SOURCE_ID=runs-id",
    "NOTION_PIPELINE_AGENT_PAGE_ID=agent-id",
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
}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "deploy-rollback-"));
  const ops = path.join(fixture, "ops");
  const bin = path.join(fixture, "bin");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin, { recursive: true });

  cpSync("ops/deploy.sh", path.join(ops, "deploy.sh"));
  cpSync("ops/validate-production-env.sh", path.join(ops, "validate-production-env.sh"));
  cpSync("ops/verify-production-runtime.sh", path.join(ops, "verify-production-runtime.sh"));
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
      MOCK_RUNTIME_CHANNEL_ID: runtimePlaceholder ? "placeholder" : "@channel",
    },
  });

  return { dockerLog, fixture, result };
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
