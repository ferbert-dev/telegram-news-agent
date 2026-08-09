import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { SourcesRepository } from "../src/database/repositories/sources-repository.js";

test("source health and discovery mutations keep atomic PostgreSQL functions", async () => {
  const calls: [string, unknown[]][] = [];
  const pool = {
    async query(text: string, parameters: unknown[]) {
      calls.push([text, parameters]);
      if (text.includes("claim_source_discovery")) {
        return { rows: [{ value: true }] };
      }
      if (text.includes("complete_source_discovery")) {
        return { rows: [{ value: true }] };
      }
      return { rows: [{ id: "source-1" }] };
    },
  } as unknown as Pool;
  const repository = new SourcesRepository(pool);

  await repository.markSourceFetchSuccess("source-1");
  await repository.markSourceFetchFailure("source-1", "http_503");
  assert.equal(await repository.claimSourceDiscovery("a".repeat(64)), true);
  assert.equal(
    await repository.completeSourceDiscovery({
      topicKey: "a".repeat(64),
      provider: "openai",
      model: "model-1",
      resultCount: 2,
    }),
    true,
  );
  await repository.upsertDiscoveredSource({
    name: "Discovered source",
    homepageUrl: "https://example.com",
    feedUrl: "https://example.com/feed.xml",
    discoveredBy: "openai",
    topicCodes: ["science"],
  });

  assert.deepEqual(calls, [
    ["select * from public.mark_source_fetch_success($1)", ["source-1"]],
    [
      "select * from public.mark_source_fetch_failure($1, $2)",
      ["source-1", "http_503"],
    ],
    ["select public.claim_source_discovery($1) as value", ["a".repeat(64)]],
    [
      "select public.complete_source_discovery($1, $2, $3, $4, $5) as value",
      ["a".repeat(64), "openai", "model-1", 2, null],
    ],
    [
      "select * from public.upsert_discovered_source($1, $2, $3, $4, $5, $6, $7)",
      [
        "Discovered source",
        "https://example.com",
        "https://example.com/feed.xml",
        65,
        ["science"],
        "openai",
        {},
      ],
    ],
  ]);
});

test("source function failures are wrapped with an operation boundary", async () => {
  const pool = {
    async query() {
      throw new Error("database unavailable");
    },
  } as unknown as Pool;
  const repository = new SourcesRepository(pool);

  await assert.rejects(
    repository.markSourceFetchSuccess("source-1"),
    /Mark source fetch success failed: database unavailable/,
  );
});
