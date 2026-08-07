import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuietHoursAt,
  QUIET_HOURS_LABEL,
  shouldDeferScheduledNews,
} from "../src/quiet-hours.js";

test("night pause uses the Europe/Madrid summer boundaries", () => {
  assert.equal(QUIET_HOURS_LABEL, "22:00–08:00 Europe/Madrid");
  assert.equal(isQuietHoursAt("2026-08-07T19:59:59.000Z"), false);
  assert.equal(isQuietHoursAt("2026-08-07T20:00:00.000Z"), true);
  assert.equal(isQuietHoursAt("2026-08-08T05:59:59.000Z"), true);
  assert.equal(isQuietHoursAt("2026-08-08T06:00:00.000Z"), false);
});

test("night pause follows Europe/Madrid daylight-saving changes", () => {
  assert.equal(isQuietHoursAt("2026-01-15T20:59:59.000Z"), false);
  assert.equal(isQuietHoursAt("2026-01-15T21:00:00.000Z"), true);
  assert.equal(isQuietHoursAt("2026-01-16T06:59:59.000Z"), true);
  assert.equal(isQuietHoursAt("2026-01-16T07:00:00.000Z"), false);
});

test("disabled night pause never defers scheduled work", () => {
  assert.equal(
    shouldDeferScheduledNews(
      { quietHoursEnabled: false },
      "2026-08-07T20:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    shouldDeferScheduledNews(
      { quietHoursEnabled: true },
      "2026-08-07T20:00:00.000Z",
    ),
    true,
  );
});

test("invalid timestamps are rejected", () => {
  assert.throws(() => isQuietHoursAt("not-a-date"), /valid timestamp/i);
});
