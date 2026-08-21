import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function validate(lines) {
  const fixture = mkdtempSync(path.join(tmpdir(), "production-cutover-"));
  const envFile = path.join(fixture, "legacy.env");
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return spawnSync("ops/validate-production-env.sh", ["--rollback-base", envFile], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("rollback base permits damaged optional integrations during first SOPS cutover", () => {
  const result = validate([
    "POSTGRES_PASSWORD=postgres-secret",
    "POSTGRES_APP_PASSWORD=app-secret",
    "TELEGRAM_BOT_TOKEN=telegram-secret",
    "TELEGRAM_CHANNEL_ID=placeholder",
    "GEMINI_API_KEY=placeholder",
    "NOTION_API_KEY=placeholder",
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test("rollback base still rejects placeholder database and bot credentials", () => {
  const result = validate([
    "POSTGRES_PASSWORD=placeholder",
    "POSTGRES_APP_PASSWORD=app-secret",
    "TELEGRAM_BOT_TOKEN=telegram-secret",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /POSTGRES_PASSWORD contains a forbidden production placeholder/);
  assert.doesNotMatch(result.stdout + result.stderr, /app-secret|telegram-secret/);
});
