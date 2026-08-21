import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runVerifier({ placeholder = false, telegramOk = true } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "runtime-verifier-"));
  const bin = path.join(fixture, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "inspect" ]]; then
  cat <<'ENV'
DATABASE_URL=postgresql://configured
TELEGRAM_BOT_TOKEN=telegram-secret
TELEGRAM_CHANNEL_ID=${placeholder ? "placeholder" : "@channel"}
OPENAI_API_KEY=openai-secret
GEMINI_API_KEY=gemini-secret
EXA_API_KEY=exa-secret
NOTION_API_KEY=notion-secret
NOTION_AGENT_RUNS_DATA_SOURCE_ID=runs-id
NOTION_PIPELINE_AGENT_PAGE_ID=agent-id
ENV
elif [[ "$1" == "exec" ]]; then
  cat >/dev/null
  echo "TelegramProbe mocked=true"
  [[ "${telegramOk}" == "true" ]]
fi
`,
    { mode: 0o755 },
  );

  return spawnSync("ops/verify-production-runtime.sh", ["bot-id"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("runtime verifier accepts complete credentials and successful Telegram probes", () => {
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production runtime credentials verified/);
});

test("runtime verifier rejects a placeholder without printing its value", () => {
  const result = runVerifier({ placeholder: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /TELEGRAM_CHANNEL_ID=placeholder/);
  assert.doesNotMatch(result.stdout + result.stderr, /@channel/);
});

test("runtime verifier rejects failed Telegram authentication or channel access", () => {
  const result = runVerifier({ telegramOk: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime credential verification failed/);
});
