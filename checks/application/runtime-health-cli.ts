import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { expectedIdentity, runHealthCli } from "../../src/composition/health-cli.js";

test("the probe fails closed when the runtime cannot be identified", async () => {
  // Skipping the identity comparison on a missing channel would drop the guard
  // in exactly the misconfigured case where two runtimes share the default
  // readiness path -- and the probe would then confirm the neighbour's lease
  // and report the wrong runtime healthy. It returns before creating a Nest
  // context at all, so a misconfigured probe never opens a pool either.
  for (const env of [{}, { TELEGRAM_CHANNEL_ID: "" }, { TELEGRAM_CHANNEL_ID: "   " }]) {
    const result = await runHealthCli(undefined, env as NodeJS.ProcessEnv);
    assert.equal(result.healthy, false);
    assert.match(result.reason ?? "", /TELEGRAM_CHANNEL_ID/);
  }
});

test("the expected channel is trimmed to match what the runtime actually wrote", () => {
  // getTelegramConfig trims before the runtime records the channel, so an
  // untrimmed expectation would report "belongs to channel @news, not @news "
  // -- a mismatch nobody can see, failing every probe on a working bot.
  assert.equal(expectedIdentity({ TELEGRAM_CHANNEL_ID: "@news " })?.channelId, "@news");
  assert.equal(expectedIdentity({ TELEGRAM_CHANNEL_ID: "@news\r\n" })?.channelId, "@news");
  assert.equal(expectedIdentity({ TELEGRAM_CHANNEL_ID: "  " }), null);
  assert.equal(expectedIdentity({}), null);
});

test("the probe requires polling mode and the full worker set, not just an identity", () => {
  // A runtime that came up without its scheduler, or in some other update mode,
  // must not be reported healthy just because the channel matches.
  const expected = expectedIdentity({ TELEGRAM_CHANNEL_ID: "@news" });
  assert.ok(expected);
  assert.equal(expected.updateMode, "polling");
  assert.deepEqual([...expected.startedWorkers], ["telegram-polling", "news-scheduler"]);
});
