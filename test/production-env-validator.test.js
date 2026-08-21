import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const validator = path.join(root, "ops", "validate-production-env.sh");

function baseLines() {
  return [
    "POSTGRES_PASSWORD=postgres-secret",
    "POSTGRES_APP_PASSWORD=app-secret",
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
    "EXA_API_KEY=exa-secret",
    "OPENAI_API_KEY=openai-secret",
    "OPENAI_MODEL=gpt-5.4-2026-03-05",
    "OPENAI_REASONING_EFFORT=medium",
    "GEMINI_API_KEY=gemini-secret",
    "GEMINI_MODEL=gemini-2.5-flash",
    "NOTION_API_KEY=notion-secret",
    "NOTION_AGENT_RUNS_DATA_SOURCE_ID=runs-id",
    "NOTION_PIPELINE_AGENT_PAGE_ID=agent-id",
    "NOTION_PIPELINE_TICKET_PAGE_ID=",
  ];
}

function fixture(lines) {
  const directory = mkdtempSync(path.join(tmpdir(), "production-env-validator-"));
  const file = path.join(directory, "production.env");
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

test("accepts a complete encrypted production base", () => {
  const output = execFileSync(validator, ["--base", fixture(baseLines())], {
    encoding: "utf8",
  });
  assert.match(output, /validation passed \(base\)/);
});

test("requires every provider key in the encrypted production base", () => {
  const file = fixture(
    baseLines().filter((line) => !line.startsWith("EXA_API_KEY=")),
  );
  const result = spawnSync(validator, ["--complete", file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXA_API_KEY is missing/);
});

test("rejects duplicate variables without printing their values", () => {
  const file = fixture([...baseLines(), "TELEGRAM_CHANNEL_ID=@other"]);
  const result = spawnSync(validator, ["--base", file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TELEGRAM_CHANNEL_ID/);
  assert.doesNotMatch(result.stderr, /@other/);
});

test("rejects production placeholders without printing their values", () => {
  const file = fixture(
    baseLines().map((line) =>
      line.startsWith("NOTION_API_KEY=")
        ? "NOTION_API_KEY=local-integration-placeholder"
        : line,
    ),
  );
  const result = spawnSync(validator, ["--base", file], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NOTION_API_KEY contains a forbidden production placeholder/);
  assert.doesNotMatch(result.stderr, /local-integration-placeholder/);
});

test("accepts the same complete file at the deployment gate", () => {
  const file = fixture(baseLines());
  const output = execFileSync(validator, ["--complete", file], {
    encoding: "utf8",
  });
  assert.match(output, /validation passed \(complete\)/);
});
