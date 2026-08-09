import assert from "node:assert/strict";
import test from "node:test";

import {
  mapSourceRow,
  type SourceDatabaseRow,
} from "../../src/database/repositories/sources-repository.js";

test("source mapper canonicalizes only named timestamps before legacy facade adaptation", () => {
  const metadata = {
    nested: {
      timestamp_like_value: "2026-08-09 12:34:56.123456+02",
    },
  };
  const raw = {
    id: "source-1",
    name: "Timestamp source",
    homepage_url: "https://example.com",
    feed_url: "https://example.com/feed.xml",
    source_type: "rss",
    reliability_score: 90,
    enabled: true,
    last_checked_at: "2026-08-09 12:34:56.123456+02",
    created_at: new Date("2026-08-09T10:34:56.123Z"),
    updated_at: "2026-08-09T10:34:56.123456Z",
    is_primary: true,
    last_success_at: new Date("2026-08-09T10:34:56.123Z"),
    last_failed_at: null,
    consecutive_failures: 0,
    last_error_code: null,
    disabled_until: "2026-08-09 13:34:56.123456+03",
    discovered_by: "manual",
    discovery_metadata: metadata,
    topic_codes: ["science"],
  } satisfies SourceDatabaseRow & { topic_codes: string[] };

  const mapped = mapSourceRow(raw);

  assert.equal(mapped.last_checked_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.created_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.updated_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.last_success_at, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.last_failed_at, null);
  assert.equal(mapped.disabled_until, "2026-08-09T10:34:56.123Z");
  assert.equal(mapped.discovery_metadata, metadata);
  assert.deepEqual(mapped.topic_codes, ["science"]);
  assert.equal(
    mapped.discovery_metadata.nested.timestamp_like_value,
    "2026-08-09 12:34:56.123456+02",
  );
});
