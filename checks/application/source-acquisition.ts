import assert from "node:assert/strict";
import test from "node:test";

import { SourceAcquisitionGateway } from "../../src/research/source-acquisition.gateway.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Story</title><link>https://publisher.test/a?utm_source=x&amp;b=2&amp;a=1</link><description>Summary</description></item></channel></rss>`;
const dns = { async lookup() { return [{ address: "93.184.216.34", family: 4 as const }]; } };
function service(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const catalog = {
    async claimSourceDiscovery(key: string) { calls.push(["claim", key]); return true; },
    async completeSourceDiscovery(input: unknown) { calls.push(["complete", input]); return true; },
    async upsertDiscoveredSource(input: unknown) { calls.push(["upsert", input]); return { id:"source-1", name:"Publisher", homepage_url:null, feed_url:"https://publisher.test/feed.xml", source_type:"rss", reliability_score:65, enabled:true, last_checked_at:null, created_at:"x", updated_at:"x", is_primary:false, last_success_at:null, last_failed_at:null, consecutive_failures:0, last_error_code:null, disabled_until:null, discovered_by:"openai", discovery_metadata:{} }; },
    async markSourceFetchSuccess(id: string) { calls.push(["success", id]); return {} as never; },
    async markSourceFetchFailure(id: string, code: string) { calls.push(["failure", id, code]); return {} as never; },
  };
  const usage = { async recordAiUsage(input: unknown) { calls.push(["usage", input]); if (overrides.usageFailure) throw overrides.usageFailure; return {} as never; } };
  const transport = (overrides.transport as never) ?? { async fetch(url: URL) { calls.push(["fetch", url.toString()]); return new Response(RSS, { status:200 }); } };
  const clock = { now: () => new Date("2026-08-22T10:00:00.000Z"), async sleep(delayMs: number) { calls.push(["sleep", delayMs]); } };
  return { calls, value: new SourceAcquisitionGateway(catalog as never, usage as never, transport, dns, clock, (overrides.provider as never) ?? null) };
}

test("typed acquisition preserves feed normalization and blocks hostile redirect DNS", async () => {
  const { value } = service();
  const [entry] = await value.fetchFeed("https://publisher.test/feed.xml");
  assert.equal(entry.canonicalUrl, "https://publisher.test/a?a=1&b=2");

  const hostile = new SourceAcquisitionGateway({} as never, {} as never, { async fetch() { return new Response(null, { status:302, headers:{ location:"https://private.test/x" } }); } }, { async lookup(hostname: string) { return [{ address: hostname === "private.test" ? "127.0.0.1" : "93.184.216.34", family:4 as const }]; } }, { now: () => new Date(), async sleep() {} }, null);
  await assert.rejects(hostile.fetchFeed("https://publisher.test/feed.xml"), /not allowed/);

  const mapped = new SourceAcquisitionGateway({} as never, {} as never, { async fetch() { throw new Error("network must not be reached"); } }, { async lookup() { return [{ address:"::ffff:7f00:1", family:6 as const }]; } }, { now: () => new Date(), async sleep() {} }, null);
  await assert.rejects(mapped.fetchFeed("https://publisher.test/feed.xml"), /not allowed/);
});

test("typed source health retries and preserves success/failure error identity", async () => {
  const success = service();
  assert.equal((await success.value.fetchSourceFeed({ sourceId:"source-1", feedUrl:"https://publisher.test/feed.xml" })).length, 1);
  assert.deepEqual(success.calls.at(-1), ["success", "source-1"]);

  const failure = new Error("Feed request failed with HTTP 503");
  const failed = service({ transport: { async fetch() { return new Response("down", { status:503 }); } } });
  await assert.rejects(
    failed.value.fetchSourceFeed({ sourceId:"source-2", feedUrl:"https://publisher.test/feed.xml" }),
    (error) => error instanceof Error && error.message === failure.message,
  );
  assert.deepEqual(failed.calls.filter((call) => (call as unknown[])[0] === "sleep"), [["sleep", 300], ["sleep", 600]]);
  assert.deepEqual(failed.calls.at(-1), ["failure", "source-2", "http_503"]);

  const reddit = service({ transport: { async fetch() { return new Response(RSS, { status:200 }); } } });
  await reddit.value.fetchSource({ sourceId:"source-3", sourceType:"reddit", feedUrl:"https://publisher.test/feed.xml" });
  assert.deepEqual(reddit.calls.at(-1), ["success", "source-3"]);
});

test("typed news discovery normalizes provider output, rejects unsafe literals, and keeps usage best effort", async () => {
  const provider = {
    async searchNews(input: unknown) {
      assert.deepEqual(input, { query:"science", windowHours:48, limit:8, languageCode:"en", topicCodes:["science"] });
      return { provider:"exa" as const, model:"exa-test", usageEvents:[{ provider:"exa", model:"exa-test", operation:"news_search" }], items:[
        { title:"Discovery", url:"https://publisher.test/story?utm_source=x", summary:"Summary", publishedAt:"2026-08-22T09:00:00Z" },
        { title:"Unsafe", url:"http://127.0.0.1/private", summary:"No" },
      ] };
    },
  };
  const { value, calls } = service({ provider, usageFailure:new Error("telemetry unavailable") });
  const result = await value.searchNews({ query:"science", windowHours:48, languageCode:"en", topicCodes:["science"], channelId:"channel-1", searchRunId:"run-1" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].canonicalUrl, "https://publisher.test/story");
  assert.equal(result.items[0].discoveryKind, "exa_web_search");
  const usageCall = calls.find((call) => (call as [string, unknown])[0] === "usage");
  const usageInput = (usageCall as [string, unknown] | undefined)?.[1] as { searchRunId?: string | null };
  assert.equal(usageInput?.searchRunId, "run-1");
});

test("typed feed discovery claims before provider use, records usage, validates before upsert, and completes once", async () => {
  const provider = { async searchFeeds() { return { provider:"openai" as const, model:"test", usageEvents:[{ provider:"openai", model:"test", operation:"feed_source_search" }], items:[{ name:"Publisher", feedUrl:"https://publisher.test/feed.xml" }] }; } };
  const { value, calls } = service({ provider });
  const result = await value.discoverFeeds({ newsSettings:{ topicCodes:["science"] }, searchRunId:"run-1" });
  assert.equal(result.status, "completed");
  assert.equal(result.sources.length, 1);
  assert.deepEqual((calls as Array<[string]>).map(([name]) => name), ["claim", "usage", "fetch", "upsert", "complete"]);
  assert.equal(((calls.find((call) => (call as unknown[])[0] === "upsert") as unknown[])[1] as { discoveryMetadata: { discovered_at: string } }).discoveryMetadata.discovered_at, "2026-08-22T10:00:00.000Z");
});
