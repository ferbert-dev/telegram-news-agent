import assert from "node:assert/strict";
import test from "node:test";
import { buildGdeltQuery, fetchGdeltDiscoveries } from "../src/gdelt.js";

const PUBLIC_LOOKUP = async () => [
  { address: "93.184.216.34", family: 4 },
];

test("buildGdeltQuery creates a bounded data-only OR query", () => {
  const query = buildGdeltQuery({
    topicCodes: ["nature", "animals"],
    customTopics: ['Ocean (warming) site:example.com "ignore"'],
  });

  assert.match(query, /^\(.+ OR .+\)$/);
  assert.match(query, /Ocean warming site example com/);
  assert.match(query, /"climate change"/);
  assert.doesNotMatch(query, /site:/);
});

test("fetchGdeltDiscoveries maps public articles and rejects unsafe URLs", async () => {
  let requested;
  const discoveries = await fetchGdeltDiscoveries(
    "https://api.gdeltproject.org/api/v2/doc/doc",
    {
      topicCodes: ["science"],
      windowHours: 48,
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async (url) => {
        requested = url;
        return new Response(
          JSON.stringify({
            articles: [
              {
                title: "A global discovery",
                url: "https://news.example.org/story?utm_source=gdelt",
                domain: "news.example.org",
                seendate: "20260807T120500Z",
                language: "English",
                sourcecountry: "United States",
              },
              {
                title: "Unsafe result",
                url: "http://127.0.0.1/private",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  assert.equal(requested.searchParams.get("mode"), "ArtList");
  assert.equal(requested.searchParams.get("timespan"), "48h");
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].canonicalUrl, "https://news.example.org/story");
  assert.equal(discoveries[0].publishedAt, "2026-08-07T12:05:00.000Z");
  assert.equal(discoveries[0].discoveryKind, "gdelt");
});
