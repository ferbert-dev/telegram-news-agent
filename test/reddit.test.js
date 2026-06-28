import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRedditOutboundUrls,
  fetchRedditDiscoveries,
} from "../src/reddit.js";

test("extractRedditOutboundUrls excludes Reddit links and malformed URLs", () => {
  assert.deepEqual(
    extractRedditOutboundUrls(`
      <a href="https://openai.com/news/example#details">source</a>
      <a href="https://www.reddit.com/r/test/comments/1">comments</a>
      <a href="not a url">broken</a>
    `),
    ["https://openai.com/news/example"],
  );
});

test("fetchRedditDiscoveries emits only outbound links with discovery provenance", async () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Release discussion</title>
        <link href="https://www.reddit.com/r/test/comments/abc/release/" />
        <published>2026-06-28T12:00:00Z</published>
        <content type="html">&lt;a href="https://openai.com/news/release"&gt;source&lt;/a&gt;</content>
      </entry>
    </feed>`;
  const discoveries = await fetchRedditDiscoveries(
    "https://www.reddit.com/r/test/new/.rss",
    {
      lookupImpl: async () => [{ address: "151.101.1.140", family: 4 }],
      fetchImpl: async () =>
        new Response(xml, {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        }),
    },
  );

  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].canonicalUrl, "https://openai.com/news/release");
  assert.match(discoveries[0].discoveryUrl, /reddit\.com/);
  assert.equal(discoveries[0].discoveryKind, "reddit");
});
