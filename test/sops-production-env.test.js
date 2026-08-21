import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const recipient = "age1hu8sepn3kau25tzy98nwlny9yr267k4xpnjlxhf9ek4lwlqpeumqlk5jkr";
const requiredEncryptedKeys = [
  "POSTGRES_PASSWORD",
  "POSTGRES_APP_PASSWORD",
  "POSTGRES_SSH_TUNNEL_PORT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "TELEGRAM_UPDATE_MODE",
  "TELEGRAM_POLLING_MIGRATE_WEBHOOK",
  "TELEGRAM_NEWS_JOB_MODE",
  "APPROVAL_POLICY",
  "AI_PROVIDER_ORDER",
  "EXA_ENABLED",
  "EXA_SEARCH_TYPE",
  "EXA_DAILY_SEARCH_CAP",
  "EXA_MAX_RESULTS",
  "EXA_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_REASONING_EFFORT",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "NOTION_API_KEY",
  "NOTION_AGENT_RUNS_DATA_SOURCE_ID",
  "NOTION_PIPELINE_AGENT_PAGE_ID",
];

function dotenvEntries(contents) {
  return Object.fromEntries(
    contents
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test("committed production values are SOPS encrypted for the configured recipient", () => {
  const encrypted = readFileSync("secrets/production.env.sops", "utf8");
  const entries = dotenvEntries(encrypted);

  for (const key of requiredEncryptedKeys) {
    assert.match(entries[key] ?? "", /^ENC\[/, `${key} must be encrypted`);
  }

  assert.equal(entries.sops_age__list_0__map_recipient, recipient);
  assert.match(entries.sops_mac ?? "", /^ENC\[/);

  const config = readFileSync(".sops.yaml", "utf8");
  assert.match(config, new RegExp(recipient));
});

test("deployment consumes SOPS and no longer reads the multiline environment secret", () => {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  assert.match(workflow, /secrets\.SOPS_AGE_KEY/);
  assert.match(workflow, /secrets\/production\.env\.sops/);
  assert.doesNotMatch(workflow, /secrets\.PRODUCTION_ENV_FILE/);
  assert.doesNotMatch(workflow, /secrets\.OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /secrets\.EXA_API_KEY/);
  assert.match(workflow, /install -m 600 \/dev\/null .*production\.base\.env/);
  assert.match(
    workflow,
    /install -m 600 "\$RUNNER_TEMP\/production\.base\.env" "\$RUNNER_TEMP\/production\.env"/,
  );
  assert.match(workflow, /deployment\/\.env\.production\.incoming/);
  assert.match(workflow, /chmod 600 deployment\.tar\.gz/);
  assert.match(workflow, /trap 'rm -f "\$archive"' EXIT/);
  assert.match(workflow, /verify-production-db:/);
  assert.match(workflow, /inspect-production:/);
  assert.match(workflow, /inputs\.operation == 'verify-production-db'/);
  assert.match(workflow, /RuntimeEnv/);
  assert.match(workflow, /TelegramProbe/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /PostgreSQL superuser credential verified/);
  assert.match(workflow, /PostgreSQL application credential verified/);
  assert.match(workflow, /trap 'rm -f "\$candidate_env"' EXIT/);
  assert.match(workflow, /Remove Oracle credential probe plaintext/);
  assert.match(workflow, /rm -f -- '\$REMOTE_PROBE_ENV'/);
  assert.match(workflow, /runtime_env_ok=true/);
  assert.match(workflow, /telegram_ok=true/);
});

test("deploy rollback restores environment, database credential, and image", () => {
  const deploy = readFileSync("ops/deploy.sh", "utf8");
  assert.match(deploy, /rollback_env="\.env\.production\.rollback"/);
  assert.match(deploy, /active_hash="\$\(sha256sum "\$active_env"/);
  assert.match(deploy, /candidate_hash="\$\(sha256sum "\$candidate_env"/);
  assert.match(deploy, /if \[\[ "\$active_hash" == "\$candidate_hash" \]\]/);
  assert.match(deploy, /environment_promoted=false/);
  assert.match(deploy, /rollback_temp="\$\{rollback_env\}\.write\.\$\$"/);
  assert.match(deploy, /install -m 600 "\$active_env" "\$rollback_temp"/);
  assert.match(deploy, /mv -f "\$rollback_temp" "\$rollback_env"/);
  assert.match(deploy, /install -m 600 "\$rollback_env" "\$restore_temp"/);
  assert.match(deploy, /exec -T db[\s\\]+\/docker-entrypoint-initdb\.d\/00-create-app-role\.sh/);
  assert.match(deploy, /up -d --force-recreate --no-deps bot/);
  assert.match(deploy, /ops\/verify-production-runtime\.sh "\$container"/);
  assert.ok(
    deploy.indexOf('ops/verify-production-runtime.sh "$container"') <
      deploy.indexOf('echo "Deployment healthy: ${image}"'),
  );
});
