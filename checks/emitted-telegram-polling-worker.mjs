import assert from "node:assert/strict";

const worker = await import("../dist/telegram/telegram-polling-worker.js");

assert.equal(worker.TELEGRAM_CONTROL_POLLER_LEASE_NAME, "telegram-control-poller");
assert.equal(worker.TELEGRAM_CONTROL_POLLER_LEASE_TTL_SECONDS, 60);
assert.equal(worker.TELEGRAM_CONTROL_POLLER_HEARTBEAT_INTERVAL_MS, 20_000);
assert.equal(worker.TELEGRAM_CONTROL_POLLER_ACQUIRE_TIMEOUT_MS, 70_000);
assert.equal(typeof worker.pollTelegramUpdates, "function");
assert.equal(typeof worker.TelegramPollingWorker, "function");
