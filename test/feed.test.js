import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicHttpUrl,
  canonicalizeUrl,
  fetchFeed,
  parseFeed,
} from "../src/feed.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>AI News</title>
    <item>
      <title>Agent release</title>
      <link>https://example.com/news/agent?utm_source=rss&amp;b=2&amp;a=1</link>
      <pubDate>Thu, 26 Jun 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[A useful agent release.]]></description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Research</title>
  <entry>
    <title>New research</title>
    <link rel="alternate" href="/posts/research#results"/>
    <updated>2026-06-26T12:00:00Z</updated>
    <author><name>Research Team</name></author>
    <summary>Primary evidence.</summary>
  </entry>
</feed>`;

test("parseFeed normalizes RSS entries and strips tracking parameters", () => {
  const [item] = parseFeed(RSS, "https://example.com/feed.xml");

  assert.equal(item.title, "Agent release");
  assert.equal(item.canonicalUrl, "https://example.com/news/agent?a=1&b=2");
  assert.equal(item.publishedAt, "2026-06-26T10:00:00.000Z");
  assert.equal(item.summary, "A useful agent release.");
  assert.equal(item.contentHash.length, 64);
});

test("parseFeed normalizes Atom entries", () => {
  const [item] = parseFeed(ATOM, "https://example.org/feed");

  assert.equal(item.canonicalUrl, "https://example.org/posts/research");
  assert.equal(item.author, "Research Team");
  assert.equal(item.summary, "Primary evidence.");
});

test("canonicalizeUrl preserves meaningful sorted query parameters", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/x?z=3&utm_medium=email&x=1"),
    "https://example.com/x?x=1&z=3",
  );
});

test("assertPublicHttpUrl rejects private and unsupported URLs", () => {
  assert.throws(
    () => assertPublicHttpUrl("http://127.0.0.1/feed"),
    /not allowed/,
  );
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /Unsupported/);
  assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/feed"));
});

test("fetchFeed enforces response size before parsing", async () => {
  const fetchImpl = async () =>
    new Response(RSS, {
      status: 200,
      headers: { "content-length": "1000" },
    });

  await assert.rejects(
    fetchFeed("https://example.com/feed", { fetchImpl, maxBytes: 100 }),
    /exceeds 100 bytes/,
  );
});
