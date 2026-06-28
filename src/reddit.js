import * as cheerio from "cheerio";
import { fetchFeed } from "./feed.js";

function isRedditHost(hostname) {
  return hostname === "reddit.com" || hostname.endsWith(".reddit.com");
}

export function extractRedditOutboundUrls(summary) {
  const $ = cheerio.load(summary ?? "");
  const urls = new Set();

  $("a[href]").each((_index, element) => {
    try {
      const url = new URL($(element).attr("href"));
      if (["http:", "https:"].includes(url.protocol) && !isRedditHost(url.hostname)) {
        url.hash = "";
        urls.add(url.toString());
      }
    } catch {
      // Ignore malformed links from user-authored content.
    }
  });

  return [...urls];
}

export async function fetchRedditDiscoveries(feedUrl, options) {
  const entries = await fetchFeed(feedUrl, options);

  return entries.flatMap((entry) =>
    extractRedditOutboundUrls(entry.summary).map((canonicalUrl) => ({
      ...entry,
      canonicalUrl,
      discoveryUrl: entry.canonicalUrl,
      discoveryKind: "reddit",
    })),
  );
}
